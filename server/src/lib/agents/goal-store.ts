import { randomUUID } from "node:crypto";
import { getStorage } from "../../storage/runtime.js";
import type { WorkspaceRecord } from "../workspace-registry.js";
import { assignWorkItemIds, normalizeWorkItemStatus } from "./work-items.js";
import {
  ledgerMilestones,
  ledgerTasks,
  newLedgerItem,
  readWorkLedger,
  writeWorkLedger,
  type WorkLedgerItem,
} from "./work-ledger.js";
import {
  GOAL_SNAPSHOT_LIMIT,
  goalLatestSnapshotFreshness,
  goalRemainingSummary,
  type GoalBlocker,
  type GoalItemStatus,
  type GoalMilestone,
  type GoalPatch,
  type GoalProgressSnapshot,
  type GoalRecord,
  type GoalStatus,
  type GoalTodo,
  type GoalVerification,
} from "./goal-types.js";

const TERMINAL_STATUSES: GoalStatus[] = [
  "blocked",
  "usage_limited",
  "budget_limited",
  "complete",
  "cancelled",
];

function nowMs(): number {
  return Date.now();
}

function asStatus(value: unknown): GoalItemStatus {
  return normalizeWorkItemStatus(value) ?? "pending";
}

function stringValue(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function recordText(record: Record<string, unknown>, keys: string[]): string | null {
  for (const key of keys) {
    const value = stringValue(record[key]);
    if (value) return value;
  }
  return null;
}

function normalizeMilestones(values: unknown[], previous: GoalMilestone[]): GoalMilestone[] {
  const records = values.flatMap((value) => {
    if (!value || typeof value !== "object") return [];
    const record = value as Record<string, unknown>;
    const title = recordText(record, ["title", "content", "text"]);
    return title ? [{ record, title }] : [];
  });
  const ids = assignWorkItemIds(
    records.map(({ record, title }) => ({ id: stringValue(record.id) ?? undefined, text: title })),
    previous.map((item) => ({ id: item.id, text: item.title })),
    "milestone"
  );
  const byId = new Map(previous.map((item) => [item.id, item]));
  return records.map(({ record, title }, index) => {
    const id = ids[index]!;
    const existing = byId.get(id);
    return {
      id,
      title,
      description: stringValue(record.description) ?? existing?.description,
      status: asStatus(record.status ?? existing?.status),
      evidence: stringValue(record.evidence) ?? existing?.evidence,
      updatedAt: nowMs(),
    };
  });
}

function normalizeTodos(values: unknown[], previous: GoalTodo[]): GoalTodo[] {
  const records = values.flatMap((value) => {
    if (!value || typeof value !== "object") return [];
    const record = value as Record<string, unknown>;
    const content = recordText(record, ["content", "title", "text", "description"]);
    return content ? [{ record, content }] : [];
  });
  const ids = assignWorkItemIds(
    records.map(({ record, content }) => ({ id: stringValue(record.id) ?? undefined, text: content })),
    previous.map((item) => ({ id: item.id, text: item.content })),
    "todo"
  );
  const byId = new Map(previous.map((item) => [item.id, item]));
  return records.map(({ record, content }, index) => {
    const id = ids[index]!;
    const existing = byId.get(id);
    return {
      id,
      content,
      status: asStatus(record.status ?? existing?.status),
      milestoneId: stringValue(record.milestoneId) ?? stringValue(record.milestone_id) ?? existing?.milestoneId,
      evidence: stringValue(record.evidence) ?? existing?.evidence,
      updatedAt: nowMs(),
    };
  });
}

function normalizeVerification(values: unknown[]): GoalVerification[] {
  return values.flatMap((value) => {
    if (!value || typeof value !== "object") return [];
    const record = value as Record<string, unknown>;
    const requirement = stringValue(record.requirement) ?? stringValue(record.content);
    if (!requirement) return [];
    const rawStatus = String(record.status ?? "unverified").trim().toLowerCase();
    const status =
      rawStatus === "passed" ? "passed" :
      rawStatus === "failed" ? "failed" :
      "unverified";
    return [{
      requirement,
      status,
      evidence: stringValue(record.evidence) ?? undefined,
      updatedAt: nowMs(),
    }];
  });
}

export function createGoalRecord(input: {
  workspace: WorkspaceRecord;
  conversationId: string;
  objective: string;
  tokenBudget?: number | null;
}): GoalRecord {
  const now = nowMs();
  return {
    schemaVersion: 1,
    goalId: randomUUID(),
    workspaceId: input.workspace.id,
    conversationId: input.conversationId,
    objective: input.objective.trim(),
    status: "planning",
    phase: "planning",
    tokenBudget: input.tokenBudget ?? null,
    tokensUsed: 0,
    timeUsedSeconds: 0,
    progressPercent: null,
    headline: null,
    revision: 0,
    planSummary: "",
    milestones: [],
    todos: [],
    blockerHistory: [],
    verificationEvidence: [],
    snapshots: [],
    compaction: { generation: 0 },
    createdAt: now,
    updatedAt: now,
    completedAt: null,
  };
}

/** A Goal's milestones and todos are the ledger's milestones and tasks. */
export function goalWithLedger(goal: GoalRecord, items: WorkLedgerItem[]): GoalRecord {
  return {
    ...goal,
    milestones: ledgerMilestones(items).map((item) => ({
      id: item.key,
      title: item.title,
      ...(item.description ? { description: item.description } : {}),
      status: item.status,
      ...(item.evidence ? { evidence: item.evidence } : {}),
      updatedAt: item.updatedAt,
    })),
    todos: ledgerTasks(items).map((item) => ({
      id: item.key,
      content: item.title,
      status: item.status,
      ...(item.parentKey ? { milestoneId: item.parentKey } : {}),
      ...(item.evidence ? { evidence: item.evidence } : {}),
      updatedAt: item.updatedAt,
    })),
  };
}

type GoalScope = { workspace: WorkspaceRecord; conversationId: string };

async function withLedger(scope: GoalScope, goal: GoalRecord): Promise<GoalRecord> {
  return goalWithLedger(goal, await readWorkLedger(scope));
}

export async function readGoalForConversation(input: GoalScope): Promise<GoalRecord | null> {
  const storage = await getStorage();
  const goal = await storage.getGoalByConversation(input.workspace.id, input.conversationId);
  return goal ? withLedger(input, goal) : null;
}

export async function ensureGoalForConversation(input: {
  workspace: WorkspaceRecord;
  conversationId: string;
  objective: string;
  tokenBudget?: number | null;
}): Promise<GoalRecord> {
  const storage = await getStorage();
  const existing = await storage.getGoalByConversation(
    input.workspace.id,
    input.conversationId
  );
  if (existing && !TERMINAL_STATUSES.includes(existing.status)) {
    return withLedger(input, existing);
  }
  const record = createGoalRecord(input);
  await storage.upsertGoal(record);
  return withLedger(input, record);
}

/** Saves `patch` to the Goal record. Milestones and todos live in the ledger and are never patched here. */
export async function updateGoal(input: {
  workspace: WorkspaceRecord;
  conversationId: string;
  patch: GoalPatch;
}): Promise<GoalRecord> {
  const { milestones: _milestones, todos: _todos, ...patch } = input.patch;
  const storage = await getStorage();
  const updated = await storage.updateGoal(
    input.workspace.id,
    input.conversationId,
    patch
  );
  if (!updated) {
    throw new Error("No Goal exists for this conversation.");
  }
  return withLedger(input, updated);
}

/**
 * Records the milestones and/or todos a Goal tool sent. The ledger is shared
 * with the todo list and the board, so this never deletes: listed items are
 * updated or added (ids kept by text as before) and come first in the order
 * given, and every other item stays after them.
 */
async function writeGoalItems(
  scope: GoalScope,
  milestoneValues: unknown[] | undefined,
  todoValues: unknown[] | undefined
): Promise<void> {
  if (!milestoneValues && !todoValues) {
    return;
  }
  await writeWorkLedger(
    scope,
    (current) => {
      const view = goalWithLedger({ milestones: [], todos: [] } as unknown as GoalRecord, current);
      const byKey = new Map(current.map((item) => [item.key, item]));
      const listedMilestones = milestoneValues
        ? normalizeMilestones(milestoneValues, view.milestones).map((milestone) => {
            const existing = byKey.get(milestone.id);
            const fields = {
              title: milestone.title,
              status: milestone.status,
              description: milestone.description ?? "",
              evidence: milestone.evidence ?? null,
            };
            return existing?.kind === "milestone"
              ? { ...existing, ...fields }
              : newLedgerItem({ key: milestone.id, kind: "milestone", ...fields });
          })
        : [];
      const listedTasks = todoValues
        ? normalizeTodos(todoValues, view.todos).map((todo) => {
            const existing = byKey.get(todo.id);
            const fields = {
              title: todo.content,
              status: todo.status,
              parentKey: todo.milestoneId ?? existing?.parentKey ?? null,
              evidence: todo.evidence ?? null,
            };
            return existing?.kind === "task"
              ? { ...existing, ...fields }
              : newLedgerItem({ key: todo.id, kind: "task", ...fields });
          })
        : [];
      const listed = new Set([...listedMilestones, ...listedTasks].map((item) => item.key));
      const rest = current.filter((item) => !listed.has(item.key));
      return [
        ...listedMilestones,
        ...ledgerMilestones(rest),
        ...listedTasks,
        ...ledgerTasks(rest),
      ];
    },
    { deleteMissing: false }
  );
}

export async function updateGoalPlan(input: {
  workspace: WorkspaceRecord;
  conversationId: string;
  planSummary?: string | null;
  milestones?: unknown[];
  todos?: unknown[];
}): Promise<GoalRecord> {
  const current = await readGoalForConversation(input);
  if (!current) {
    throw new Error("No Goal exists for this conversation.");
  }
  await writeGoalItems(input, input.milestones, input.todos);
  return updateGoal({
    workspace: input.workspace,
    conversationId: input.conversationId,
    patch: {
      planSummary: input.planSummary ?? current.planSummary,
      phase: "executing",
      status: "active",
    },
  });
}

const REQUIRED_SNAPSHOT_SECTIONS = ["Progress", "Current State", "Blockers", "Next Steps"] as const;

export function validateGoalSnapshotSummary(summary: string): void {
  const sections = new Map<string, number>();
  let current: string | undefined;

  for (const raw of summary.trim().split(/\r?\n/)) {
    const line = raw.trimEnd();
    if (!line.trim()) {
      continue;
    }

    const heading = line.match(/^(#{1,6})\s+(.+)$/);
    if (heading) {
      if (heading[1] !== "##") {
        throw new Error(`Goal progress summary headings must use size 2 markdown headers: ${line}`);
      }
      current = heading[2]?.trim();
      if (!current) {
        throw new Error("Goal progress summary headings cannot be empty.");
      }
      sections.set(current, sections.get(current) ?? 0);
      continue;
    }

    if (!current) {
      throw new Error("Goal progress summary content must appear under size 2 markdown headers.");
    }
    if (!line.trimStart().startsWith("- ")) {
      throw new Error(`Goal progress summary section "${current}" must use bullet list items.`);
    }
    sections.set(current, (sections.get(current) ?? 0) + 1);
  }

  for (const section of REQUIRED_SNAPSHOT_SECTIONS) {
    if (!sections.has(section)) {
      throw new Error(`Goal progress summary is missing the ## ${section} section.`);
    }
    if ((sections.get(section) ?? 0) === 0) {
      throw new Error(`Goal progress summary section ## ${section} needs at least one bullet.`);
    }
  }

  for (const [section, bullets] of sections) {
    if (bullets === 0) {
      throw new Error(`Goal progress summary section ## ${section} needs at least one bullet.`);
    }
  }
}

export async function appendGoalSnapshot(input: {
  workspace: WorkspaceRecord;
  conversationId: string;
  progressPercent: number;
  summary: string;
  headline?: string | null;
}): Promise<GoalRecord> {
  const current = await readGoalForConversation(input);
  if (!current) {
    throw new Error("No Goal exists for this conversation.");
  }
  const progressPercent = Math.min(100, Math.max(0, Math.round(input.progressPercent)));
  if (!Number.isFinite(input.progressPercent) || progressPercent !== input.progressPercent) {
    throw new Error("goal_summarize.progressPercent must be an integer from 0 to 100.");
  }
  const summary = input.summary.trim();
  if (!summary) {
    throw new Error("goal_summarize.summary is required.");
  }
  validateGoalSnapshotSummary(summary);
  const nextRevision = current.revision + 1;
  const snapshot: GoalProgressSnapshot = {
    id: `goal-snapshot-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    createdAt: nowMs(),
    progressPercent,
    summary,
    headline: stringValue(input.headline) ?? undefined,
    revision: nextRevision,
  };
  return updateGoal({
    workspace: input.workspace,
    conversationId: input.conversationId,
    patch: {
      progressPercent,
      headline: snapshot.headline ?? current.headline,
      snapshots: [...current.snapshots, snapshot].slice(-GOAL_SNAPSHOT_LIMIT),
      revision: nextRevision,
      status: current.status === "planning" ? "active" : current.status,
      phase: current.phase === "planning" ? "executing" : current.phase,
    },
  });
}

export async function updateGoalProgress(input: {
  workspace: WorkspaceRecord;
  conversationId: string;
  milestones?: unknown[];
  todos?: unknown[];
  verificationEvidence?: unknown[];
}): Promise<GoalRecord> {
  const current = await readGoalForConversation(input);
  if (!current) {
    throw new Error("No Goal exists for this conversation.");
  }
  await writeGoalItems(input, input.milestones, input.todos);
  return updateGoal({
    workspace: input.workspace,
    conversationId: input.conversationId,
    patch: {
      verificationEvidence: input.verificationEvidence
        ? normalizeVerification(input.verificationEvidence)
        : current.verificationEvidence,
    },
  });
}

export async function blockGoal(input: {
  workspace: WorkspaceRecord;
  conversationId: string;
  reason: string;
  evidence?: string | null;
}): Promise<GoalRecord> {
  const current = await readGoalForConversation(input);
  if (!current) {
    throw new Error("No Goal exists for this conversation.");
  }
  const normalizedReason = input.reason.trim();
  const existing = current.blockerHistory.find(
    (item) => item.reason.trim().toLowerCase() === normalizedReason.toLowerCase()
  );
  const blocker: GoalBlocker = existing
    ? {
        ...existing,
        occurrenceCount: existing.occurrenceCount + 1,
        lastSeenAt: nowMs(),
        evidence: input.evidence ?? existing.evidence,
      }
    : {
        id: randomUUID(),
        reason: normalizedReason,
        occurrenceCount: 1,
        firstSeenAt: nowMs(),
        lastSeenAt: nowMs(),
        evidence: input.evidence ?? undefined,
      };
  const blockerHistory = existing
    ? current.blockerHistory.map((item) => item.id === existing.id ? blocker : item)
    : [...current.blockerHistory, blocker];
  if (blocker.occurrenceCount < 3) {
    return updateGoal({
      workspace: input.workspace,
      conversationId: input.conversationId,
      patch: { blockerHistory },
    });
  }
  return updateGoal({
    workspace: input.workspace,
    conversationId: input.conversationId,
    patch: { blockerHistory, status: "blocked" },
  });
}

export async function pauseGoal(input: {
  workspace: WorkspaceRecord;
  conversationId: string;
  reason?: string | null;
}): Promise<GoalRecord> {
  const current = await readGoalForConversation(input);
  if (!current) {
    throw new Error("No Goal exists for this conversation.");
  }
  if (current.status === "complete" || current.status === "cancelled") {
    throw new Error(`Cannot pause a Goal with status ${current.status}.`);
  }
  const reason = stringValue(input.reason);
  return updateGoal({
    workspace: input.workspace,
    conversationId: input.conversationId,
    patch: {
      status: "paused",
      headline: reason ? `Paused: ${reason}` : current.headline,
    },
  });
}

export async function resumeGoal(input: {
  workspace: WorkspaceRecord;
  conversationId: string;
}): Promise<GoalRecord> {
  const current = await readGoalForConversation(input);
  if (!current) {
    throw new Error("No Goal exists for this conversation.");
  }
  if (current.status === "complete" || current.status === "cancelled") {
    throw new Error(`Cannot resume a Goal with status ${current.status}.`);
  }
  return updateGoal({
    workspace: input.workspace,
    conversationId: input.conversationId,
    patch: {
      status: "active",
      phase: current.phase === "planning" ? "executing" : current.phase,
    },
  });
}

export async function completeGoal(input: {
  workspace: WorkspaceRecord;
  conversationId: string;
}): Promise<GoalRecord> {
  const current = await readGoalForConversation(input);
  if (!current) {
    throw new Error("No Goal exists for this conversation.");
  }
  const incompleteMilestones = current.milestones.filter((item) => item.status !== "completed");
  const incompleteTodos = current.todos.filter((item) => item.status !== "completed");
  const failedEvidence = current.verificationEvidence.filter((item) => item.status !== "passed");
  if (incompleteMilestones.length || incompleteTodos.length || failedEvidence.length) {
    throw new Error(
      [
        "Goal is not complete yet.",
        incompleteMilestones.length ? `${incompleteMilestones.length} milestone(s) remain.` : null,
        incompleteTodos.length ? `${incompleteTodos.length} todo(s) remain.` : null,
        failedEvidence.length ? `${failedEvidence.length} verification item(s) are not passed.` : null,
      ].filter(Boolean).join(" ")
    );
  }
  return updateGoal({
    workspace: input.workspace,
    conversationId: input.conversationId,
    patch: {
      status: "complete",
      phase: "complete",
      completedAt: nowMs(),
    },
  });
}

function formatGoalSnapshotForModel(snapshot: GoalProgressSnapshot): string {
  return [
    `Updated: ${new Date(snapshot.createdAt).toISOString()}`,
    `Progress: ${snapshot.progressPercent}%`,
    snapshot.headline ? `Headline: ${snapshot.headline}` : null,
    `Revision: ${snapshot.revision}`,
    snapshot.summary,
  ].filter(Boolean).join("\n");
}

function formatRecentGoalSnapshotsForModel(goal: GoalRecord): string {
  const recent = goal.snapshots.slice(-3);
  if (recent.length === 0) {
    return "- No Goal progress snapshots have been recorded yet.";
  }
  return recent
    .map((snapshot, index) =>
      [
        `### ${index === recent.length - 1 ? "Latest" : "Previous"} Progress Snapshot`,
        formatGoalSnapshotForModel(snapshot),
      ].join("\n")
    )
    .join("\n\n");
}

export function formatGoalForModel(goal: GoalRecord): string {
  const latestSnapshot = goal.snapshots.at(-1);
  const snapshotFreshness = goalLatestSnapshotFreshness(goal);
  return [
    `Goal id: ${goal.goalId}`,
    `Objective: ${goal.objective}`,
    `Revision: ${goal.revision}`,
    goal.progressPercent == null ? null : `Progress: ${goal.progressPercent}%`,
    goal.headline ? `Headline: ${goal.headline}` : null,
    `Latest summary freshness: ${snapshotFreshness}`,
    goalRemainingSummary(goal),
    latestSnapshot
      ? [
          "",
          "## Latest Progress Snapshot",
          formatGoalSnapshotForModel(latestSnapshot),
        ].filter(Boolean).join("\n")
      : null,
    "",
    "## Recent Progress Snapshot History",
    formatRecentGoalSnapshotsForModel(goal),
    "",
    "## Plan",
    goal.planSummary || "(No structured plan has been recorded yet.)",
    "",
    "## Milestones",
    goal.milestones.length
      ? goal.milestones.map((item) => `- [${item.status}] ${item.id}: ${item.title}${item.evidence ? ` - evidence: ${item.evidence}` : ""}`).join("\n")
      : "- No milestones recorded yet.",
    "",
    "## Todos",
    goal.todos.length
      ? goal.todos.map((item) => `- [${item.status}] ${item.id}: ${item.content}${item.evidence ? ` - evidence: ${item.evidence}` : ""}`).join("\n")
      : "- No todos recorded yet.",
    "",
    "## Blocker History",
    goal.blockerHistory.length
      ? goal.blockerHistory.map((item) => `- ${item.reason} (seen ${item.occurrenceCount}x; last ${new Date(item.lastSeenAt).toISOString()})${item.evidence ? ` - evidence: ${item.evidence}` : ""}`).join("\n")
      : "- No blockers recorded yet.",
    "",
    "## Verification Evidence",
    goal.verificationEvidence.length
      ? goal.verificationEvidence.map((item) => `- [${item.status}] ${item.requirement}${item.evidence ? ` - evidence: ${item.evidence}` : ""}`).join("\n")
      : "- No verification evidence recorded yet.",
  ].filter((line) => line != null).join("\n");
}
