import { randomUUID } from "node:crypto";
import { del } from "../../cache/kv.js";
import { publish, subscribeSync } from "../../cache/pubsub.js";
import { getStorage } from "../../storage/runtime.js";
import { RAIL_ALL_FIRST_PAGE_CACHE_KEY } from "../agents/cache-keys.js";
import type { AgentBackendId } from "../agents/types.js";
import type { WorkspaceRecord } from "../workspace-registry.js";
import {
  createDefaultOrchestrationBoardSettings,
  type OrchestrationActor,
  type OrchestrationAssignmentRecord,
  type OrchestrationAssignmentStatus,
  type OrchestrationBoardListResult,
  type OrchestrationBoardRecord,
  type OrchestrationBoardSnapshot,
  type OrchestrationColumnId,
  type OrchestrationEventKind,
  type OrchestrationEventRecord,
  type OrchestrationIssuePriority,
  type OrchestrationIssueRecord,
} from "./types.js";

const ORCHESTRATION_STORE_EVENTS_CHANNEL = "opencursor:orchestration:store-events";

export type OrchestrationStoreEvent =
  | {
      type: "board";
      workspaceId: string;
      boardId: string;
      snapshot: OrchestrationBoardSnapshot;
    }
  | { type: "board_deleted"; workspaceId: string; boardId: string };

export function subscribeOrchestrationStoreEvents(
  handler: (event: OrchestrationStoreEvent) => void
): () => void {
  return subscribeSync<OrchestrationStoreEvent>(
    ORCHESTRATION_STORE_EVENTS_CHANNEL,
    handler
  );
}

async function publishOrchestrationStoreEvent(
  event: OrchestrationStoreEvent
): Promise<void> {
  await publish(ORCHESTRATION_STORE_EVENTS_CHANNEL, event);
}

function sortSnapshot(snapshot: OrchestrationBoardSnapshot): OrchestrationBoardSnapshot {
  return {
    board: snapshot.board,
    issues: [...snapshot.issues].sort(
      (a, b) =>
        a.columnId.localeCompare(b.columnId) ||
        a.sortOrder - b.sortOrder ||
        a.createdAt - b.createdAt
    ),
    assignments: [...snapshot.assignments].sort(
      (a, b) => a.createdAt - b.createdAt || a.id.localeCompare(b.id)
    ),
    events: [...snapshot.events].sort(
      (a, b) => a.createdAt - b.createdAt || a.id.localeCompare(b.id)
    ),
  };
}

export async function listOrchestrationBoards(
  workspaceId: string
): Promise<OrchestrationBoardListResult> {
  const storage = await getStorage();
  return storage.listOrchestrationBoards(workspaceId);
}

export async function readOrchestrationBoardSnapshot(
  boardId: string
): Promise<OrchestrationBoardSnapshot | null> {
  const storage = await getStorage();
  const snapshot = await storage.getOrchestrationBoardSnapshot(boardId);
  return snapshot ? sortSnapshot(snapshot) : null;
}

export async function findOrchestrationBoardForHeadConversation(
  workspaceId: string,
  conversationId: string
): Promise<OrchestrationBoardSnapshot | null> {
  const { boards } = await listOrchestrationBoards(workspaceId);
  for (const board of boards) {
    if (board.headConversationId !== conversationId) {
      continue;
    }
    const snapshot = await readOrchestrationBoardSnapshot(board.id);
    if (snapshot) {
      return snapshot;
    }
  }
  return null;
}

export async function listOrchestrationChildConversationIds(
  workspaceId: string
): Promise<Set<string>> {
  const ids = new Set<string>();
  const { boards } = await listOrchestrationBoards(workspaceId);
  await Promise.all(
    boards.map(async (board) => {
      const snapshot = await readOrchestrationBoardSnapshot(board.id);
      if (!snapshot || snapshot.board.workspaceId !== workspaceId) {
        return;
      }
      for (const assignment of snapshot.assignments) {
        ids.add(assignment.conversationId);
      }
    })
  );
  return ids;
}

export async function findOrchestrationAssignmentForConversation(
  workspaceId: string,
  conversationId: string
): Promise<OrchestrationAssignmentRecord | null> {
  const { boards } = await listOrchestrationBoards(workspaceId);
  for (const board of boards) {
    const snapshot = await readOrchestrationBoardSnapshot(board.id);
    if (!snapshot || snapshot.board.workspaceId !== workspaceId) {
      continue;
    }
    const assignment = snapshot.assignments.find(
      (candidate) => candidate.conversationId === conversationId
    );
    if (assignment) {
      return assignment;
    }
  }
  return null;
}

const ACTIVE_ORCHESTRATION_ASSIGNMENT_STATUSES: OrchestrationAssignmentStatus[] = [
  "assigned",
  "running",
  "waiting",
  "blocked",
  "reviewing",
];

export function orchestrationBoardHasActiveWork(
  snapshot: OrchestrationBoardSnapshot
): boolean {
  if (snapshot.issues.some((issue) => issue.columnId !== "done")) {
    return true;
  }
  return snapshot.assignments.some((assignment) =>
    ACTIVE_ORCHESTRATION_ASSIGNMENT_STATUSES.includes(assignment.status)
  );
}

export function orchestrationBoardNeedsManagement(
  snapshot: OrchestrationBoardSnapshot,
  options?: { includeEmptyBoard?: boolean }
): boolean {
  if (options?.includeEmptyBoard && snapshot.issues.length === 0) {
    return true;
  }
  return orchestrationBoardHasActiveWork(snapshot);
}

export async function resolveOrCreateOrchestrationBoardForHeadConversation(input: {
  workspace: WorkspaceRecord;
  conversationId: string;
  title?: string;
  allowedBackendIds: AgentBackendId[];
}): Promise<OrchestrationBoardSnapshot> {
  const linked = await findOrchestrationBoardForHeadConversation(
    input.workspace.id,
    input.conversationId
  );
  if (linked) {
    return linked;
  }

  const { boards } = await listOrchestrationBoards(input.workspace.id);
  const reusableBoard = boards
    .filter((board) => !board.archivedAt && !board.headConversationId)
    .sort((a, b) => b.updatedAt - a.updatedAt)[0];
  if (reusableBoard) {
    return mutateOrchestrationBoardSnapshot(reusableBoard.id, (snapshot) => ({
      ...snapshot,
      board: {
        ...snapshot.board,
        headConversationId: input.conversationId,
        updatedAt: Date.now(),
      },
    }));
  }

  return createOrchestrationBoard({
    workspace: input.workspace,
    title: input.title,
    headConversationId: input.conversationId,
    allowedBackendIds: input.allowedBackendIds,
  });
}

export async function saveOrchestrationBoardSnapshot(
  snapshot: OrchestrationBoardSnapshot
): Promise<OrchestrationBoardSnapshot> {
  const sorted = sortSnapshot(snapshot);
  const storage = await getStorage();
  await storage.saveOrchestrationBoardSnapshot(sorted);
  await del(RAIL_ALL_FIRST_PAGE_CACHE_KEY);
  await publishOrchestrationStoreEvent({
    type: "board",
    workspaceId: sorted.board.workspaceId,
    boardId: sorted.board.id,
    snapshot: sorted,
  });
  return sorted;
}

export async function deleteOrchestrationBoard(boardId: string): Promise<void> {
  const storage = await getStorage();
  const snapshot = await storage.getOrchestrationBoardSnapshot(boardId);
  await storage.deleteOrchestrationBoard(boardId);
  if (snapshot) {
    await publishOrchestrationStoreEvent({
      type: "board_deleted",
      workspaceId: snapshot.board.workspaceId,
      boardId,
    });
  }
}

export function createOrchestrationEvent(input: {
  boardId: string;
  issueId?: string | null;
  assignmentId?: string | null;
  kind: OrchestrationEventKind;
  actor?: OrchestrationActor;
  message: string;
  payload?: Record<string, unknown>;
  now?: number;
}): OrchestrationEventRecord {
  return {
    schemaVersion: 1,
    id: randomUUID(),
    boardId: input.boardId,
    issueId: input.issueId ?? null,
    assignmentId: input.assignmentId ?? null,
    kind: input.kind,
    actor: input.actor ?? { type: "system" },
    message: input.message,
    payload: input.payload ?? {},
    createdAt: input.now ?? Date.now(),
  };
}

export async function createOrchestrationBoard(input: {
  workspace: WorkspaceRecord;
  title?: string;
  description?: string;
  headConversationId?: string | null;
  allowedBackendIds: AgentBackendId[];
}): Promise<OrchestrationBoardSnapshot> {
  const now = Date.now();
  const board: OrchestrationBoardRecord = {
    schemaVersion: 1,
    id: randomUUID(),
    workspaceId: input.workspace.id,
    title: input.title?.trim() || "Orchestration Board",
    description: input.description?.trim() || "",
    headConversationId: input.headConversationId ?? null,
    createdAt: now,
    updatedAt: now,
    archivedAt: null,
    settings: createDefaultOrchestrationBoardSettings(input.allowedBackendIds),
  };
  const snapshot: OrchestrationBoardSnapshot = {
    board,
    issues: [],
    assignments: [],
    events: [
      createOrchestrationEvent({
        boardId: board.id,
        kind: "board_created",
        actor: { type: "user" },
        message: "Created orchestration board.",
        now,
      }),
    ],
  };
  return saveOrchestrationBoardSnapshot(snapshot);
}

export async function mutateOrchestrationBoardSnapshot(
  boardId: string,
  mutator: (snapshot: OrchestrationBoardSnapshot) => OrchestrationBoardSnapshot
): Promise<OrchestrationBoardSnapshot> {
  const current = await readOrchestrationBoardSnapshot(boardId);
  if (!current) {
    throw new Error(`Unknown orchestration board: ${boardId}`);
  }
  return saveOrchestrationBoardSnapshot(mutator(current));
}

export async function createOrchestrationIssue(input: {
  boardId: string;
  title: string;
  description?: string;
  columnId?: OrchestrationColumnId;
  priority?: OrchestrationIssuePriority;
  acceptanceCriteria?: string[];
  actor?: OrchestrationActor;
}): Promise<OrchestrationBoardSnapshot> {
  const now = Date.now();
  return mutateOrchestrationBoardSnapshot(input.boardId, (snapshot) => {
    const columnId = input.columnId ?? "backlog";
    const maxSort = snapshot.issues
      .filter((issue) => issue.columnId === columnId)
      .reduce((max, issue) => Math.max(max, issue.sortOrder), 0);
    const issue: OrchestrationIssueRecord = {
      schemaVersion: 1,
      id: randomUUID(),
      boardId: snapshot.board.id,
      title: input.title.trim(),
      description: input.description?.trim() ?? "",
      columnId,
      priority: input.priority ?? "medium",
      sortOrder: maxSort + 1000,
      acceptanceCriteria: input.acceptanceCriteria ?? [],
      dependencyIssueIds: [],
      blockedReason: null,
      verification: { status: "unchecked" },
      createdAt: now,
      updatedAt: now,
      completedAt: null,
    };
    return {
      ...snapshot,
      board: { ...snapshot.board, updatedAt: now },
      issues: [...snapshot.issues, issue],
      events: [
        ...snapshot.events,
        createOrchestrationEvent({
          boardId: snapshot.board.id,
          issueId: issue.id,
          kind: "issue_created",
          actor: input.actor ?? { type: "user" },
          message: `Created issue "${issue.title}".`,
          now,
        }),
      ],
    };
  });
}

export async function upsertOrchestrationIssue(
  boardId: string,
  issuePatch: Partial<OrchestrationIssueRecord> & { id: string },
  actor: OrchestrationActor = { type: "user" }
): Promise<OrchestrationBoardSnapshot> {
  const now = Date.now();
  return mutateOrchestrationBoardSnapshot(boardId, (snapshot) => {
    const existing = snapshot.issues.find((issue) => issue.id === issuePatch.id);
    if (!existing) {
      throw new Error(`Unknown orchestration issue: ${issuePatch.id}`);
    }
    const nextIssue: OrchestrationIssueRecord = {
      ...existing,
      ...issuePatch,
      boardId,
      schemaVersion: 1,
      updatedAt: now,
      completedAt:
        issuePatch.columnId === "done" && !existing.completedAt
          ? now
          : issuePatch.columnId && issuePatch.columnId !== "done"
            ? null
            : existing.completedAt,
    };
    const moved = existing.columnId !== nextIssue.columnId;
    return {
      ...snapshot,
      board: { ...snapshot.board, updatedAt: now },
      issues: snapshot.issues.map((issue) =>
        issue.id === nextIssue.id ? nextIssue : issue
      ),
      events: [
        ...snapshot.events,
        createOrchestrationEvent({
          boardId,
          issueId: nextIssue.id,
          kind: moved ? "issue_moved" : "issue_updated",
          actor,
          message: moved
            ? `Moved "${nextIssue.title}" to ${nextIssue.columnId}.`
            : `Updated issue "${nextIssue.title}".`,
          payload: { patch: issuePatch },
          now,
        }),
      ],
    };
  });
}

export async function deleteOrchestrationIssue(
  boardId: string,
  issueId: string,
  actor: OrchestrationActor = { type: "user" }
): Promise<OrchestrationBoardSnapshot> {
  const now = Date.now();
  return mutateOrchestrationBoardSnapshot(boardId, (snapshot) => {
    const existing = snapshot.issues.find((issue) => issue.id === issueId);
    if (!existing) {
      throw new Error(`Unknown orchestration issue: ${issueId}`);
    }
    return {
      ...snapshot,
      board: { ...snapshot.board, updatedAt: now },
      issues: snapshot.issues.filter((issue) => issue.id !== issueId),
      assignments: snapshot.assignments.filter(
        (assignment) => assignment.issueId !== issueId
      ),
      events: [
        ...snapshot.events,
        createOrchestrationEvent({
          boardId,
          issueId,
          kind: "issue_deleted",
          actor,
          message: `Deleted issue "${existing.title}".`,
          payload: { issue: existing },
          now,
        }),
      ],
    };
  });
}

export async function addOrchestrationComment(input: {
  boardId: string;
  issueId: string;
  message: string;
  actor?: OrchestrationActor;
}): Promise<OrchestrationBoardSnapshot> {
  const now = Date.now();
  return mutateOrchestrationBoardSnapshot(input.boardId, (snapshot) => {
    const issue = snapshot.issues.find((candidate) => candidate.id === input.issueId);
    if (!issue) {
      throw new Error(`Unknown orchestration issue: ${input.issueId}`);
    }
    return {
      ...snapshot,
      board: { ...snapshot.board, updatedAt: now },
      issues: snapshot.issues.map((candidate) =>
        candidate.id === issue.id ? { ...candidate, updatedAt: now } : candidate
      ),
      events: [
        ...snapshot.events,
        createOrchestrationEvent({
          boardId: input.boardId,
          issueId: input.issueId,
          kind: "comment_added",
          actor: input.actor ?? { type: "user" },
          message: input.message,
          now,
        }),
      ],
    };
  });
}

export async function upsertOrchestrationAssignment(
  boardId: string,
  assignment: OrchestrationAssignmentRecord,
  actor: OrchestrationActor = { type: "head_agent" }
): Promise<OrchestrationBoardSnapshot> {
  const now = Date.now();
  return mutateOrchestrationBoardSnapshot(boardId, (snapshot) => {
    const exists = snapshot.assignments.some((candidate) => candidate.id === assignment.id);
    const nextAssignment: OrchestrationAssignmentRecord = {
      ...assignment,
      schemaVersion: 1,
      boardId,
      updatedAt: now,
    };
    return {
      ...snapshot,
      board: { ...snapshot.board, updatedAt: now },
      assignments: exists
        ? snapshot.assignments.map((candidate) =>
            candidate.id === assignment.id ? nextAssignment : candidate
          )
        : [...snapshot.assignments, nextAssignment],
      events: [
        ...snapshot.events,
        createOrchestrationEvent({
          boardId,
          issueId: nextAssignment.issueId,
          assignmentId: nextAssignment.id,
          kind: exists ? "agent_status_changed" : "agent_assigned",
          actor,
          message: exists
            ? `Updated agent assignment ${nextAssignment.conversationId}.`
            : `Assigned agent ${nextAssignment.conversationId}.`,
          payload: { assignment: nextAssignment },
          now,
        }),
      ],
    };
  });
}
