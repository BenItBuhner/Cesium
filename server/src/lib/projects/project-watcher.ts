import { isProjectChildBusy } from "@cesium/core/projects";
import { agentRuntimeManager } from "../agents/runtime-manager.js";
import { subscribeAgentStoreEvents } from "../agents/session-store.js";
import { getWorkspaceById } from "../workspace-registry.js";
import {
  observeConversationRecord,
  type ChildObservation,
} from "./child-host.js";
import { isProjectsEnabled } from "./feature-flag.js";
import { composeProjectNotice, type ProjectNoticeUpdate } from "./notices.js";
import { childHostFor } from "./project-service.js";
import { listProjectRecords, mutateProject, readProject } from "./project-store.js";
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
  if (event === "finished") {
    patch.turnsCompleted = child.turnsCompleted + 1;
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
  const updated = await mutateProject(
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
  if (update) {
    await deliverProjectNotice(updated, [update]);
  }
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
  const previous = chains.get(key) ?? Promise.resolve();
  const next = previous
    .catch(() => undefined)
    .then(async () => {
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
  chains.set(key, next);
  void next.finally(() => {
    if (chains.get(key) === next) {
      chains.delete(key);
    }
  });
  return next;
}

/** Resolves once every scheduled observation has been processed. */
export async function settleProjectWatcher(): Promise<void> {
  while (chains.size > 0) {
    await Promise.all([...chains.values()]);
  }
}

/** Re-checks every live child and drains idle orchestrators that still hold notices. */
export async function kickProjectWatcher(): Promise<void> {
  if (!(await isProjectsEnabled())) {
    return;
  }
  const records = await listProjectRecords();
  for (const record of records) {
    for (const child of record.children) {
      if (child.deletedAt == null) {
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
  stopWatching = () => {
    unsubscribe();
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
