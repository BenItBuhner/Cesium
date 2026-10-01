import { formatProjectNoticeDisplay } from "@cesium/core/projects";
import { randomUUID } from "node:crypto";
import {
  listOrchestrationBoards,
  readOrchestrationBoardSnapshot,
  subscribeOrchestrationStoreEvents,
  upsertOrchestrationAssignment,
} from "../orchestration/store.js";
import type { OrchestrationAssignmentStatus, OrchestrationBoardSnapshot } from "../orchestration/types.js";
import { getWorkspaceById } from "../workspace-registry.js";
import { childHasNews, childState, lastReply } from "./cesium/features/subagents/durable-children.js";
import { CHILD_UPDATE_COALESCE_PREFIX, CHILD_UPDATE_WAKE_MAX, childReport, markChildReported } from "./child-reports.js";
import { agentRuntimeManager } from "./runtime-manager.js";
import {
  appendConversationEvents,
  listWorkspaceConversationRecords,
  readConversationRecord,
  readRecentConversationEvents,
  subscribeAgentStoreEvents,
} from "./session-store.js";
import type { AgentConversationRecord, AgentConversationStatus } from "./types.js";

/**
 * Wakes a parent whose turn has ended when one of its children finishes a
 * turn: the update arrives as one coalesced turn, the way Project
 * coordinators hear from their workers. Children are durable subagents (their
 * origin names the parent) and agents assigned on the parent's board.
 *
 * Guards against loops: each child turn is announced once (persisted, and
 * shared with `wait`, so what a wait reported is not repeated); stops the
 * parent caused stay quiet; only an idle parent that ended its turn on its own
 * is woken (not after a user Stop, a failure, or while settled); and at most
 * CHILD_UPDATE_WAKE_MAX update turns run before the user writes again.
 */

type ChildLink = {
  parentId: string;
  workspaceId: string;
  kind: "subagent" | "board";
  label: string;
  boardId?: string;
};

export type ChildUpdate = {
  name: string;
  kind: "subagent" | "board";
  status: "completed" | "failed" | "stopped";
  detail: string | null;
};

const UPDATES_TAG = "child_agent_updates";
const SUMMARY_MAX_CHARS = 600;
const RECENT_MESSAGES = 8;

const links = new Map<string, ChildLink>();
const childrenOf = new Map<string, Set<string>>();
const indexed = new Map<string, Promise<void>>();
const syncedStatus = new Map<string, AgentConversationStatus>();
const pendingChecks = new Map<string, string>();
const inFlight = new Set<string>();
const recheck = new Set<string>();

function linkChild(childId: string, link: ChildLink): boolean {
  const previous = links.get(childId);
  links.set(childId, link);
  if (previous && previous.parentId !== link.parentId) childrenOf.get(previous.parentId)?.delete(childId);
  const siblings = childrenOf.get(link.parentId) ?? new Set<string>();
  const added = !siblings.has(childId);
  siblings.add(childId);
  childrenOf.set(link.parentId, siblings);
  return added;
}

/** Board children of one snapshot; returns the newly linked ones. */
function indexBoard(snapshot: OrchestrationBoardSnapshot): string[] {
  const head = snapshot.board.headConversationId;
  if (!head) return [];
  const added: string[] = [];
  for (const assignment of snapshot.assignments) {
    const issue = snapshot.issues.find((candidate) => candidate.id === assignment.issueId);
    const isNew = linkChild(assignment.conversationId, {
      parentId: head,
      workspaceId: snapshot.board.workspaceId,
      kind: "board",
      label: issue ? `Issue: ${issue.title}` : assignment.conversationId,
      boardId: snapshot.board.id,
    });
    if (isNew) added.push(assignment.conversationId);
  }
  return added;
}

function ensureIndexed(workspaceId: string): Promise<void> {
  const existing = indexed.get(workspaceId);
  if (existing) return existing;
  const scan = (async () => {
    const records = await listWorkspaceConversationRecords(workspaceId).catch(() => [] as AgentConversationRecord[]);
    for (const record of records) {
      if (record.origin?.kind === "subagent") {
        linkChild(record.id, {
          parentId: record.origin.parentConversationId,
          workspaceId,
          kind: "subagent",
          label: record.origin.path,
        });
      }
    }
    const { boards } = await listOrchestrationBoards(workspaceId).catch(() => ({ boards: [] as Array<{ id: string }> }));
    for (const board of boards) {
      const snapshot = await readOrchestrationBoardSnapshot(board.id).catch(() => null);
      if (snapshot) indexBoard(snapshot);
    }
  })();
  indexed.set(workspaceId, scan);
  return scan;
}

/** The assignment status a board child's conversation status means, if it means one. */
export function assignmentStatusFor(
  record: Pick<AgentConversationRecord, "status" | "queuedPrompts" | "lastEventSeq">
): OrchestrationAssignmentStatus | null {
  switch (record.status) {
    case "idle":
      if ((record.queuedPrompts?.length ?? 0) > 0) return "running";
      return record.lastEventSeq > 0 ? "completed" : null;
    case "running":
    case "pause_requested":
    case "pausing":
      return "running";
    case "paused":
    case "awaiting_permission":
    case "awaiting_question":
      return "waiting";
    case "failed":
      return "failed";
    case "cancelled":
    case "interrupted":
      return "cancelled";
    default:
      return null;
  }
}

/** Keeps a board assignment's status in step with its child conversation. */
async function syncAssignment(record: AgentConversationRecord, link: ChildLink): Promise<void> {
  if (!link.boardId || syncedStatus.get(record.id) === record.status) return;
  syncedStatus.set(record.id, record.status);
  const next = assignmentStatusFor(record);
  if (!next) return;
  const snapshot = await readOrchestrationBoardSnapshot(link.boardId).catch(() => null);
  const assignment = snapshot?.assignments.find((candidate) => candidate.conversationId === record.id);
  if (!snapshot || !assignment) return;
  if (assignment.status === next && assignment.lastKnownConversationStatus === record.status) return;
  await upsertOrchestrationAssignment(
    link.boardId,
    { ...assignment, status: next, lastKnownConversationStatus: record.status },
    { type: "system" }
  );
}

function sanitize(detail: string): string {
  return detail.replace(/<(\/?)agent\b/gi, "< $1agent").replace(new RegExp(`</?${UPDATES_TAG}>`, "gi"), "");
}

const BLOCK_PATTERN = /<agent name="([^"]+)" kind="(subagent|board)" status="([^"]*)">\n?([\s\S]*?)\n?<\/agent>/g;

/**
 * The update turn's text, or the existing queued one with these updates
 * folded in: a newer update for the same agent replaces its older block.
 */
export function composeChildUpdateNotice(
  existingText: string | null,
  updates: readonly ChildUpdate[]
): { text: string; displayContent: string } {
  const merged: ChildUpdate[] = [];
  for (const match of existingText?.matchAll(BLOCK_PATTERN) ?? []) {
    merged.push({
      name: match[1]!,
      kind: match[2] as ChildUpdate["kind"],
      status: match[3] as ChildUpdate["status"],
      detail: match[4] ?? null,
    });
  }
  for (const update of updates) {
    const index = merged.findIndex((block) => block.name === update.name);
    if (index >= 0) merged.splice(index, 1);
    merged.push(update);
  }
  const readers = [
    merged.some((block) => block.kind === "subagent") ? "read_subagent_transcript for a subagent" : null,
    merged.some((block) => block.kind === "board") ? "orchestration_read_agent_transcript for a board agent" : null,
  ].filter(Boolean);
  const text = [
    `<${UPDATES_TAG}>`,
    `Automatic update: agents you started finished a turn after your turn ended. Replies are shortened; ${readers.join(" or ")} reads the whole transcript. Act on what needs it; if nothing does, end your turn with a short note.`,
    ...merged.map(
      (block) =>
        `<agent name="${block.name}" kind="${block.kind}" status="${block.status}">\n${block.detail?.trim() ? sanitize(block.detail.trim()) : "(no reply text)"}\n</agent>`
    ),
    `</${UPDATES_TAG}>`,
  ].join("\n");
  return { text, displayContent: formatProjectNoticeDisplay(merged.map((block) => block.name)) };
}

function settledParent(record: AgentConversationRecord): boolean {
  if (record.settledAt == null) return false;
  return record.settledUntil == null || record.settledUntil > Date.now();
}

async function describe(child: AgentConversationRecord, link: ChildLink): Promise<ChildUpdate> {
  const state = childState(child);
  const status = state === "completed" ? "completed" : state === "errored" ? "failed" : "stopped";
  const events = await readRecentConversationEvents(child.workspaceId, child.id, RECENT_MESSAGES).catch(() => []);
  const reply = lastReply(events);
  const detail =
    status === "failed" && child.lastError ? `Error: ${child.lastError}${reply ? `\nLast reply: ${reply}` : ""}` : reply;
  return {
    name: link.label,
    kind: link.kind,
    status,
    detail: detail ? detail.slice(0, SUMMARY_MAX_CHARS) : null,
  };
}

/** Delivers whatever the parent's children did that it has not heard yet, if the parent may be woken. */
async function checkParent(parentId: string, workspaceId: string): Promise<void> {
  const parent = await readConversationRecord(workspaceId, parentId);
  if (
    !parent ||
    parent.config.backendId !== "cesium-agent" ||
    parent.status !== "idle" ||
    (parent.queuedPrompts?.length ?? 0) > 0 ||
    settledParent(parent)
  ) {
    return;
  }
  const news: Array<{ child: AgentConversationRecord; link: ChildLink }> = [];
  for (const childId of childrenOf.get(parentId) ?? []) {
    const link = links.get(childId);
    const child = await readConversationRecord(workspaceId, childId);
    if (!link || !child) continue;
    const state = childState(child);
    if (state === "running" || state === "needs_attention") continue;
    if (await childHasNews(child)) news.push({ child, link });
  }
  if (news.length === 0) return;
  const workspace = await getWorkspaceById(workspaceId);
  if (!workspace) return;
  const wakes = agentRuntimeManager.childUpdateWakeState(parentId);
  if (wakes.count >= CHILD_UPDATE_WAKE_MAX) {
    if (!wakes.capNoticed) {
      agentRuntimeManager.noteChildUpdateCap(parentId);
      await appendConversationEvents(workspaceId, parentId, [
        {
          eventId: randomUUID(),
          conversationId: parentId,
          kind: "system",
          level: "info",
          text: `Child agents woke this chat ${CHILD_UPDATE_WAKE_MAX} times in a row, so further updates wait for you (or for a wait in your next turn).`,
        },
      ]);
    }
    return;
  }
  const updates = await Promise.all(news.map(({ child, link }) => describe(child, link)));
  for (const { child } of news) await markChildReported(child.id, child.lastEventSeq);
  await agentRuntimeManager.deliverNotice(workspace, parentId, {
    coalesceKey: `${CHILD_UPDATE_COALESCE_PREFIX}${parentId}`,
    compose: (existing) => composeChildUpdateNotice(existing?.text ?? null, updates),
  });
}

function scheduleCheck(parentId: string, workspaceId: string): void {
  if (inFlight.has(parentId)) {
    recheck.add(parentId);
    return;
  }
  if (pendingChecks.has(parentId)) return;
  pendingChecks.set(parentId, workspaceId);
  setImmediate(() => {
    pendingChecks.delete(parentId);
    inFlight.add(parentId);
    void checkParent(parentId, workspaceId)
      .catch((error) => {
        console.warn("[child-updates] delivering child updates failed:", error instanceof Error ? error.message : error);
      })
      .finally(() => {
        inFlight.delete(parentId);
        if (recheck.delete(parentId)) scheduleCheck(parentId, workspaceId);
      });
  });
}

async function onConversation(record: AgentConversationRecord): Promise<void> {
  await ensureIndexed(record.workspaceId);
  if (record.origin?.kind === "subagent") {
    linkChild(record.id, {
      parentId: record.origin.parentConversationId,
      workspaceId: record.workspaceId,
      kind: "subagent",
      label: record.origin.path,
    });
  }
  const link = links.get(record.id);
  if (link) {
    if (link.kind === "board") await syncAssignment(record, link);
    const state = childState(record);
    if (state === "running" || state === "needs_attention") {
      // A child first seen mid-turn starts reported from here, so that turn's end is news.
      await childReport(record);
    } else {
      scheduleCheck(link.parentId, link.workspaceId);
    }
  }
  if (record.status === "idle" && childrenOf.get(record.id)?.size) {
    scheduleCheck(record.id, record.workspaceId);
  }
}

let started = false;

export function startChildUpdateWakeListener(): void {
  if (started) return;
  started = true;
  subscribeAgentStoreEvents((event) => {
    if (event.type !== "conversation") return;
    void onConversation(event.conversation).catch((error) => {
      console.warn("[child-updates] handling a conversation update failed:", error instanceof Error ? error.message : error);
    });
  });
  subscribeOrchestrationStoreEvents((event) => {
    if (event.type !== "board") return;
    for (const childId of indexBoard(event.snapshot)) {
      const link = links.get(childId)!;
      void readConversationRecord(link.workspaceId, childId)
        .then((record) => (record ? onConversation(record) : undefined))
        .catch(() => undefined);
    }
  });
}
