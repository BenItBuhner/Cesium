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
const CLOSED_PRS_KEPT = 50;

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
  const state = merged ? "merged" : pull.state === "closed" ? "closed" : "open";
  const headSha = pull.head?.sha ?? previous?.headSha ?? null;
  const headChanged = previous?.headSha != null && headSha !== previous.headSha;
  return {
    repo,
    number: pull.number,
    url: pull.html_url,
    title: pull.title,
    state,
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
    ...(state === "closed" && previous?.closedByProject ? { closedByProject: true } : {}),
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

function prKey(pr: Pick<ProjectPullRequest, "repo" | "number">): string {
  return `${pr.repo.toLowerCase()}#${pr.number}`;
}

/**
 * Every PR the Project tracks: workers' own, PRs it follows on request, and
 * PRs no agent opened that it closed. For a PR it both followed and closed,
 * the newest record wins.
 */
export async function listProjectPullRequests(projectId: string): Promise<ProjectPullRequestListing[]> {
  const record = await readProject(projectId);
  if (!record) {
    return [];
  }
  const listings: ProjectPullRequestListing[] = record.children
    .filter((child) => child.pr && child.deletedAt == null)
    .map((child) => ({ ...child.pr!, agent: child.name }));
  const owned = new Set(listings.map(prKey));
  const others = new Map<string, ProjectPullRequestListing>();
  const offer = (pr: ProjectPullRequest) => {
    const key = prKey(pr);
    const current = others.get(key);
    if (!owned.has(key) && (!current || pr.updatedAt > current.updatedAt)) {
      others.set(key, { ...pr, agent: null });
    }
  };
  record.closedPrs.forEach(offer);
  for (const subscription of await readProjectSubscriptions(projectId)) {
    if (subscription.spec.kind === "github_pr" && !subscription.childId && subscription.state.pr) {
      offer(subscription.state.pr);
    }
  }
  return [...listings, ...others.values()].sort((a, b) => b.updatedAt - a.updatedAt);
}

/** Keeps a PR no agent opened in the Project's list after the Project closed it. */
async function recordClosedPullRequest(projectId: string, pr: ProjectPullRequest): Promise<void> {
  await mutateProject(
    projectId,
    (record) => ({
      ...record,
      closedPrs: [pr, ...record.closedPrs.filter((entry) => prKey(entry) !== prKey(pr))].slice(0, CLOSED_PRS_KEPT),
    }),
    { touch: false }
  );
}

/**
 * `owner/repo#N`, a pull request URL, or `<repository>#N` naming one of the
 * Project's repositories that is bound to GitHub.
 */
function parsePullRef(ref: string, record: ProjectRecord): { repo: string; number: number } | null {
  const trimmed = ref.trim();
  const urlMatch = trimmed.match(/\/([^/]+\/[^/]+)\/pull\/(\d+)/);
  const slugMatch = trimmed.match(/^([^/\s#]+\/[^/\s#]+)#(\d+)$/);
  const match = urlMatch ?? slugMatch;
  if (match) {
    return { repo: match[1]!, number: Number(match[2]) };
  }
  const named = trimmed.match(/^([^/\s#]+)#(\d+)$/);
  const repo = named ? record.repos.find((entry) => entry.name.toLowerCase() === named[1]!.toLowerCase()) : null;
  return named && repo?.githubRepo ? { repo: repo.githubRepo, number: Number(named[2]) } : null;
}

function findListing(
  listings: readonly ProjectPullRequestListing[],
  ref: string,
  record: ProjectRecord
): ProjectPullRequestListing | null {
  const trimmed = ref.trim();
  const parsed = parsePullRef(trimmed, record);
  const numberMatch = trimmed.match(/^#?(\d+)$/);
  return (
    listings.find((pr) => {
      if (parsed) return pr.repo.toLowerCase() === parsed.repo.toLowerCase() && pr.number === parsed.number;
      if (numberMatch) return pr.number === Number(numberMatch[1]);
      return pr.agent?.toLowerCase() === trimmed.toLowerCase();
    }) ?? null
  );
}

function prNotFound(listings: readonly ProjectPullRequestListing[], ref: string, record: ProjectRecord): ProjectError {
  const known = listings.map((pr) => `${pr.repo}#${pr.number}${pr.agent ? ` (${pr.agent})` : ""}`);
  const bound = record.repos.filter((repo) => repo.githubRepo).map((repo) => `${repo.name} is ${repo.githubRepo}`);
  return new ProjectError(
    `No tracked pull request matches "${ref}".${known.length ? ` Tracked: ${known.join(", ")}.` : ""}${
      bound.length ? ` Name others as owner/repo#N or <repository>#N (${bound.join(", ")}).` : ""
    }`,
    404,
    "pr_not_found"
  );
}

function resolveListing(
  listings: readonly ProjectPullRequestListing[],
  ref: string,
  record: ProjectRecord
): ProjectPullRequestListing {
  const found = findListing(listings, ref, record);
  if (!found) {
    throw prNotFound(listings, ref, record);
  }
  return found;
}

function normalizeQuote(text: string): string {
  return text.toLowerCase().replace(/[\u2018\u2019]/g, "'").replace(/[\u201c\u201d]/g, '"').replace(/\s+/g, " ").trim();
}

/** The last few things the user said to the orchestrator: what they typed (not notices or events) and their answers to its questions. */
async function recentUserMessages(record: ProjectRecord): Promise<string[]> {
  const snapshot = await readConversationSnapshot(
    record.orchestrator.workspaceId,
    record.orchestrator.conversationId
  ).catch(() => null);
  if (!snapshot) {
    return [];
  }
  return snapshot.events
    .flatMap((event) => {
      if (event.kind === "user_message") {
        const typed =
          !event.hidden &&
          !event.displayContent?.startsWith(PROJECT_NOTICE_DISPLAY_PREFIX) &&
          !isProjectEventDisplay(event.displayContent);
        return typed ? [event.displayContent?.trim() || event.content] : [];
      }
      // Their answer to a question the orchestrator asked them is their word too.
      if (event.kind === "question" && event.status === "answered" && event.answer) {
        return [Array.isArray(event.answer) ? event.answer.join("\n") : event.answer];
      }
      return [];
    })
    .slice(-USER_QUOTE_LOOKBACK);
}

/** Throws unless `quote` is non-empty and appears in one of the user's recent messages. */
async function assertUserQuote(
  record: ProjectRecord,
  quote: string | null | undefined,
  errors: { missing: string; unmatched: string; code: string }
): Promise<void> {
  const trimmed = quote?.trim();
  if (!trimmed) {
    throw new ProjectError(errors.missing, 403, errors.code);
  }
  const messages = (await recentUserMessages(record)).map(normalizeQuote);
  if (!messages.some((message) => message.includes(normalizeQuote(trimmed)))) {
    throw new ProjectError(errors.unmatched, 403, errors.code);
  }
}

function conflictGuidance(ref: string, base: string, agent: string | null): string {
  return `${ref} has conflicts with ${base}. ${agent ? `Ask ${agent} to rebase it with project_request_rebase` : "Its author has to rebase it"}, or close it with project_close_pr if it is redundant.`;
}

export type MergeResult = { pr: ProjectPullRequestListing; sha: string | null };

/**
 * Squash-merges a tracked PR as `PR title (#N)`, keeping its branch. The
 * orchestrator may only merge under `when_green`, or with a quote of the
 * user's own go-ahead from their recent messages, and not while the agent's
 * change to what users see still lacks screenshots; the user merging from the
 * UI (`byUser`) needs none of that. Every merge needs an open, ready,
 * mergeable PR with green CI (or none) and no outstanding request for changes.
 */
export async function mergeProjectPullRequest(
  projectId: string,
  input: { pr: string; userQuote?: string | null; byUser?: boolean }
): Promise<MergeResult> {
  const record = await readProject(projectId);
  if (!record) {
    throw new ProjectError(`Unknown project: ${projectId}`, 404, "project_not_found");
  }
  const listing = resolveListing(await listProjectPullRequests(projectId), input.pr ?? "", record);
  if (!input.byUser && record.settings.mergePolicy !== "when_green") {
    await assertUserQuote(record, input.userQuote, {
      missing:
        "Merging needs the user's explicit go-ahead: if they already told you to merge, pass their words as user_quote; otherwise ask them first.",
      unmatched: "user_quote does not appear in the user's recent messages, so the merge is not authorized. Ask the user.",
      code: "merge_not_authorized",
    });
  }
  const author = record.children.find(
    (child) => child.deletedAt == null && child.pr?.repo === listing.repo && child.pr.number === listing.number
  );
  if (!input.byUser && author?.evidence && author.evidence.files.length === 0) {
    throw new ProjectError(
      `${listing.repo}#${listing.number} changes what users see (${author.evidence.uiFiles.slice(0, 3).join(", ")}) and has no screenshots or recording yet, so it is not done. Wait for ${author.name}'s update with the evidence${author.evidence.requestedAt != null ? " (it was asked for it)" : ""}, or capture it with project_browser_check, then merge.`,
      409,
      "evidence_missing"
    );
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
    throw new ProjectError(conflictGuidance(`${listing.repo}#${listing.number}`, pull.base.ref, listing.agent), 409, "merge_conflict");
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
  const result = await client
    .mergePull(listing.repo, listing.number, {
      mergeMethod: "squash",
      commitTitle: `${pull.title} (#${listing.number})`,
      sha: pull.head.sha,
    })
    .catch((error: unknown) => {
      // GitHub answers 405 when the trial merge it runs at merge time conflicts.
      if (error instanceof GithubApiError && error.status === 405) {
        throw new ProjectError(conflictGuidance(`${listing.repo}#${listing.number}`, pull.base.ref, listing.agent), 409, "merge_conflict");
      }
      throw error;
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
  const { closeSubscriptionsForPr } = await import("./listening.js");
  await closeSubscriptionsForPr(projectId, listing.repo, listing.number, pull.head.ref, mergedPr);
  return { pr: { ...mergedPr, agent: listing.agent }, sha: result.sha ?? null };
}

/**
 * Closes a pull request without merging, posting the reason on it. A PR one of
 * the Project's agents opened can be closed by the coordinator on its own
 * judgment; any other (a teammate's PR in one of the Project's repositories)
 * needs the user's go-ahead quoted, unless the user does it (`byUser`).
 */
export async function closeProjectPullRequest(
  projectId: string,
  input: { pr: string; reason: string; userQuote?: string | null; byUser?: boolean }
): Promise<{ pr: ProjectPullRequestListing }> {
  const record = await readProject(projectId);
  if (!record) {
    throw new ProjectError(`Unknown project: ${projectId}`, 404, "project_not_found");
  }
  const reason = input.reason?.trim();
  if (!reason) {
    throw new ProjectError("Say why the pull request is being closed (reason); it is posted on the PR.");
  }
  const listings = await listProjectPullRequests(projectId);
  const tracked = findListing(listings, input.pr ?? "", record);
  const ref = tracked ?? parsePullRef(input.pr ?? "", record);
  if (!ref || (!tracked && !record.repos.some((repo) => repo.githubRepo?.toLowerCase() === ref.repo.toLowerCase()))) {
    throw prNotFound(listings, input.pr ?? "", record);
  }
  const agent = tracked?.agent ?? null;
  if (!input.byUser && !agent) {
    await assertUserQuote(record, input.userQuote, {
      missing:
        "Closing a pull request that no agent of this Project opened needs the user's explicit go-ahead: if they already told you to close it, pass their words as user_quote; otherwise ask them first.",
      unmatched: "user_quote does not appear in the user's recent messages, so closing it is not authorized. Ask the user.",
      code: "close_not_authorized",
    });
  }
  const client = await projectGithubClient();
  if (!client) {
    throw new ProjectError("GitHub is not connected on this engine.", 409, "github_not_connected");
  }
  const pull = await client.getPull(ref.repo, ref.number);
  const merged = pull.merged === true || Boolean(pull.merged_at);
  if (merged || pull.state !== "open") {
    throw new ProjectError(`${ref.repo}#${ref.number} is already ${merged ? "merged" : "closed"}.`, 409);
  }
  await client.addIssueComment(ref.repo, ref.number, `Closed by the Cesium Project "${record.name}": ${reason}`);
  const closed = await client.closePull(ref.repo, ref.number);
  const owner = record.children.find(
    (child) => child.deletedAt == null && child.pr?.repo === ref.repo && child.pr.number === ref.number
  );
  const closedPr: ProjectPullRequest = {
    ...toProjectPullRequest(ref.repo, closed, owner?.pr ?? tracked ?? null),
    state: "closed",
    closedByProject: true,
  };
  if (owner) {
    await patchChildPullRequest(projectId, owner.id, () => closedPr);
  } else {
    await recordClosedPullRequest(projectId, closedPr);
  }
  const { closeSubscriptionsForPr } = await import("./listening.js");
  await closeSubscriptionsForPr(projectId, ref.repo, ref.number, pull.head.ref, closedPr);
  return { pr: { ...closedPr, agent } };
}

/** Everyone whose latest review asked for changes or only commented (bots and the author can't be asked). */
export function reviewersToAskAgain(reviews: readonly GithubReview[], author: string | null): string[] {
  const latest = new Map<string, string>();
  for (const review of reviews) {
    const login = review.user?.login;
    const state = review.state?.toUpperCase();
    if (!login || !state || state === "PENDING" || state === "DISMISSED") {
      continue;
    }
    latest.set(login, state);
  }
  return [...latest]
    .filter(([login, state]) => state !== "APPROVED" && login !== author && !login.endsWith("[bot]"))
    .map(([login]) => login);
}

/**
 * Re-requests review on a tracked PR, by default from the reviewers who asked
 * for changes or commented, optionally with a note mentioning them.
 */
export async function requestProjectPullRequestReview(
  projectId: string,
  input: { pr: string; reviewers?: readonly string[] | null; note?: string | null }
): Promise<{ pr: ProjectPullRequestListing; requested: string[] }> {
  const record = await readProject(projectId);
  if (!record) {
    throw new ProjectError(`Unknown project: ${projectId}`, 404, "project_not_found");
  }
  const listing = resolveListing(await listProjectPullRequests(projectId), input.pr ?? "", record);
  const client = await projectGithubClient();
  if (!client) {
    throw new ProjectError("GitHub is not connected on this engine.", 409, "github_not_connected");
  }
  const ref = `${listing.repo}#${listing.number}`;
  const pull = await client.getPull(listing.repo, listing.number);
  if (pull.state !== "open" || pull.merged === true) {
    throw new ProjectError(`${ref} is not open.`, 409);
  }
  let reviewers = (input.reviewers ?? []).map((login) => login.trim().replace(/^@/, "")).filter(Boolean);
  if (reviewers.length === 0) {
    reviewers = reviewersToAskAgain(await client.listReviews(listing.repo, listing.number), pull.user?.login ?? null);
  }
  if (reviewers.length === 0) {
    throw new ProjectError(`Nobody has asked for changes on ${ref}; name the reviewers to ask.`, 409, "no_reviewers");
  }
  const note = input.note?.trim();
  if (note) {
    await client.addIssueComment(listing.repo, listing.number, `${reviewers.map((login) => `@${login}`).join(" ")} ${note}`);
  }
  await client.requestReviewers(listing.repo, listing.number, reviewers);
  return { pr: listing, requested: reviewers };
}

export type RebaseRequest = {
  pr: ProjectPullRequestListing;
  childId: string;
  message: string;
  /** GitHub's current verdict: false when it conflicts, null when not computed yet. */
  mergeable: boolean | null;
};

/**
 * The agent that owns a tracked, still-open PR and the message that has it
 * rebase the branch onto the latest base. PRs no agent owns are refused: only
 * their author can rebase them.
 */
export async function rebaseRequestFor(projectId: string, input: { pr: string; note?: string | null }): Promise<RebaseRequest> {
  const record = await readProject(projectId);
  if (!record) {
    throw new ProjectError(`Unknown project: ${projectId}`, 404, "project_not_found");
  }
  const listing = resolveListing(await listProjectPullRequests(projectId), input.pr ?? "", record);
  const ref = `${listing.repo}#${listing.number}`;
  const owner = record.children.find(
    (child) => child.deletedAt == null && child.pr?.repo === listing.repo && child.pr.number === listing.number
  );
  if (!owner) {
    throw new ProjectError(`No agent of this Project owns ${ref}, so none can rebase it; its author has to.`, 409, "no_owner");
  }
  const client = await projectGithubClient();
  const pull = client ? await client.getPull(listing.repo, listing.number) : null;
  const merged = pull ? pull.merged === true || Boolean(pull.merged_at) : listing.state === "merged";
  if (merged || (pull ? pull.state !== "open" : listing.state !== "open")) {
    throw new ProjectError(`${ref} is already ${merged ? "merged" : "closed"}.`, 409);
  }
  const mergeable = pull ? (typeof pull.mergeable === "boolean" ? pull.mergeable : null) : listing.mergeable;
  return {
    pr: listing,
    childId: owner.id,
    message: buildRebaseRequest({
      pr: { repo: listing.repo, number: listing.number, baseRef: pull?.base.ref ?? listing.baseRef },
      branch: pull?.head.ref || listing.headRef || owner.branch || "",
      note: input.note,
      mergeable,
    }),
    mergeable,
  };
}

/** What an agent is sent to rebase its pull request (one that conflicts, unless `mergeable` says otherwise). */
export function buildRebaseRequest(input: {
  pr: Pick<ProjectPullRequest, "repo" | "number" | "baseRef">;
  branch: string;
  note?: string | null;
  mergeable?: boolean | null;
}): string {
  const base = input.pr.baseRef || "main";
  const ref = `${input.pr.repo}#${input.pr.number}`;
  return [
    input.mergeable === true
      ? `Bring your pull request ${ref} up to date: ${base} has moved on since you branched.`
      : `Your pull request ${ref} no longer merges into ${base}: ${base} has moved on and now conflicts with your branch.`,
    ...(input.note?.trim() ? [input.note.trim()] : []),
    `Rebase \`${input.branch}\` onto the latest ${base} and resolve the conflicts yourself:`,
    `1. \`git fetch origin\`, then \`git rebase origin/${base}\`.`,
    "2. In each conflict keep what the base has now and put your change on top of it, so both work. Don't drop either side.",
    "3. Run the tests.",
    `4. \`git push --force-with-lease origin ${input.branch}\`; the pull request updates itself.`,
    "Then report what conflicted and how you resolved it.",
  ].join("\n");
}
