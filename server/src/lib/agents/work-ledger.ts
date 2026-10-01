/**
 * One work ledger per conversation: the items of the board whose head is the
 * conversation. The `todo` tool is its flat task view, a Goal's milestones and
 * todos are its items, and orchestration tools act on the same issues. Older
 * conversations kept todos in `plan` events and Goals kept their own lists;
 * those are imported the first time the ledger is opened.
 */
import { randomUUID } from "node:crypto";
import { getStorage } from "../../storage/runtime.js";
import {
  createOrchestrationBoard,
  createOrchestrationEvent,
  findOrchestrationBoardForHeadConversation,
  mutateOrchestrationBoardSnapshot,
  resolveOrCreateOrchestrationBoardForHeadConversation,
} from "../orchestration/store.js";
import type {
  OrchestrationActor,
  OrchestrationBoardSnapshot,
  OrchestrationColumnId,
  OrchestrationEventRecord,
  OrchestrationIssueRecord,
  OrchestrationWorkLedgerState,
} from "../orchestration/types.js";
import type { WorkspaceRecord } from "../workspace-registry.js";
import { CESIUM_TODO_PLAN_ID } from "./cesium/cesium-todo.js";
import type { GoalRecord } from "./goal-types.js";
import { readConversationEvents } from "./session-store.js";
import type { AgentPlanEntry, AgentStoredEvent } from "./types.js";
import { nextWorkItemKey, workItemTextKey, type WorkItemStatus } from "./work-items.js";


export type WorkLedgerItem = {
  key: string;
  kind: "task" | "milestone";
  title: string;
  status: WorkItemStatus;
  parentKey: string | null;
  evidence: string | null;
  description: string;
  /** The issue behind the item; null until a new item is saved. */
  issueId: string | null;
  /** True when an agent is assigned to the issue; such items are never deleted by a list replace. */
  assigned: boolean;
  updatedAt: number;
};

export type WorkLedgerScope = {
  workspace: WorkspaceRecord;
  conversationId: string;
  /** Board title when the ledger has to create its board. */
  title?: string;
  actor?: OrchestrationActor;
  /** The conversation's events, for importing an older todo list; read from the store when omitted. */
  readEvents?: () => Promise<AgentStoredEvent[]>;
};

const STATUS_RANK: Record<WorkItemStatus, number> = {
  pending: 0,
  blocked: 1,
  in_progress: 2,
  completed: 3,
};

export function statusForColumn(columnId: OrchestrationColumnId): WorkItemStatus {
  switch (columnId) {
    case "in_progress":
    case "review":
      return "in_progress";
    case "blocked":
      return "blocked";
    case "done":
      return "completed";
    default:
      return "pending";
  }
}

/** The column for a status, keeping the current column when it already means that status. */
export function columnForStatus(
  status: WorkItemStatus,
  current?: OrchestrationColumnId
): OrchestrationColumnId {
  if (current && statusForColumn(current) === status) {
    return current;
  }
  switch (status) {
    case "in_progress":
      return "in_progress";
    case "blocked":
      return "blocked";
    case "completed":
      return "done";
    default:
      return "backlog";
  }
}

function ledgerOrder(issue: OrchestrationIssueRecord): number {
  return issue.ledger?.order ?? Number.MAX_SAFE_INTEGER;
}

/** The ledger's items in list order. Issues the ledger has not keyed yet are left out. */
export function workLedgerItems(snapshot: OrchestrationBoardSnapshot | null): WorkLedgerItem[] {
  if (!snapshot) {
    return [];
  }
  const assigned = new Set(snapshot.assignments.map((assignment) => assignment.issueId));
  return snapshot.issues
    .filter((issue) => issue.ledger)
    .sort((a, b) => ledgerOrder(a) - ledgerOrder(b) || a.createdAt - b.createdAt || a.id.localeCompare(b.id))
    .map((issue) => ({
      key: issue.ledger!.key,
      kind: issue.ledger!.kind,
      title: issue.title,
      status: statusForColumn(issue.columnId),
      parentKey: issue.ledger!.parentKey ?? null,
      evidence: issue.ledger!.evidence ?? null,
      description: issue.description,
      issueId: issue.id,
      assigned: assigned.has(issue.id),
      updatedAt: issue.updatedAt,
    }));
}

export function ledgerTasks(items: WorkLedgerItem[]): WorkLedgerItem[] {
  return items.filter((item) => item.kind === "task");
}

export function ledgerMilestones(items: WorkLedgerItem[]): WorkLedgerItem[] {
  return items.filter((item) => item.kind === "milestone");
}

/** Tasks as `plan` event entries, which is how the chat shows the todo list. */
export function ledgerPlanEntries(items: WorkLedgerItem[]): AgentPlanEntry[] {
  return ledgerTasks(items).map((item) => ({ id: item.key, content: item.title, status: item.status }));
}

/** A fresh item for `key`, to fill in before saving. */
export function newLedgerItem(input: {
  key: string;
  kind: WorkLedgerItem["kind"];
  title: string;
  status?: WorkItemStatus;
  parentKey?: string | null;
  evidence?: string | null;
  description?: string;
}): WorkLedgerItem {
  return {
    key: input.key,
    kind: input.kind,
    title: input.title,
    status: input.status ?? "pending",
    parentKey: input.parentKey ?? null,
    evidence: input.evidence ?? null,
    description: input.description ?? "",
    issueId: null,
    assigned: false,
    updatedAt: Date.now(),
  };
}

type IncomingItem = {
  key?: string;
  kind: WorkLedgerItem["kind"];
  title: string;
  status: WorkItemStatus;
  parentKey?: string | null;
  evidence?: string | null;
  description?: string;
};

/**
 * Adds `incoming` to `items` without replacing anything: an item with the same
 * kind and text merges into the existing one (the further-along status wins),
 * otherwise it keeps its own key when that key is free. Returns the key each
 * incoming item ended up with.
 */
export function mergeIntoLedger(items: WorkLedgerItem[], incoming: IncomingItem[]): Map<string, string> {
  const renamed = new Map<string, string>();
  for (const item of incoming) {
    const prefix = item.kind === "milestone" ? "milestone" : "todo";
    const match = items.find(
      (existing) => existing.kind === item.kind && workItemTextKey(existing.title) === workItemTextKey(item.title)
    );
    if (match) {
      if (STATUS_RANK[item.status] > STATUS_RANK[match.status]) {
        match.status = item.status;
      }
      match.evidence = match.evidence ?? item.evidence ?? null;
      match.parentKey = match.parentKey ?? item.parentKey ?? null;
      if (item.key) renamed.set(item.key, match.key);
      continue;
    }
    const used = new Set(items.map((existing) => existing.key));
    const key = item.key && !used.has(item.key) ? item.key : nextWorkItemKey(used, prefix);
    if (item.key) renamed.set(item.key, key);
    items.push(
      newLedgerItem({
        key,
        kind: item.kind,
        title: item.title,
        status: item.status,
        parentKey: item.parentKey ?? null,
        evidence: item.evidence ?? null,
        description: item.description,
      })
    );
  }
  return renamed;
}

/** The todo list an older conversation kept in its newest todo `plan` event. */
export function legacyTodoPlanEntries(events: AgentStoredEvent[]): AgentPlanEntry[] {
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index]!;
    if (event.kind === "plan" && (event.planId === CESIUM_TODO_PLAN_ID || event.planId === undefined)) {
      return event.entries;
    }
  }
  return [];
}

function ledgerState(snapshot: OrchestrationBoardSnapshot): OrchestrationWorkLedgerState {
  return snapshot.board.settings.workLedger ?? { version: 1, importedTodoPlan: false, importedGoalIds: [] };
}

type LegacySources = {
  todoPlan: AgentPlanEntry[] | null;
  goal: GoalRecord | null;
};

async function readLegacySources(
  scope: WorkLedgerScope,
  state: OrchestrationWorkLedgerState | null
): Promise<LegacySources> {
  const storage = await getStorage();
  const goal = await storage.getGoalByConversation(scope.workspace.id, scope.conversationId);
  const goalPending =
    goal && !(state?.importedGoalIds ?? []).includes(goal.goalId) && (goal.todos.length > 0 || goal.milestones.length > 0);
  let todoPlan: AgentPlanEntry[] | null = null;
  if (!state?.importedTodoPlan) {
    const events = await (scope.readEvents?.() ??
      readConversationEvents(scope.workspace.id, scope.conversationId));
    const entries = legacyTodoPlanEntries([...events].sort((a, b) => a.seq - b.seq));
    todoPlan = entries.length > 0 ? entries : null;
  }
  return { todoPlan, goal: goalPending ? goal : null };
}

function hasLegacyWork(sources: LegacySources): boolean {
  return Boolean(sources.todoPlan || sources.goal);
}

/**
 * Brings a board up to the ledger, importing each older source once: the
 * conversation's todo list first and then the Goal's milestones and todos,
 * so the ids the model saw keep winning, and last any board issue without a
 * key, which gets the next free one.
 */
function importIntoSnapshot(
  snapshot: OrchestrationBoardSnapshot,
  sources: LegacySources,
  actor: OrchestrationActor
): OrchestrationBoardSnapshot {
  const now = Date.now();
  const state = ledgerState(snapshot);
  const items = workLedgerItems(snapshot);
  if (sources.todoPlan) {
    mergeIntoLedger(
      items,
      sources.todoPlan.map((entry) => ({ key: entry.id, kind: "task" as const, title: entry.content, status: entry.status }))
    );
  }
  if (sources.goal) {
    const goal = sources.goal;
    const milestoneKeys = mergeIntoLedger(
      items,
      goal.milestones.map((milestone) => ({
        key: milestone.id,
        kind: "milestone" as const,
        title: milestone.title,
        status: milestone.status,
        evidence: milestone.evidence ?? null,
        description: milestone.description,
      }))
    );
    mergeIntoLedger(
      items,
      goal.todos.map((todo) => ({
        key: todo.id,
        kind: "task" as const,
        title: todo.content,
        status: todo.status,
        parentKey: todo.milestoneId ? milestoneKeys.get(todo.milestoneId) ?? null : null,
        evidence: todo.evidence ?? null,
      }))
    );
  }
  const used = new Set(items.map((item) => item.key));
  const issues = snapshot.issues.map((issue) => {
    if (issue.ledger) return issue;
    const key = nextWorkItemKey(used, "todo");
    used.add(key);
    items.push({
      ...newLedgerItem({ key, kind: "task", title: issue.title, status: statusForColumn(issue.columnId), description: issue.description }),
      issueId: issue.id,
    });
    return { ...issue, ledger: { key, kind: "task" as const, order: items.length - 1 } };
  });
  const nextState: OrchestrationWorkLedgerState = {
    version: 1,
    importedTodoPlan: true,
    importedGoalIds: sources.goal ? [...state.importedGoalIds, sources.goal.goalId] : state.importedGoalIds,
  };
  return applyLedgerItems(
    {
      ...snapshot,
      issues,
      board: { ...snapshot.board, settings: { ...snapshot.board.settings, workLedger: nextState }, updatedAt: now },
    },
    items,
    actor,
    { deleteMissing: false }
  );
}

function blockedReasonFor(item: WorkLedgerItem, existing: OrchestrationIssueRecord | undefined): string {
  return existing?.blockedReason ?? item.evidence ?? "Marked blocked in the work ledger.";
}

/**
 * Saves `items` as the ledger: matching issues are updated, new items become
 * issues, and with `deleteMissing` keyed issues that are no longer listed are
 * deleted unless an agent is assigned to them. Every change is a board event.
 */
export function applyLedgerItems(
  snapshot: OrchestrationBoardSnapshot,
  items: WorkLedgerItem[],
  actor: OrchestrationActor,
  options: { deleteMissing: boolean }
): OrchestrationBoardSnapshot {
  const now = Date.now();
  const byKey = new Map(snapshot.issues.flatMap((issue) => (issue.ledger ? [[issue.ledger.key, issue] as const] : [])));
  const listed = new Set(items.map((item) => item.key));
  const assigned = new Set(snapshot.assignments.map((assignment) => assignment.issueId));
  const events: OrchestrationEventRecord[] = [];
  const nextSort = (columnId: OrchestrationColumnId, issues: OrchestrationIssueRecord[]) =>
    issues.filter((issue) => issue.columnId === columnId).reduce((max, issue) => Math.max(max, issue.sortOrder), 0) + 1000;

  let issues = snapshot.issues.filter((issue) => {
    if (!options.deleteMissing || !issue.ledger || listed.has(issue.ledger.key) || assigned.has(issue.id)) {
      return true;
    }
    events.push(
      createOrchestrationEvent({
        boardId: snapshot.board.id,
        issueId: issue.id,
        kind: "issue_deleted",
        actor,
        message: `Deleted issue "${issue.title}".`,
        payload: { issue },
        now,
      })
    );
    return false;
  });

  items.forEach((item, order) => {
    const existing = byKey.get(item.key);
    if (existing) {
      const columnId = columnForStatus(item.status, existing.columnId);
      const ledger = {
        key: item.key,
        kind: item.kind,
        order,
        ...(item.parentKey ? { parentKey: item.parentKey } : {}),
        ...(item.evidence ? { evidence: item.evidence } : {}),
      };
      const next: OrchestrationIssueRecord = {
        ...existing,
        title: item.title,
        description: item.description,
        columnId,
        blockedReason: columnId === "blocked" ? blockedReasonFor(item, existing) : null,
        sortOrder: columnId === existing.columnId ? existing.sortOrder : nextSort(columnId, issues),
        completedAt: columnId === "done" ? existing.completedAt ?? now : null,
        ledger,
      };
      const changed =
        next.title !== existing.title ||
        next.description !== existing.description ||
        next.columnId !== existing.columnId ||
        next.blockedReason !== existing.blockedReason ||
        JSON.stringify(next.ledger) !== JSON.stringify(existing.ledger);
      if (!changed) {
        return;
      }
      issues = issues.map((issue) => (issue.id === existing.id ? { ...next, updatedAt: now } : issue));
      events.push(
        createOrchestrationEvent({
          boardId: snapshot.board.id,
          issueId: existing.id,
          kind: next.columnId !== existing.columnId ? "issue_moved" : "issue_updated",
          actor,
          message:
            next.columnId !== existing.columnId
              ? `Moved "${next.title}" to ${next.columnId}.`
              : `Updated issue "${next.title}".`,
          payload: { ledgerKey: item.key },
          now,
        })
      );
      return;
    }
    const columnId = columnForStatus(item.status);
    const issue: OrchestrationIssueRecord = {
      schemaVersion: 1,
      id: randomUUID(),
      boardId: snapshot.board.id,
      title: item.title,
      description: item.description,
      columnId,
      priority: "medium",
      sortOrder: nextSort(columnId, issues),
      acceptanceCriteria: [],
      dependencyIssueIds: [],
      blockedReason: columnId === "blocked" ? blockedReasonFor(item, undefined) : null,
      verification: { status: "unchecked" },
      createdAt: now,
      updatedAt: now,
      completedAt: columnId === "done" ? now : null,
      ledger: {
        key: item.key,
        kind: item.kind,
        order,
        ...(item.parentKey ? { parentKey: item.parentKey } : {}),
        ...(item.evidence ? { evidence: item.evidence } : {}),
      },
    };
    issues = [...issues, issue];
    events.push(
      createOrchestrationEvent({
        boardId: snapshot.board.id,
        issueId: issue.id,
        kind: "issue_created",
        actor,
        message: `Created issue "${issue.title}".`,
        payload: { ledgerKey: item.key },
        now,
      })
    );
  });
  // Assigned issues a replace left out keep their place after the listed items.
  let tail = items.length;
  issues = issues.map((issue) =>
    issue.ledger && !listed.has(issue.ledger.key)
      ? { ...issue, ledger: { ...issue.ledger, order: tail++ } }
      : issue
  );
  if (events.length === 0 && JSON.stringify(issues) === JSON.stringify(snapshot.issues)) {
    return snapshot;
  }
  return {
    ...snapshot,
    board: { ...snapshot.board, updatedAt: now },
    issues,
    events: [...snapshot.events, ...events],
  };
}

const DEFAULT_ACTOR = (scope: WorkLedgerScope): OrchestrationActor =>
  scope.actor ?? { type: "head_agent", conversationId: scope.conversationId };

function needsImport(snapshot: OrchestrationBoardSnapshot, sources: LegacySources): boolean {
  return hasLegacyWork(sources) || snapshot.issues.some((issue) => !issue.ledger) || !snapshot.board.settings.workLedger;
}

async function importIfNeeded(
  scope: WorkLedgerScope,
  snapshot: OrchestrationBoardSnapshot
): Promise<OrchestrationBoardSnapshot> {
  const sources = await readLegacySources(scope, snapshot.board.settings.workLedger ?? null);
  if (!needsImport(snapshot, sources)) {
    return snapshot;
  }
  return mutateOrchestrationBoardSnapshot(snapshot.board.id, (current) =>
    importIntoSnapshot(current, sources, DEFAULT_ACTOR(scope))
  );
}

/**
 * The ledger's board, imported up to date. Without a board, one is created
 * only when there is older work to import or `create` is set; reading an empty
 * ledger never creates a board.
 */
export async function openWorkLedgerBoard(
  scope: WorkLedgerScope,
  options: { create: boolean; reuseUnlinkedBoard?: boolean } = { create: false }
): Promise<OrchestrationBoardSnapshot | null> {
  const linked = await findOrchestrationBoardForHeadConversation(scope.workspace.id, scope.conversationId);
  if (linked) {
    return importIfNeeded(scope, linked);
  }
  if (!options.create) {
    const sources = await readLegacySources(scope, null);
    if (!hasLegacyWork(sources)) {
      return null;
    }
  }
  const title =
    scope.title ?? (await (await getStorage()).getAgentConversation(scope.conversationId))?.title ?? undefined;
  const created = options.reuseUnlinkedBoard
    ? await resolveOrCreateOrchestrationBoardForHeadConversation({
        workspace: scope.workspace,
        conversationId: scope.conversationId,
        title,
        allowedBackendIds: ["cesium-agent"],
      })
    : await createOrchestrationBoard({
        workspace: scope.workspace,
        title: title || "Work",
        headConversationId: scope.conversationId,
        allowedBackendIds: ["cesium-agent"],
      });
  return importIfNeeded(scope, created);
}

export async function readWorkLedger(scope: WorkLedgerScope): Promise<WorkLedgerItem[]> {
  return workLedgerItems(await openWorkLedgerBoard(scope, { create: false }));
}

/**
 * Applies `edit` to the ledger and saves the result. `edit` gets a copy of the
 * items and returns the full new list; with `deleteMissing` (a replace),
 * unlisted unassigned items are deleted.
 */
export async function writeWorkLedger(
  scope: WorkLedgerScope,
  edit: (items: WorkLedgerItem[]) => WorkLedgerItem[],
  options: { deleteMissing: boolean } = { deleteMissing: true }
): Promise<WorkLedgerItem[]> {
  const board = await openWorkLedgerBoard(scope, { create: true });
  if (!board) {
    throw new Error("The work ledger could not be opened.");
  }
  const saved = await mutateOrchestrationBoardSnapshot(board.board.id, (current) =>
    applyLedgerItems(
      current,
      edit(workLedgerItems(current).map((item) => ({ ...item }))),
      DEFAULT_ACTOR(scope),
      options
    )
  );
  return workLedgerItems(saved);
}
