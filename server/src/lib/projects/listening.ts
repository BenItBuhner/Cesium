import { randomBytes } from "node:crypto";
import type {
  ProjectPullRequest,
  ProjectPullRequestCi,
  ProjectSubscriptionSummary,
} from "@cesium/core/projects";
import { nextCronRunAfter, parseCronExpression } from "../agents/cesium-cron.js";
import { agentRuntimeManager } from "../agents/runtime-manager.js";
import { getWorkspaceById } from "../workspace-registry.js";
import { writeContextFile } from "./context-store.js";
import { ProjectError } from "./errors.js";
import { composeProjectEvents, renderProjectEvent, type ProjectEvent } from "./events.js";
import { isProjectsEnabled } from "./feature-flag.js";
import {
  GithubApiError,
  projectGithubClient,
  summarizeCi,
  type GithubClient,
} from "./github/client.js";
import { isGithubRepoSlug } from "./github/repo-identity.js";
import { listProjectRecords, readProject } from "./project-store.js";
import {
  aggregateReviews,
  patchChildPullRequest,
  toProjectPullRequest,
  trackWorkerPullRequest,
} from "./pull-requests.js";
import {
  mutateProjectSubscriptions,
  newSubscriptionId,
  readProjectSubscriptions,
  summarizeSubscription,
  type GithubCiSpec,
  type GithubPrSpec,
  type ProjectSubscriptionRecord,
  type ProjectSubscriptionState,
  type TimerSpec,
} from "./subscriptions-store.js";
import type { ProjectChildRecord, ProjectRecord } from "./types.js";

const TICK_MS = 15_000;
const PR_POLL_MS = 30_000;
const CI_PENDING_POLL_MS = 20_000;
const CI_SETTLED_POLL_MS = 60_000;
const PR_DISCOVERY_MS = 60_000;
const DEFAULT_EXPIRY_MS = 90 * 24 * 60 * 60_000;
const MAX_EXPIRY_MS = 180 * 24 * 60 * 60_000;
const MIN_TIMER_INTERVAL_S = 60;
const BODY_EXCERPT_CHARS = 1_500;
const SEEN_IDS_KEPT = 500;

export type SubscribeInput =
  | { kind: "github_pr"; repo: string; number: number; keepAfterClose?: boolean }
  | { kind: "github_ci"; repo: string; branch: string }
  | {
      kind: "timer";
      name: string;
      prompt: string;
      cron?: string | null;
      intervalSeconds?: number | null;
      delaySeconds?: number | null;
      once?: boolean;
    };

function excerpt(text: string | null | undefined): string {
  const trimmed = (text ?? "").trim();
  if (!trimmed) {
    return "(no text)";
  }
  return trimmed.length > BODY_EXCERPT_CHARS ? `${trimmed.slice(0, BODY_EXCERPT_CHARS - 1)}…` : trimmed;
}

function subscriptionKey(spec: ProjectSubscriptionRecord["spec"]): string {
  switch (spec.kind) {
    case "github_pr":
      return `pr:${spec.repo.toLowerCase()}#${spec.number}`;
    case "github_ci":
      return `ci:${spec.repo.toLowerCase()}@${spec.branch}`;
    case "timer":
      return `timer:${spec.name.toLowerCase()}`;
  }
}

function firstFireAt(spec: TimerSpec, delaySeconds: number | null, now: number): number {
  if (spec.cron) {
    const next = nextCronRunAfter(parseCronExpression(spec.cron), now);
    if (next == null) {
      throw new ProjectError(`Cron "${spec.cron}" never fires.`);
    }
    return next;
  }
  if (spec.once) {
    return now + Math.max(1, delaySeconds ?? spec.intervalSeconds ?? MIN_TIMER_INTERVAL_S) * 1000;
  }
  return now + (spec.intervalSeconds ?? MIN_TIMER_INTERVAL_S) * 1000;
}

const defaultBranchCache = new Map<string, string>();

async function defaultBranchOf(client: GithubClient | null, repo: string): Promise<string | null> {
  const cachedBranch = defaultBranchCache.get(repo);
  if (cachedBranch) {
    return cachedBranch;
  }
  if (!client) {
    return null;
  }
  const info = await client.request<{ default_branch?: string }>("GET", `/repos/${repo}`).catch(() => null);
  if (info?.default_branch) {
    defaultBranchCache.set(repo, info.default_branch);
    return info.default_branch;
  }
  return null;
}

/**
 * Adds a subscription (or returns the open one watching the same thing; a
 * timer with the same name is replaced). Only activity after it starts is
 * delivered.
 */
export async function subscribeProject(
  projectId: string,
  input: SubscribeInput & { expiresInMs?: number | null },
  createdBy: ProjectSubscriptionSummary["createdBy"],
  childId: string | null = null
): Promise<{ subscription: ProjectSubscriptionRecord; created: boolean }> {
  const record = await readProject(projectId);
  if (!record) {
    throw new ProjectError(`Unknown project: ${projectId}`, 404, "project_not_found");
  }
  const now = Date.now();
  let spec: ProjectSubscriptionRecord["spec"];
  let delaySeconds: number | null = null;
  switch (input.kind) {
    case "github_pr": {
      if (!isGithubRepoSlug(input.repo) || !Number.isInteger(input.number) || input.number <= 0) {
        throw new ProjectError("A PR subscription needs repo (owner/repo) and a PR number.");
      }
      spec = { kind: "github_pr", repo: input.repo, number: input.number, keepAfterClose: input.keepAfterClose === true };
      break;
    }
    case "github_ci": {
      if (!isGithubRepoSlug(input.repo) || !input.branch?.trim()) {
        throw new ProjectError("A CI subscription needs repo (owner/repo) and branch.");
      }
      const branch = input.branch.trim();
      const defaultBranch = await defaultBranchOf(await projectGithubClient(), input.repo);
      spec = { kind: "github_ci", repo: input.repo, branch, oneShot: defaultBranch === branch };
      break;
    }
    case "timer": {
      const name = input.name?.trim().slice(0, 80);
      const prompt = input.prompt?.trim().slice(0, 4_000);
      if (!name || !prompt) {
        throw new ProjectError("A timer needs a name and a prompt.");
      }
      const cron = input.cron?.trim() || null;
      if (cron) {
        try {
          parseCronExpression(cron);
        } catch (error) {
          throw new ProjectError(error instanceof Error ? error.message : `Invalid cron "${cron}".`);
        }
      }
      const once = input.once === true;
      const interval = input.intervalSeconds ?? null;
      delaySeconds = input.delaySeconds ?? null;
      if (!cron && !once && (interval == null || interval < MIN_TIMER_INTERVAL_S)) {
        throw new ProjectError(`A recurring timer needs cron or an interval of at least ${MIN_TIMER_INTERVAL_S / 60} minute.`);
      }
      if (!cron && once && delaySeconds == null && interval == null) {
        throw new ProjectError("A one-off timer needs a delay.");
      }
      spec = { kind: "timer", name, prompt, cron, intervalSeconds: cron ? null : interval, once: cron ? false : once };
      break;
    }
  }
  const expiresInMs = Math.min(MAX_EXPIRY_MS, Math.max(60_000, input.expiresInMs ?? DEFAULT_EXPIRY_MS));
  let result: { subscription: ProjectSubscriptionRecord; created: boolean } | null = null;
  await mutateProjectSubscriptions(projectId, (current) => {
    const key = subscriptionKey(spec);
    const existing = current.find((entry) => entry.closedAt == null && subscriptionKey(entry.spec) === key);
    if (existing && spec.kind !== "timer") {
      result = { subscription: existing, created: false };
      return current;
    }
    const state: ProjectSubscriptionState =
      spec.kind === "timer" ? { nextFireAt: firstFireAt(spec, delaySeconds, now), fired: 0 } : { primed: false };
    const subscription: ProjectSubscriptionRecord = {
      id: newSubscriptionId(),
      kind: spec.kind,
      spec,
      createdBy,
      childId,
      createdAt: now,
      expiresAt: now + expiresInMs,
      lastPolledAt: null,
      lastEventAt: null,
      closedAt: null,
      closedReason: null,
      state,
    };
    result = { subscription, created: true };
    const withoutReplaced = existing
      ? current.map((entry) =>
          entry.id === existing.id ? { ...entry, closedAt: now, closedReason: "replaced" } : entry
        )
      : current;
    return [...withoutReplaced, subscription];
  });
  return result!;
}

export async function unsubscribeProject(
  projectId: string,
  subscriptionId: string,
  reason = "unsubscribed"
): Promise<ProjectSubscriptionRecord> {
  let closed: ProjectSubscriptionRecord | null = null;
  await mutateProjectSubscriptions(projectId, (current) => {
    const target = current.find((entry) => entry.id === subscriptionId && entry.closedAt == null);
    if (!target) {
      return current;
    }
    closed = { ...target, closedAt: Date.now(), closedReason: reason };
    return current.map((entry) => (entry.id === subscriptionId ? closed! : entry));
  });
  if (!closed) {
    throw new ProjectError(`No open subscription ${subscriptionId}.`, 404, "subscription_not_found");
  }
  return closed;
}

export async function listProjectSubscriptionSummaries(
  projectId: string,
  options?: { includeClosed?: boolean }
): Promise<ProjectSubscriptionSummary[]> {
  const [record, subscriptions] = await Promise.all([
    readProject(projectId),
    readProjectSubscriptions(projectId),
  ]);
  const children = record?.children ?? [];
  return subscriptions
    .filter((entry) => options?.includeClosed || entry.closedAt == null)
    .sort((a, b) => b.createdAt - a.createdAt)
    .map((entry) => summarizeSubscription(entry, children));
}

/** Follows a worker's PR and its branch CI (the Project's autoSubscribe). */
export async function ensureWorkerPrSubscriptions(
  projectId: string,
  childId: string,
  pr: ProjectPullRequest
): Promise<void> {
  const record = await readProject(projectId);
  if (!record?.settings.autoSubscribe || pr.state !== "open") {
    return;
  }
  await subscribeProject(projectId, { kind: "github_pr", repo: pr.repo, number: pr.number }, "auto", childId);
  if (pr.headRef) {
    await subscribeProject(projectId, { kind: "github_ci", repo: pr.repo, branch: pr.headRef }, "auto", childId);
  }
}

/** After the Project merged a PR itself: close what watched it, without reporting the merge back. */
export async function closeSubscriptionsForMergedPr(
  projectId: string,
  repo: string,
  number: number,
  headRef: string,
  pr: ProjectPullRequest
): Promise<void> {
  const now = Date.now();
  await mutateProjectSubscriptions(projectId, (current) => {
    let changed = false;
    const next = current.map((entry) => {
      if (entry.closedAt != null) {
        return entry;
      }
      const spec = entry.spec;
      const watchesPr = spec.kind === "github_pr" && spec.repo === repo && spec.number === number;
      const watchesBranch = spec.kind === "github_ci" && spec.repo === repo && spec.branch === headRef;
      if (!watchesPr && !watchesBranch) {
        return entry;
      }
      changed = true;
      return {
        ...entry,
        closedAt: now,
        closedReason: "pr_merged",
        state: watchesPr ? { ...entry.state, prState: "merged" as const, pr } : entry.state,
      };
    });
    return changed ? next : current;
  });
}

type PollOutcome = {
  events: ProjectEvent[];
  state?: ProjectSubscriptionState;
  close?: string;
  /** Other subscriptions to close as a consequence (a merged PR's branch CI). */
  closeOthers?: Array<{ id: string; reason: string }>;
};

function ownerOf(record: ProjectRecord, subscription: ProjectSubscriptionRecord, repo: string, match: (child: ProjectChildRecord) => boolean) {
  return (
    (subscription.childId ? record.children.find((child) => child.id === subscription.childId) : undefined) ??
    record.children.find((child) => child.deletedAt == null && child.githubRepo === repo && match(child))
  );
}

/** Allowance for clock skew with GitHub when deciding what predates a subscription. */
const PRIMING_GRACE_MS = 60_000;

/**
 * Before this moment, comments and reviews are history the first poll only
 * records. On an agent's own PR everything is news to the coordinator; on
 * any other PR, only what came after the Project started following it (a
 * bot reviewing within seconds of the PR opening must not be swallowed).
 */
function primingCutoff(subscription: ProjectSubscriptionRecord): number {
  return subscription.childId ? 0 : subscription.createdAt - PRIMING_GRACE_MS;
}

function postedBefore(at: string | null | undefined, cutoff: number): boolean {
  const time = at ? Date.parse(at) : Number.NaN;
  return !Number.isFinite(time) || time < cutoff;
}

function newIds<T extends { id: number }>(items: readonly T[], seen: readonly number[] | undefined): T[] {
  const known = new Set(seen ?? []);
  return items.filter((item) => !known.has(item.id));
}

function keepIds(previous: readonly number[] | undefined, items: readonly { id: number }[]): number[] {
  return [...new Set([...(previous ?? []), ...items.map((item) => item.id)])].slice(-SEEN_IDS_KEPT);
}

async function pollPullRequest(
  client: GithubClient,
  record: ProjectRecord,
  subscription: ProjectSubscriptionRecord,
  spec: GithubPrSpec,
  subscriptions: readonly ProjectSubscriptionRecord[]
): Promise<PollOutcome> {
  const pull = await client.getPull(spec.repo, spec.number);
  const [comments, reviews, reviewComments] = await Promise.all([
    client.listIssueComments(spec.repo, spec.number),
    client.listReviews(spec.repo, spec.number),
    client.listReviewComments(spec.repo, spec.number),
  ]);
  const owner = ownerOf(record, subscription, spec.repo, (child) => child.pr?.number === spec.number);
  const merged = pull.merged === true || Boolean(pull.merged_at);
  const prState: "open" | "closed" | "merged" = merged ? "merged" : pull.state === "closed" ? "closed" : "open";
  const review = aggregateReviews(reviews);
  const snapshot = toProjectPullRequest(spec.repo, pull, owner?.pr ?? subscription.state.pr ?? null, { review });
  if (owner) {
    await patchChildPullRequest(record.id, owner.id, (current) =>
      toProjectPullRequest(spec.repo, pull, current, { review })
    );
  }
  const decided = reviews.filter((entry) => entry.state?.toUpperCase() !== "PENDING");
  const primed = subscription.state.primed === true;
  const cutoff = primingCutoff(subscription);
  const seenCommentIds = primed
    ? subscription.state.seenCommentIds
    : comments.filter((comment) => postedBefore(comment.created_at, cutoff)).map((comment) => comment.id);
  const seenReviewIds = primed
    ? subscription.state.seenReviewIds
    : decided.filter((entry) => postedBefore(entry.submitted_at, cutoff)).map((entry) => entry.id);
  const seenReviewCommentIds = primed
    ? subscription.state.seenReviewCommentIds
    : reviewComments.filter((comment) => postedBefore(comment.created_at, cutoff)).map((comment) => comment.id);
  const nextState: ProjectSubscriptionState = {
    ...subscription.state,
    primed: true,
    prState,
    draft: pull.draft === true,
    headSha: pull.head.sha,
    seenCommentIds: keepIds(subscription.state.seenCommentIds, comments),
    seenReviewIds: keepIds(subscription.state.seenReviewIds, decided),
    seenReviewCommentIds: keepIds(subscription.state.seenReviewCommentIds, reviewComments),
    ...(owner ? {} : { pr: snapshot }),
  };
  const agent = owner?.name;
  const attrs = (action: string, extra: Record<string, string | number | undefined> = {}) => ({
    pr: pull.html_url,
    action,
    ...extra,
    agent,
    subscriptionId: subscription.id,
    subscriptionType: "github:pull_request:pr",
  });
  const ref = `${spec.repo}#${spec.number}`;
  const events: ProjectEvent[] = [];
  for (const comment of newIds(comments, seenCommentIds)) {
    events.push({
      source: "github",
      attrs: attrs("comment", { sender: comment.user?.login, commentUrl: comment.html_url }),
      body: `${comment.user?.login ?? "Someone"} commented on the pull request:\n${excerpt(comment.body)}`,
      label: `${ref} comment`,
    });
  }
  for (const entry of newIds(decided, seenReviewIds)) {
    const state = entry.state.toLowerCase();
    events.push({
      source: "github",
      attrs: attrs("review", { sender: entry.user?.login, reviewState: state }),
      body: `${entry.user?.login ?? "Someone"} submitted a review (${state.replace(/_/g, " ")}):\n${excerpt(entry.body)}`,
      label: `${ref} review`,
    });
  }
  for (const comment of newIds(reviewComments, seenReviewCommentIds)) {
    events.push({
      source: "github",
      attrs: attrs("review_comment", {
        sender: comment.user?.login,
        path: comment.path,
        line: comment.line ?? undefined,
        commentUrl: comment.html_url,
      }),
      body: `${comment.user?.login ?? "Someone"} commented on ${comment.path ?? "the diff"}${comment.line ? `:${comment.line}` : ""}:\n${excerpt(comment.body)}`,
      label: `${ref} review comment`,
    });
  }
  if (!primed) {
    // The first poll sets the baseline for the PR's state, head and draft flag.
    return { events, state: nextState };
  }
  // A worker's own pushes are its business; only report pushes to PRs nobody here owns.
  if (!subscription.childId && subscription.state.headSha && subscription.state.headSha !== pull.head.sha && prState === "open") {
    events.push({
      source: "github",
      attrs: attrs("synchronize"),
      body: `New commits were pushed; the head is now ${pull.head.sha.slice(0, 12)}.`,
      label: `${ref} new commits`,
    });
  }
  if (subscription.state.draft === true && pull.draft !== true && prState === "open") {
    events.push({ source: "github", attrs: attrs("ready_for_review"), body: "This pull request is ready for review.", label: `${ref} ready` });
  }
  const closeOthers: Array<{ id: string; reason: string }> = [];
  let close: string | undefined;
  if (subscription.state.prState && subscription.state.prState !== prState) {
    if (prState === "open") {
      events.push({ source: "github", attrs: attrs("reopened"), body: "This pull request was reopened.", label: `${ref} reopened` });
    } else {
      if (!spec.keepAfterClose) {
        close = prState === "merged" ? "pr_merged" : "pr_closed";
        // Its branch CI has nothing left to report once no open PR uses the branch.
        for (const other of subscriptions) {
          const otherSpec = other.spec;
          if (
            other.closedAt == null &&
            otherSpec.kind === "github_ci" &&
            otherSpec.repo === spec.repo &&
            otherSpec.branch === pull.head.ref
          ) {
            closeOthers.push({ id: other.id, reason: close });
          }
        }
      }
      events.push({
        source: "github",
        attrs: attrs(prState, {
          ...(close ? { subscriptionClosed: close } : {}),
          ...(closeOthers[0] ? { linkedSubscriptionId: closeOthers[0].id, linkedSubscriptionClosed: close } : {}),
        }),
        body:
          prState === "merged"
            ? `This pull request is now merged.${close ? " Its subscriptions are closed; nothing more will be delivered for it." : ""}`
            : `This pull request was closed without merging.${close ? " Its subscriptions are closed." : ""}`,
        label: `${ref} ${prState}`,
      });
    }
  }
  return { events, state: nextState, ...(close ? { close } : {}), closeOthers };
}

async function pollCi(
  client: GithubClient,
  record: ProjectRecord,
  subscription: ProjectSubscriptionRecord,
  spec: GithubCiSpec
): Promise<PollOutcome> {
  const head = await client.getBranchHead(spec.repo, spec.branch);
  if (!head) {
    return { events: [], close: "branch_deleted" };
  }
  const [runs, combined] = await Promise.all([
    client.listCheckRuns(spec.repo, head),
    client.getCombinedStatus(spec.repo, head).catch(() => null),
  ]);
  const ci = summarizeCi(runs, combined);
  const owner = ownerOf(record, subscription, spec.repo, (child) => child.branch === spec.branch);
  if (owner?.pr && owner.pr.headRef === spec.branch && ci.state !== "none") {
    const verdict: ProjectPullRequestCi =
      ci.state === "failure" ? "failure" : ci.state === "success" ? "success" : "pending";
    await patchChildPullRequest(record.id, owner.id, (current) =>
      current ? { ...current, headSha: head, ci: verdict, failedChecks: ci.failed } : current
    );
  }
  const state: ProjectSubscriptionState = { ...subscription.state, primed: true, ciSha: head };
  if (ci.state === "pending" || ci.state === "none") {
    return { events: [], state };
  }
  const delivered = subscription.state.ciDeliveredConclusion ?? null;
  const alreadyDelivered = subscription.state.ciDeliveredSha === head && delivered === ci.state;
  const deliver =
    !alreadyDelivered &&
    (ci.state === "failure" || delivered == null || delivered === "failure");
  const nextState: ProjectSubscriptionState = {
    ...state,
    ciDeliveredSha: deliver || alreadyDelivered ? head : subscription.state.ciDeliveredSha ?? null,
    ciDeliveredConclusion: deliver ? ci.state : delivered,
  };
  if (!deliver) {
    return { events: [], state: nextState };
  }
  return {
    events: [
      {
        source: "github",
        attrs: {
          repo: spec.repo,
          branch: spec.branch,
          commit: head,
          conclusion: ci.state,
          checks: ci.total,
          agent: owner?.name,
          subscriptionId: subscription.id,
          subscriptionType: "github:ci:branch",
          ...(spec.oneShot ? { subscriptionClosed: "one_shot" } : {}),
        },
        body:
          ci.state === "failure"
            ? `${ci.failed.length} of ${ci.total} CI checks failed: ${ci.failed.join(", ")}`
            : `All ${ci.total} CI checks passed.`,
        label: `CI ${ci.state === "failure" ? "failed" : "passed"} on ${spec.branch}`,
      },
    ],
    state: nextState,
    ...(spec.oneShot ? { close: "one_shot" } : {}),
  };
}

function fireTimer(subscription: ProjectSubscriptionRecord, spec: TimerSpec, now: number): PollOutcome {
  const events: ProjectEvent[] = [
    {
      source: "timer",
      attrs: { name: spec.name, firedAt: new Date(now).toISOString(), subscriptionId: subscription.id },
      body: spec.prompt,
      label: `Timer · ${spec.name}`,
    },
  ];
  const fired = (subscription.state.fired ?? 0) + 1;
  if (spec.once) {
    return { events, state: { ...subscription.state, fired, nextFireAt: null }, close: "fired" };
  }
  const next = spec.cron
    ? nextCronRunAfter(parseCronExpression(spec.cron), now)
    : now + (spec.intervalSeconds ?? MIN_TIMER_INTERVAL_S) * 1000;
  return {
    events,
    state: { ...subscription.state, fired, nextFireAt: next },
    ...(next == null ? { close: "finished" } : {}),
  };
}

function isDue(subscription: ProjectSubscriptionRecord, now: number): boolean {
  const spec = subscription.spec;
  if (spec.kind === "timer") {
    return (subscription.state.nextFireAt ?? Infinity) <= now;
  }
  if (subscription.lastPolledAt == null) {
    return true;
  }
  const cadence =
    spec.kind === "github_pr"
      ? PR_POLL_MS
      : subscription.state.ciDeliveredSha && subscription.state.ciDeliveredSha === subscription.state.ciSha
        ? CI_SETTLED_POLL_MS
        : CI_PENDING_POLL_MS;
  return now - subscription.lastPolledAt >= cadence;
}

async function writeInbox(record: ProjectRecord, subscription: ProjectSubscriptionRecord, event: ProjectEvent, now: number): Promise<void> {
  const stamp = new Date(now).toISOString().replace(/[:.]/g, "-");
  const relative = `inbox/${subscription.kind}/${subscription.id}/${stamp}_${randomBytes(4).toString("hex")}.json`;
  await writeContextFile(
    record.id,
    relative,
    JSON.stringify(
      {
        v: 1,
        subscription_id: subscription.id,
        subscription_type: subscription.kind,
        enqueued_at_unix_ms: now,
        label: event.label,
        attrs: event.attrs,
        notification: renderProjectEvent(event),
      },
      null,
      2
    )
  ).catch((error) => {
    console.warn("[projects] could not write an inbox event:", error instanceof Error ? error.message : error);
  });
}

/** Wakes the orchestrator with external events: a new turn when idle, one coalesced queued turn when busy. */
export async function deliverProjectEvents(record: ProjectRecord, events: ProjectEvent[]): Promise<void> {
  if (events.length === 0) {
    return;
  }
  const workspace = await getWorkspaceById(record.orchestrator.workspaceId);
  if (!workspace) {
    return;
  }
  await agentRuntimeManager.deliverNotice(workspace, record.orchestrator.conversationId, {
    coalesceKey: `project-events:${record.id}`,
    compose: (existing) => composeProjectEvents(existing?.text ?? null, events),
  });
}

const lastDiscoveryAt = new Map<string, number>();

async function pollProject(record: ProjectRecord, client: GithubClient | null, now: number, force: boolean): Promise<void> {
  const subscriptions = await readProjectSubscriptions(record.id);
  const outcomes = new Map<string, PollOutcome & { polled: boolean }>();
  for (const subscription of subscriptions) {
    if (subscription.closedAt != null) {
      continue;
    }
    if (now >= subscription.expiresAt) {
      outcomes.set(subscription.id, { events: [], close: "expired", polled: false });
      continue;
    }
    const spec = subscription.spec;
    if (spec.kind !== "timer" && (!client || client.isRateLimited(now))) {
      continue;
    }
    if (!force && !isDue(subscription, now)) {
      continue;
    }
    if (spec.kind === "timer" && (subscription.state.nextFireAt ?? Infinity) > now) {
      continue;
    }
    try {
      const outcome =
        spec.kind === "github_pr"
          ? await pollPullRequest(client!, record, subscription, spec, subscriptions)
          : spec.kind === "github_ci"
            ? await pollCi(client!, record, subscription, spec)
            : fireTimer(subscription, spec, now);
      outcomes.set(subscription.id, { ...outcome, polled: true });
    } catch (error) {
      const gone = error instanceof GithubApiError && error.status === 404;
      if (!(error instanceof GithubApiError) || error.status !== 0) {
        console.warn(
          `[projects] subscription ${subscription.id} poll failed:`,
          error instanceof Error ? error.message : error
        );
      }
      outcomes.set(subscription.id, { events: [], polled: true, ...(gone ? { close: "not_found" } : {}) });
    }
  }
  const events: ProjectEvent[] = [];
  if (outcomes.size > 0) {
    const closeOthers = new Map<string, string>();
    for (const outcome of outcomes.values()) {
      for (const other of outcome.closeOthers ?? []) {
        closeOthers.set(other.id, other.reason);
      }
    }
    await mutateProjectSubscriptions(record.id, (current) =>
      current.map((entry) => {
        const outcome = outcomes.get(entry.id);
        const linkedReason = closeOthers.get(entry.id);
        if (!outcome && !linkedReason) {
          return entry;
        }
        const closeReason = outcome?.close ?? (entry.closedAt == null ? linkedReason : undefined);
        return {
          ...entry,
          ...(outcome?.state ? { state: outcome.state } : {}),
          ...(outcome?.polled ? { lastPolledAt: now } : {}),
          ...(outcome && outcome.events.length > 0 ? { lastEventAt: now } : {}),
          ...(closeReason && entry.closedAt == null ? { closedAt: now, closedReason: closeReason } : {}),
        };
      })
    );
    for (const [id, outcome] of outcomes) {
      const subscription = subscriptions.find((entry) => entry.id === id)!;
      for (const event of outcome.events) {
        events.push(event);
        await writeInbox(record, subscription, event, now);
      }
    }
  }
  if (client && !client.isRateLimited(now)) {
    await discoverWorkerPullRequests(record, client, now, force);
  }
  if (events.length > 0) {
    await deliverProjectEvents((await readProject(record.id)) ?? record, events);
  }
}

/** Picks up PRs workers opened mid-turn, so the Project follows them before the turn ends. */
async function discoverWorkerPullRequests(record: ProjectRecord, client: GithubClient, now: number, force: boolean): Promise<void> {
  for (const child of record.children) {
    if (child.deletedAt != null || child.archivedAt != null || child.pr || !child.branch || !child.githubRepo) {
      continue;
    }
    const key = `${record.id}:${child.id}`;
    if (!force && now - (lastDiscoveryAt.get(key) ?? 0) < PR_DISCOVERY_MS) {
      continue;
    }
    lastDiscoveryAt.set(key, now);
    const tracked = await trackWorkerPullRequest(record.id, child.id, { client }).catch(() => null);
    if (tracked) {
      await ensureWorkerPrSubscriptions(record.id, child.id, tracked.pr).catch(() => undefined);
    }
  }
}

/** One pass over every Project's subscriptions. `force` ignores poll cadences (tests, manual refresh). */
export async function runProjectListeningTick(options?: { now?: number; force?: boolean; projectId?: string }): Promise<void> {
  if (!(await isProjectsEnabled())) {
    return;
  }
  const now = options?.now ?? Date.now();
  const client = await projectGithubClient().catch(() => null);
  const records = options?.projectId
    ? [await readProject(options.projectId)].filter((record): record is ProjectRecord => record !== null)
    : await listProjectRecords();
  for (const record of records) {
    if (record.archivedAt != null) {
      continue;
    }
    await pollProject(record, client, now, options?.force === true).catch((error) => {
      console.warn(`[projects] listening failed for ${record.id}:`, error instanceof Error ? error.message : error);
    });
  }
}

let stopListening: (() => void) | null = null;

export function startProjectListening(): () => void {
  if (stopListening) {
    return stopListening;
  }
  let running = false;
  const timer = setInterval(() => {
    if (running) {
      return;
    }
    running = true;
    void runProjectListeningTick()
      .catch(() => undefined)
      .finally(() => {
        running = false;
      });
  }, TICK_MS);
  timer.unref?.();
  stopListening = () => {
    clearInterval(timer);
    stopListening = null;
  };
  return stopListening;
}
