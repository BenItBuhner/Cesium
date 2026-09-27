import { PROJECT_HOME_ENGINE_ID, isProjectChildBusy } from "@cesium/core/projects";
import { agentRuntimeManager } from "../agents/runtime-manager.js";
import { readConversationRecord, subscribeAgentStoreEvents } from "../agents/session-store.js";
import type { AgentConversationRecord } from "../agents/types.js";
import { getWorkspaceById } from "../workspace-registry.js";
import {
  observeConversationRecord,
  type ChildObservation,
} from "./child-host.js";
import {
  callPeerEngine,
  isPeerEngineReachable,
  listEngineSummaries,
  listPeerEngines,
} from "./engine-registry.js";
import type { ProjectEvent } from "./events.js";
import { isProjectsEnabled } from "./feature-flag.js";
import { deliverProjectEvents, ensureWorkerPrSubscriptions } from "./listening.js";
import { composeProjectNotice, type ProjectNoticeUpdate } from "./notices.js";
import { childHostFor } from "./project-service.js";
import { listProjectRecords, mutateProject, readProject } from "./project-store.js";
import { trackWorkerPullRequest } from "./pull-requests.js";
import type { ProjectChildRecord, ProjectRecord } from "./types.js";

type PendingObservation = {
  projectId: string;
  childId: string;
  observation: ChildObservation | null;
};

const chains = new Map<string, Promise<void>>();
const pending = new Map<string, PendingObservation>();

function noticeCoalesceKey(projectId: string): string {
  return `project-notice:${projectId}`;
}

function noticeEvent(status: string): ProjectNoticeUpdate["event"] {
  if (status === "failed") {
    return "failed";
  }
  if (status === "cancelled" || status === "interrupted") {
    return "stopped";
  }
  return "finished";
}

/** Hands child reports to the orchestrator: a new turn when idle, else one coalesced queued turn. */
export async function deliverProjectNotice(
  record: ProjectRecord,
  updates: ProjectNoticeUpdate[]
): Promise<void> {
  if (updates.length === 0) {
    return;
  }
  const workspace = await getWorkspaceById(record.orchestrator.workspaceId);
  if (!workspace) {
    return;
  }
  await agentRuntimeManager.deliverNotice(workspace, record.orchestrator.conversationId, {
    coalesceKey: noticeCoalesceKey(record.id),
    compose: (existing) => composeProjectNotice(existing?.text ?? null, updates),
  });
}

type ChildPatch = Partial<ProjectChildRecord>;

/**
 * Decides what one observation means for a child: report a finished turn,
 * a failure, a stop the orchestrator did not cause, or a new request for a
 * human. Reports are keyed on the child's event sequence so each turn is
 * announced once, including across engine restarts.
 */
async function evaluateObservation(
  child: ProjectChildRecord,
  observation: ChildObservation
): Promise<{ patch: ChildPatch; update: ProjectNoticeUpdate | null }> {
  const patch: ChildPatch = {};
  let update: ProjectNoticeUpdate | null = null;
  if (!observation.exists) {
    return { patch, update };
  }
  if (observation.status !== child.lastStatus) {
    patch.lastStatus = observation.status;
  }
  if (observation.lastError !== child.lastError) {
    patch.lastError = observation.lastError;
  }
  if (isProjectChildBusy(observation.status)) {
    // Only a turn that started after the orchestrator's stop settled ends the
    // suppression; an older busy snapshot must not re-enable reports.
    if (
      child.suppressReports &&
      child.suppressedThroughSeq != null &&
      observation.lastEventSeq > child.suppressedThroughSeq
    ) {
      patch.suppressReports = false;
      patch.suppressedThroughSeq = null;
    }
    if (observation.attention && observation.attention.id !== child.lastAttentionId) {
      patch.lastAttentionId = observation.attention.id;
      update = {
        name: child.name,
        event: "needs_attention",
        status: observation.status,
        detail: `${observation.attention.kind === "permission" ? "Permission request" : "Question"}: ${observation.attention.title}. A human has to answer it in the agent's chat.`,
      };
    }
    return { patch, update };
  }
  if (observation.lastEventSeq <= child.lastReportedSeq) {
    return { patch, update };
  }
  patch.lastReportedSeq = observation.lastEventSeq;
  let afterSeq = child.lastReportedSeq;
  if (child.suppressReports) {
    if (
      child.suppressedThroughSeq == null ||
      observation.lastEventSeq <= child.suppressedThroughSeq
    ) {
      return { patch, update };
    }
    afterSeq = Math.max(afterSeq, child.suppressedThroughSeq);
  }
  const digest = await childHostFor(child.engineId).digestSince(
    { workspaceId: child.workspaceId, conversationId: child.conversationId },
    afterSeq,
    observation.lastEventSeq
  );
  if (child.suppressReports) {
    // Trailing events of the stopped turn stay quiet; a fresh user turn (say a
    // human typing into the child directly) ends the suppression.
    if (!digest.startedTurn) {
      return { patch, update };
    }
    patch.suppressReports = false;
    patch.suppressedThroughSeq = null;
  }
  if (!digest.hadTurn) {
    return { patch, update };
  }
  const event = noticeEvent(observation.status);
  const turns = Math.max(1, digest.turnsEnded ?? 1);
  if (event === "finished") {
    patch.turnsCompleted = child.turnsCompleted + turns;
  }
  if (digest.replyPreview) {
    patch.lastReplyPreview = digest.replyPreview;
  }
  update = {
    name: child.name,
    event,
    status: observation.status,
    detail:
      event === "failed"
        ? `${observation.lastError ?? "The turn failed."}${digest.replyPreview ? `\nLast reply: ${digest.replyPreview}` : ""}`
        : event === "stopped"
          ? `Stopped outside your control.${digest.replyPreview ? `\nLast reply: ${digest.replyPreview}` : ""}`
          : turns > 1 && digest.replyPreview
            ? `${turns} turns finished since the last update. Latest reply:\n${digest.replyPreview}`
            : digest.replyPreview,
  };
  return { patch, update };
}

async function processChild(entry: PendingObservation): Promise<void> {
  if (!(await isProjectsEnabled())) {
    return;
  }
  const record = await readProject(entry.projectId);
  const child = record?.children.find((candidate) => candidate.id === entry.childId);
  if (!record || !child || child.deletedAt != null) {
    return;
  }
  const observation =
    entry.observation ??
    (await childHostFor(child.engineId).observe({
      workspaceId: child.workspaceId,
      conversationId: child.conversationId,
    }));
  const { patch, update } = await evaluateObservation(child, observation);
  if (Object.keys(patch).length === 0 && !update) {
    return;
  }
  let updated = await mutateProject(
    entry.projectId,
    (current) => ({
      ...current,
      children: current.children.map((candidate) =>
        candidate.id === child.id
          ? { ...candidate, ...patch, lastSeenAt: Date.now() }
          : candidate
      ),
    }),
    { touch: false }
  );
  if (update && (update.event === "finished" || update.event === "failed") && child.branch && child.githubRepo) {
    const line = await followWorkerPullRequest(entry.projectId, child.id, update.event === "finished");
    if (line) {
      update.detail = `${update.detail ?? ""}\n${line}`.trim();
      updated = (await readProject(entry.projectId)) ?? updated;
    }
  }
  if (update && child.engineId !== PROJECT_HOME_ENGINE_ID && update.event !== "needs_attention") {
    // Bring back what the agent wrote in its engine's copy of the context before the coordinator looks.
    const line = await syncPeerContext(entry.projectId, child.engineId);
    if (line) {
      update.detail = `${update.detail ?? ""}\n${line}`.trim();
    }
  }
  if (update) {
    if (child.kind === "helper" && update.event !== "needs_attention") {
      // Save the answer first, so the file the update points to exists when the orchestrator reads it.
      const { afterHelperReported } = await import("./helpers.js");
      const savedTo = await afterHelperReported(entry.projectId, child.id).catch((error) => {
        console.warn(`[projects] could not finish helper ${child.name}:`, error instanceof Error ? error.message : error);
        return null;
      });
      if (savedTo) {
        update.detail = `${update.detail ?? ""}\nFull answer: ${savedTo} in the Project context.`.trim();
        updated = (await readProject(entry.projectId)) ?? updated;
      }
    }
    await deliverProjectNotice(updated, [update]);
  }
}

const CONTEXT_SYNC_TIMEOUT_MS = 60_000;
const CONTEXT_SYNC_INTERVAL_MS = 60_000;
const contextSyncAttemptAt = new Map<string, number>();

async function runPeerContextSync(projectId: string, engineId: string): Promise<void> {
  contextSyncAttemptAt.set(`${projectId}:${engineId}`, Date.now());
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const { syncProjectContextWithPeer } = await import("./context-sync.js");
    await Promise.race([
      syncProjectContextWithPeer(projectId, engineId),
      new Promise<void>((resolve) => {
        timer = setTimeout(resolve, CONTEXT_SYNC_TIMEOUT_MS);
      }),
    ]);
  } catch (error) {
    console.warn(
      `[projects] could not sync the context of ${projectId} with engine ${engineId}:`,
      error instanceof Error ? error.message : error
    );
  } finally {
    if (timer) {
      clearTimeout(timer);
    }
  }
}

/**
 * Syncs a Project's context with a peer after one of its agents' turns and
 * returns a line for the coordinator naming everything that came back since
 * it was last told (periodic syncs during the turn included).
 */
async function syncPeerContext(projectId: string, engineId: string): Promise<string | null> {
  await runPeerContextSync(projectId, engineId);
  const { describeContextSync, takeUnreportedContextSync } = await import("./context-sync.js");
  const engines = await listEngineSummaries();
  return describeContextSync(
    takeUnreportedContextSync(projectId, engineId),
    engines.find((engine) => engine.id === engineId)?.label ?? engineId
  );
}

/** Keeps peers' copies of the context current (notes.md, docs) while their agents work. */
async function syncPeerContextsDue(records: readonly ProjectRecord[]): Promise<void> {
  const { contextSyncedAt } = await import("./context-sync.js");
  const now = Date.now();
  for (const record of records) {
    const engines = new Set(
      record.children
        .filter((child) => child.deletedAt == null && child.archivedAt == null && child.engineId !== PROJECT_HOME_ENGINE_ID)
        .map((child) => child.engineId)
    );
    for (const engineId of engines) {
      const key = `${record.id}:${engineId}`;
      const last = Math.max(contextSyncedAt(record.id, engineId), contextSyncAttemptAt.get(key) ?? 0);
      if (isPeerEngineReachable(engineId) && now - last >= CONTEXT_SYNC_INTERVAL_MS) {
        void runPeerContextSync(record.id, engineId);
      }
    }
  }
}

const PR_TRACKING_TIMEOUT_MS = 10_000;

/**
 * After a worker's turn: find its PR (or open one when it pushed without one)
 * and follow it, so the orchestrator hears about the PR in the same update.
 */
async function followWorkerPullRequest(projectId: string, childId: string, allowCreate: boolean): Promise<string | null> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const tracked = await Promise.race([
      trackWorkerPullRequest(projectId, childId, { allowCreate }),
      new Promise<null>((resolve) => {
        timer = setTimeout(() => resolve(null), PR_TRACKING_TIMEOUT_MS);
      }),
    ]);
    if (!tracked) {
      return null;
    }
    await ensureWorkerPrSubscriptions(projectId, childId, tracked.pr);
    const { pr } = tracked;
    const how = tracked.created
      ? "opened by the Project because the agent pushed without one"
      : pr.state === "open"
        ? pr.draft
          ? "open, draft"
          : "open"
        : pr.state;
    return `Pull request: ${pr.repo}#${pr.number} (${how}) ${pr.url}`;
  } catch (error) {
    console.warn(
      `[projects] could not check the pull request for child ${childId}:`,
      error instanceof Error ? error.message : error
    );
    return null;
  } finally {
    if (timer) {
      clearTimeout(timer);
    }
  }
}

/** Runs `task` after everything already queued for the child. `task` must not throw. */
function enqueueChildTask(key: string, task: () => Promise<void>): Promise<void> {
  const previous = chains.get(key) ?? Promise.resolve();
  const next = previous.catch(() => undefined).then(task);
  chains.set(key, next);
  void next.finally(() => {
    if (chains.get(key) === next) {
      chains.delete(key);
    }
  });
  return next;
}

/** Serializes processing per child and keeps only the newest pending observation. */
export function scheduleProjectChildObservation(
  projectId: string,
  childId: string,
  observation: ChildObservation | null
): Promise<void> {
  const key = `${projectId}:${childId}`;
  const alreadyQueued = pending.has(key);
  pending.set(key, { projectId, childId, observation });
  if (alreadyQueued) {
    return chains.get(key) ?? Promise.resolve();
  }
  return enqueueChildTask(key, async () => {
    const entry = pending.get(key);
    pending.delete(key);
    if (!entry) {
      return;
    }
    await processChild(entry).catch((error) => {
      console.warn(
        `[projects] could not process an update for child ${childId}:`,
        error instanceof Error ? error.message : error
      );
    });
  });
}

/**
 * Looks at a child just added to its Project: its first turn starts before
 * the record lists it, and events from before then were ignored.
 */
export function observeNewProjectChild(projectId: string, childId: string): void {
  void scheduleProjectChildObservation(projectId, childId, null);
}

/**
 * Turns reports back on for a child whose caller stopped waiting for it, and
 * reports what it did after `fromSeq`, including a turn that ended while
 * reports were off. Runs in the child's slot so that an observation already
 * in flight cannot swallow that turn.
 */
export async function resumeProjectChildReports(projectId: string, childId: string, fromSeq: number): Promise<void> {
  let observed: Promise<void> = Promise.resolve();
  await enqueueChildTask(`${projectId}:${childId}`, async () => {
    try {
      await mutateProject(
        projectId,
        (current) => ({
          ...current,
          children: current.children.map((candidate) =>
            candidate.id === childId
              ? {
                  ...candidate,
                  suppressReports: false,
                  suppressedThroughSeq: null,
                  lastReportedSeq: Math.min(candidate.lastReportedSeq, fromSeq),
                }
              : candidate
          ),
        }),
        { touch: false }
      );
    } catch (error) {
      console.warn(`[projects] could not resume reports for child ${childId}:`, error instanceof Error ? error.message : error);
    }
    observed = scheduleProjectChildObservation(projectId, childId, null);
  });
  await observed;
}

/** Resolves once every scheduled observation has been processed. */
export async function settleProjectWatcher(): Promise<void> {
  while (chains.size > 0) {
    await Promise.all([...chains.values()]);
  }
}

const PEER_POLL_TICK_MS = 2_000;
const PEER_POLL_BUSY_MS = 2_000;
const PEER_POLL_RECENT_MS = 5_000;
const PEER_POLL_IDLE_MS = 30_000;
const PEER_POLL_ERROR_MS = 10_000;
const PEER_RECENT_WINDOW_MS = 5 * 60_000;
const PEER_HEARTBEAT_MS = 30_000;
const PEER_HEARTBEAT_TIMEOUT_MS = 5_000;

const peerNextPollAt = new Map<string, number>();
const peerPollsInFlight = new Set<string>();

function nextPeerPollDelay(observation: ChildObservation, now: number): number {
  if (isProjectChildBusy(observation.status) || observation.queued > 0) {
    return PEER_POLL_BUSY_MS;
  }
  if (observation.updatedAt != null && now - observation.updatedAt < PEER_RECENT_WINDOW_MS) {
    return PEER_POLL_RECENT_MS;
  }
  return PEER_POLL_IDLE_MS;
}

async function pollPeerChild(
  record: ProjectRecord,
  child: ProjectChildRecord,
  force: boolean
): Promise<void> {
  const key = `${record.id}:${child.id}`;
  if (peerPollsInFlight.has(key) || (!force && (peerNextPollAt.get(key) ?? 0) > Date.now())) {
    return;
  }
  peerPollsInFlight.add(key);
  try {
    const observation = await childHostFor(child.engineId).observe({
      workspaceId: child.workspaceId,
      conversationId: child.conversationId,
    });
    peerNextPollAt.set(key, Date.now() + nextPeerPollDelay(observation, Date.now()));
    await scheduleProjectChildObservation(record.id, child.id, observation);
  } catch {
    peerNextPollAt.set(key, Date.now() + PEER_POLL_ERROR_MS);
  } finally {
    peerPollsInFlight.delete(key);
  }
}

/**
 * Peer engines cannot push store events here, so their children are polled:
 * every 2s while working or queued, 5s shortly after activity, 30s when quiet.
 * Children on engines that stopped answering wait for the heartbeat.
 * `force` polls every remote child now regardless of schedule.
 */
export async function pollProjectPeerChildren(options?: { force?: boolean }): Promise<void> {
  if (!(await isProjectsEnabled())) {
    return;
  }
  const force = options?.force === true;
  const polls: Promise<void>[] = [];
  const records = await listProjectRecords();
  for (const record of records) {
    for (const child of record.children) {
      if (child.deletedAt != null || child.engineId === PROJECT_HOME_ENGINE_ID) {
        continue;
      }
      if (force || isPeerEngineReachable(child.engineId)) {
        polls.push(pollPeerChild(record, child, force));
      }
    }
  }
  await Promise.all(polls);
  await syncPeerContextsDue(records);
}

/** Refreshes every peer's online status so polling resumes once it answers again. */
export async function heartbeatProjectPeerEngines(): Promise<void> {
  if (!(await isProjectsEnabled())) {
    return;
  }
  await Promise.all(
    (await listPeerEngines()).map((engine) =>
      callPeerEngine(engine.id, (client) => client.info(PEER_HEARTBEAT_TIMEOUT_MS)).catch(
        () => undefined
      )
    )
  );
}

/** Re-checks every live child and drains idle orchestrators that still hold notices. */
export async function kickProjectWatcher(): Promise<void> {
  if (!(await isProjectsEnabled())) {
    return;
  }
  const records = await listProjectRecords();
  for (const record of records) {
    for (const child of record.children) {
      // Remote children are picked up by the first peer poll.
      if (child.deletedAt == null && child.engineId === PROJECT_HOME_ENGINE_ID) {
        void scheduleProjectChildObservation(record.id, child.id, null);
      }
    }
    const workspace = await getWorkspaceById(record.orchestrator.workspaceId);
    if (workspace) {
      await agentRuntimeManager
        .drainOneQueuedPrompt(workspace, record.orchestrator.conversationId)
        .catch(() => undefined);
    }
  }
}

const RESTART_EVENT: ProjectEvent = {
  source: "engine",
  attrs: { event: "restarted" },
  body: "This engine restarted while you were in the middle of a turn, and that turn was cut off. Check where things stand (project_list_agents, notes.md) and carry on from there. Agents a restart stopped show as interrupted and continue when you message them.",
  label: "Engine restarted",
};

/**
 * After the boot sweep: a coordinator whose turn the restart cut off would
 * wait for the user forever. It is told the engine restarted, which also
 * starts anything queued for it. Only turns this boot interrupted are
 * resumed, not ones left interrupted long ago.
 */
export async function resumeProjectsCutOffByRestart(interrupted: readonly AgentConversationRecord[]): Promise<void> {
  if (!(await isProjectsEnabled().catch(() => false))) {
    return;
  }
  for (const conversation of interrupted) {
    const origin = conversation.origin;
    if (origin?.kind !== "project-orchestrator") {
      continue;
    }
    try {
      const record = await readProject(origin.projectId);
      if (!record || record.archivedAt != null || record.orchestrator.conversationId !== conversation.id) {
        continue;
      }
      const current = await readConversationRecord(record.orchestrator.workspaceId, conversation.id);
      if (current?.status !== "interrupted") {
        continue;
      }
      await deliverProjectEvents(record, [RESTART_EVENT]);
    } catch (error) {
      console.warn(
        `[projects] could not resume the coordinator of ${origin.projectId} after the restart:`,
        error instanceof Error ? error.message : error
      );
    }
  }
}

let stopWatching: (() => void) | null = null;

export function startProjectWatcher(): () => void {
  if (stopWatching) {
    return stopWatching;
  }
  const unsubscribe = subscribeAgentStoreEvents((event) => {
    if (event.type !== "conversation") {
      return;
    }
    const origin = event.conversation.origin;
    if (origin?.kind !== "project-child" || origin.peerTokenId) {
      return;
    }
    void scheduleProjectChildObservation(
      origin.projectId,
      origin.childId,
      observeConversationRecord(event.conversation)
    );
  });
  let polling = false;
  const pollTimer = setInterval(() => {
    if (polling) {
      return;
    }
    polling = true;
    void pollProjectPeerChildren()
      .catch(() => undefined)
      .finally(() => {
        polling = false;
      });
  }, PEER_POLL_TICK_MS);
  const heartbeatTimer = setInterval(() => {
    void heartbeatProjectPeerEngines().catch(() => undefined);
  }, PEER_HEARTBEAT_MS);
  pollTimer.unref?.();
  heartbeatTimer.unref?.();
  stopWatching = () => {
    unsubscribe();
    clearInterval(pollTimer);
    clearInterval(heartbeatTimer);
    stopWatching = null;
  };
  void kickProjectWatcher().catch((error) => {
    console.warn(
      "[projects] startup check failed:",
      error instanceof Error ? error.message : error
    );
  });
  return stopWatching;
}
