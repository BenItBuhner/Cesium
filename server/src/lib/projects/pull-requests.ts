import type {
  ProjectPullRequest,
  ProjectPullRequestListing,
  ProjectPullRequestReview,
} from "@cesium/core/projects";
import { isProjectEventDisplay, PROJECT_NOTICE_DISPLAY_PREFIX } from "@cesium/core/projects";
import { readConversationSnapshot } from "../agents/session-store.js";
import { ProjectError } from "./errors.js";
import {
  GithubApiError,
  projectGithubClient,
  summarizeCi,
  type GithubClient,
  type GithubPull,
  type GithubReview,
} from "./github/client.js";
import { mutateProject, readProject } from "./project-store.js";
import { readProjectSubscriptions } from "./subscriptions-store.js";
import type { ProjectChildRecord, ProjectRecord } from "./types.js";

const PR_TITLE_MAX_CHARS = 72;
const USER_QUOTE_LOOKBACK = 5;

/** The latest decision per reviewer: changes requested beats approval beats comments. */
export function aggregateReviews(reviews: readonly GithubReview[]): ProjectPullRequestReview | null {
  const latest = new Map<string, string>();
  for (const review of reviews) {
    const login = review.user?.login ?? `review-${review.id}`;
    const state = review.state?.toUpperCase();
    if (state === "PENDING" || state === "DISMISSED") {
      continue;
    }
    if (state === "COMMENTED" && latest.has(login)) {
      continue;
    }
    latest.set(login, state);
  }
  const states = [...latest.values()];
  if (states.includes("CHANGES_REQUESTED")) return "changes_requested";
  if (states.includes("APPROVED")) return "approved";
  if (states.includes("COMMENTED")) return "commented";
  return null;
}

export function toProjectPullRequest(
  repo: string,
  pull: GithubPull,
  previous: ProjectPullRequest | null,
  extras?: Partial<Pick<ProjectPullRequest, "ci" | "failedChecks" | "review" | "openedByProject">>
): ProjectPullRequest {
  const merged = pull.merged === true || Boolean(pull.merged_at);
  const headSha = pull.head?.sha ?? previous?.headSha ?? null;
  const headChanged = previous?.headSha != null && headSha !== previous.headSha;
  return {
    repo,
    number: pull.number,
    url: pull.html_url,
    title: pull.title,
    state: merged ? "merged" : pull.state === "closed" ? "closed" : "open",
    draft: pull.draft === true,
    headRef: pull.head?.ref ?? previous?.headRef ?? "",
    baseRef: pull.base?.ref ?? previous?.baseRef ?? "",
    headSha,
    // A new head invalidates the previous CI verdict.
    ci: extras?.ci !== undefined ? extras.ci : headChanged ? null : (previous?.ci ?? null),
    failedChecks: extras?.failedChecks ?? (headChanged ? [] : (previous?.failedChecks ?? [])),
    review: extras?.review !== undefined ? extras.review : (previous?.review ?? null),
    mergeable: typeof pull.mergeable === "boolean" ? pull.mergeable : (previous?.mergeable ?? null),
    openedByProject: extras?.openedByProject ?? previous?.openedByProject ?? false,
    updatedAt: pull.updated_at ? Date.parse(pull.updated_at) || Date.now() : Date.now(),
  };
}

export async function patchChildPullRequest(
  projectId: string,
  childId: string,
  update: (current: ProjectPullRequest | null) => ProjectPullRequest | null
): Promise<void> {
  await mutateProject(
    projectId,
    (record) => {
      let changed = false;
      const children = record.children.map((child) => {
        if (child.id !== childId) {
          return child;
        }
        const next = update(child.pr);
        if (JSON.stringify(next) === JSON.stringify(child.pr)) {
          return child;
        }
        changed = true;
        return { ...child, pr: next };
      });
      return changed ? { ...record, children } : record;
    },
    { touch: false }
  );
}

/**
 * The subject of the branch's first commit, as GitHub suggests; the agent's
 * task only when there are none (its first line is often a heading such as
 * "Repository: …").
 */
function prTitle(child: ProjectChildRecord, commitMessages: readonly string[]): string {
  const firstLine = (text: string) => text.split("\n").map((line) => line.trim()).find(Boolean);
  const title = (firstLine(commitMessages[0] ?? "") ?? firstLine(child.task ?? "") ?? child.name).replace(/\s+/g, " ");
  return title.length > PR_TITLE_MAX_CHARS ? `${title.slice(0, PR_TITLE_MAX_CHARS - 1)}…` : title;
}

function prBody(record: ProjectRecord, child: ProjectChildRecord): string {
  return [
    child.lastReplyPreview?.trim() || `Work by agent \`${child.name}\`.`,
    "",
    "---",
    `Opened by the Cesium Project "${record.name}" for agent \`${child.name}\` (branch \`${child.branch}\`), which pushed without opening one.`,
  ].join("\n");
}

export type TrackedPullRequest = { pr: ProjectPullRequest; created: boolean };

/**
 * Finds the pull request for a worker's branch, and opens one when the worker
 * pushed commits without it (`allowCreate`, the Project's autoCreatePr). The
 * result is recorded on the worker. Null when there is no branch, no GitHub
 * repo or credential, or nothing pushed yet.
 */
export async function trackWorkerPullRequest(
  projectId: string,
  childId: string,
  options?: { allowCreate?: boolean; client?: GithubClient | null }
): Promise<TrackedPullRequest | null> {
  const record = await readProject(projectId);
  const child = record?.children.find((entry) => entry.id === childId);
  if (!record || !child || child.deletedAt != null || !child.branch || !child.githubRepo) {
    return null;
  }
  const client = options?.client !== undefined ? options.client : await projectGithubClient();
  if (!client) {
    return null;
  }
  const repo = child.githubRepo;
  let pull: GithubPull | null =
    child.pr && child.pr.repo === repo ? await client.getPull(repo, child.pr.number) : await client.findPullByHead(repo, child.branch);
  let created = false;
  if (!pull && options?.allowCreate && record.settings.autoCreatePr) {
    const head = await client.getBranchHead(repo, child.branch);
    const base = child.baseRef?.replace(/^origin\//, "") || "main";
    const comparison = head ? await client.compare(repo, base, child.branch) : null;
    if (comparison && comparison.aheadBy > 0) {
      try {
        pull = await client.createPull(repo, {
          title: prTitle(child, comparison.commitMessages),
          head: child.branch,
          base,
          body: prBody(record, child),
          draft: record.settings.prMode === "draft",
        });
        created = true;
      } catch (error) {
        // A PR opened in the meantime (by the worker) wins.
        if (error instanceof GithubApiError && error.status === 422) {
          pull = await client.findPullByHead(repo, child.branch);
        } else {
          throw error;
        }
      }
    }
  }
  if (!pull) {
    return null;
  }
  const next = toProjectPullRequest(repo, pull, child.pr, created ? { openedByProject: true } : undefined);
  await patchChildPullRequest(projectId, childId, () => next);
  return { pr: next, created };
}

/** Every PR the Project tracks: workers' own plus PRs it follows on request. */
export async function listProjectPullRequests(projectId: string): Promise<ProjectPullRequestListing[]> {
  const record = await readProject(projectId);
  if (!record) {
    return [];
  }
  const listings: ProjectPullRequestListing[] = record.children
    .filter((child) => child.pr && child.deletedAt == null)
    .map((child) => ({ ...child.pr!, agent: child.name }));
  const seen = new Set(listings.map((pr) => `${pr.repo}#${pr.number}`));
  for (const subscription of await readProjectSubscriptions(projectId)) {
    if (subscription.spec.kind !== "github_pr" || subscription.childId) {
      continue;
    }
    const key = `${subscription.spec.repo}#${subscription.spec.number}`;
    const snapshot = subscription.state.pr;
    if (snapshot && !seen.has(key)) {
      seen.add(key);
      listings.push({ ...snapshot, agent: null });
    }
  }
  return listings.sort((a, b) => b.updatedAt - a.updatedAt);
}

function resolveListing(listings: readonly ProjectPullRequestListing[], ref: string): ProjectPullRequestListing {
  const trimmed = ref.trim();
  const urlMatch = trimmed.match(/\/([^/]+\/[^/]+)\/pull\/(\d+)/);
  const slugMatch = trimmed.match(/^([^/\s#]+\/[^/\s#]+)#(\d+)$/);
  const numberMatch = trimmed.match(/^#?(\d+)$/);
  const found = listings.find((pr) => {
    if (urlMatch) return pr.repo.toLowerCase() === urlMatch[1]!.toLowerCase() && pr.number === Number(urlMatch[2]);
    if (slugMatch) return pr.repo.toLowerCase() === slugMatch[1]!.toLowerCase() && pr.number === Number(slugMatch[2]);
    if (numberMatch) return pr.number === Number(numberMatch[1]);
    return pr.agent?.toLowerCase() === trimmed.toLowerCase();
  });
  if (!found) {
    const known = listings.map((pr) => `${pr.repo}#${pr.number}${pr.agent ? ` (${pr.agent})` : ""}`);
    throw new ProjectError(
      `No tracked pull request matches "${ref}".${known.length ? ` Tracked: ${known.join(", ")}.` : ""}`,
      404,
      "pr_not_found"
    );
  }
  return found;
}

function normalizeQuote(text: string): string {
  return text.toLowerCase().replace(/[\u2018\u2019]/g, "'").replace(/[\u201c\u201d]/g, '"').replace(/\s+/g, " ").trim();
}

/** The last few things the user actually typed to the orchestrator (not notices or events). */
async function recentUserMessages(record: ProjectRecord): Promise<string[]> {
  const snapshot = await readConversationSnapshot(
    record.orchestrator.workspaceId,
    record.orchestrator.conversationId
  ).catch(() => null);
  if (!snapshot) {
    return [];
  }
  return snapshot.events
    .filter(
      (event): event is Extract<typeof event, { kind: "user_message" }> =>
        event.kind === "user_message" &&
        !event.hidden &&
        !event.displayContent?.startsWith(PROJECT_NOTICE_DISPLAY_PREFIX) &&
        !isProjectEventDisplay(event.displayContent)
    )
    .slice(-USER_QUOTE_LOOKBACK)
    .map((event) => event.displayContent?.trim() || event.content);
}

export type MergeResult = { pr: ProjectPullRequestListing; sha: string | null };

/**
 * Squash-merges a tracked PR as `PR title (#N)`, keeping its branch. The
 * orchestrator may only merge under `when_green`, or with a quote of the
 * user's own go-ahead from their recent messages; the user merging from the UI
 * (`byUser`) needs neither. Every merge needs an open, ready, mergeable PR with
 * green CI (or none) and no outstanding request for changes.
 */
export async function mergeProjectPullRequest(
  projectId: string,
  input: { pr: string; userQuote?: string | null; byUser?: boolean }
): Promise<MergeResult> {
  const record = await readProject(projectId);
  if (!record) {
    throw new ProjectError(`Unknown project: ${projectId}`, 404, "project_not_found");
  }
  const listing = resolveListing(await listProjectPullRequests(projectId), input.pr ?? "");
  if (!input.byUser && record.settings.mergePolicy !== "when_green") {
    const quote = input.userQuote?.trim();
    if (!quote) {
      throw new ProjectError(
        "Merging needs the user's explicit go-ahead in this Project: ask them, then pass their words as user_quote.",
        403,
        "merge_not_authorized"
      );
    }
    const messages = (await recentUserMessages(record)).map(normalizeQuote);
    if (!messages.some((message) => message.includes(normalizeQuote(quote)))) {
      throw new ProjectError(
        "user_quote does not appear in the user's recent messages, so the merge is not authorized. Ask the user.",
        403,
        "merge_not_authorized"
      );
    }
  }
  const client = await projectGithubClient();
  if (!client) {
    throw new ProjectError("GitHub is not connected on this engine.", 409, "github_not_connected");
  }
  const pull = await client.getPull(listing.repo, listing.number);
  const merged = pull.merged === true || Boolean(pull.merged_at);
  if (merged || pull.state !== "open") {
    throw new ProjectError(`${listing.repo}#${listing.number} is already ${merged ? "merged" : "closed"}.`, 409);
  }
  if (pull.draft) {
    throw new ProjectError(`${listing.repo}#${listing.number} is a draft; mark it ready first.`, 409);
  }
  if (pull.mergeable === false) {
    throw new ProjectError(`${listing.repo}#${listing.number} has conflicts with its base branch.`, 409);
  }
  const [checkRuns, combined, reviews] = await Promise.all([
    client.listCheckRuns(listing.repo, pull.head.sha),
    client.getCombinedStatus(listing.repo, pull.head.sha).catch(() => null),
    client.listReviews(listing.repo, listing.number),
  ]);
  const ci = summarizeCi(checkRuns, combined);
  if (ci.state === "pending") {
    throw new ProjectError(`CI is still running on ${listing.repo}#${listing.number}.`, 409, "ci_pending");
  }
  if (ci.state === "failure") {
    throw new ProjectError(
      `CI failed on ${listing.repo}#${listing.number}: ${ci.failed.join(", ")}.`,
      409,
      "ci_failed"
    );
  }
  if (aggregateReviews(reviews) === "changes_requested") {
    throw new ProjectError(`A reviewer requested changes on ${listing.repo}#${listing.number}.`, 409, "changes_requested");
  }
  const result = await client.mergePull(listing.repo, listing.number, {
    mergeMethod: "squash",
    commitTitle: `${pull.title} (#${listing.number})`,
    sha: pull.head.sha,
  });
  if (!result.merged) {
    throw new ProjectError(result.message || `GitHub did not merge ${listing.repo}#${listing.number}.`, 409);
  }
  const mergedPr: ProjectPullRequest = {
    ...toProjectPullRequest(listing.repo, pull, listing, { ci: ci.state === "none" ? null : "success", failedChecks: [] }),
    state: "merged",
  };
  const owner = record.children.find(
    (child) => child.pr?.repo === listing.repo && child.pr.number === listing.number
  );
  if (owner) {
    await patchChildPullRequest(projectId, owner.id, () => mergedPr);
  }
  const { closeSubscriptionsForMergedPr } = await import("./listening.js");
  await closeSubscriptionsForMergedPr(projectId, listing.repo, listing.number, pull.head.ref, mergedPr);
  return { pr: { ...mergedPr, agent: listing.agent }, sha: result.sha ?? null };
}
