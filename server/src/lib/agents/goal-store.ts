import { randomUUID } from "node:crypto";
import { getStorage } from "../../storage/runtime.js";
import type { WorkspaceRecord } from "../workspace-registry.js";
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
  const normalized = String(value ?? "pending").trim().toLowerCase();
  if (normalized === "done" || normalized === "completed") return "completed";
  if (normalized === "in-progress" || normalized === "in_progress") return "in_progress";
  if (normalized === "blocked") return "blocked";
  return "pending";
}

function stringValue(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function normalizeMilestones(values: unknown[], previous: GoalMilestone[]): GoalMilestone[] {
  const byId = new Map(previous.map((item) => [item.id, item]));
  return values.flatMap((value, index) => {
    if (!value || typeof value !== "object") return [];
    const record = value as Record<string, unknown>;
    const title = stringValue(record.title) ?? stringValue(record.content) ?? stringValue(record.text);
    if (!title) return [];
    const id = stringValue(record.id) ?? `milestone-${index + 1}`;
    const existing = byId.get(id);
    return [{
      id,
      title,
      description: stringValue(record.description) ?? existing?.description,
      status: asStatus(record.status ?? existing?.status),
      evidence: stringValue(record.evidence) ?? existing?.evidence,
      updatedAt: nowMs(),
    }];
  });
}

function normalizeTodos(values: unknown[], previous: GoalTodo[]): GoalTodo[] {
  const byId = new Map(previous.map((item) => [item.id, item]));
  return values.flatMap((value, index) => {
    if (!value || typeof value !== "object") return [];
    const record = value as Record<string, unknown>;
    const content =
      stringValue(record.content) ??
      stringValue(record.title) ??
      stringValue(record.text) ??
      stringValue(record.description);
    if (!content) return [];
    const id = stringValue(record.id) ?? `todo-${index + 1}`;
    const existing = byId.get(id);
    return [{
      id,
      content,
      status: asStatus(record.status ?? existing?.status),
      milestoneId: stringValue(record.milestoneId) ?? stringValue(record.milestone_id) ?? existing?.milestoneId,
      evidence: stringValue(record.evidence) ?? existing?.evidence,
      updatedAt: nowMs(),
    }];
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

export async function readGoalForConversation(input: {
  workspace: WorkspaceRecord;
  conversationId: string;
}): Promise<GoalRecord | null> {
  const storage = await getStorage();
  return storage.getGoalByConversation(input.workspace.id, input.conversationId);
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
    return existing;
  }
  const record = createGoalRecord(input);
  await storage.upsertGoal(record);
  return record;
}

export async function updateGoal(input: {
  workspace: WorkspaceRecord;
  conversationId: string;
  patch: GoalPatch;
}): Promise<GoalRecord> {
  const storage = await getStorage();
  const updated = await storage.updateGoal(
    input.workspace.id,
    input.conversationId,
    input.patch
  );
  if (!updated) {
    throw new Error("No Goal exists for this conversation.");
  }
  return updated;
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
  const milestones = input.milestones
    ? normalizeMilestones(input.milestones, current.milestones)
    : current.milestones;
  const todos = input.todos
    ? normalizeTodos(input.todos, current.todos)
    : current.todos;
  return updateGoal({
    workspace: input.workspace,
    conversationId: input.conversationId,
    patch: {
      planSummary: input.planSummary ?? current.planSummary,
      milestones,
      todos,
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
  return updateGoal({
    workspace: input.workspace,
    conversationId: input.conversationId,
    patch: {
      milestones: input.milestones
        ? normalizeMilestones(input.milestones, current.milestones)
        : current.milestones,
      todos: input.todos ? normalizeTodos(input.todos, current.todos) : current.todos,
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
      ? goal.milestones.map((item) => `- [${item.status}] ${item.id}: ${item.title}${item.evidence ? ` — evidence: ${item.evidence}` : ""}`).join("\n")
      : "- No milestones recorded yet.",
    "",
    "## Todos",
    goal.todos.length
      ? goal.todos.map((item) => `- [${item.status}] ${item.id}: ${item.content}${item.evidence ? ` — evidence: ${item.evidence}` : ""}`).join("\n")
      : "- No todos recorded yet.",
    "",
    "## Blocker History",
    goal.blockerHistory.length
      ? goal.blockerHistory.map((item) => `- ${item.reason} (seen ${item.occurrenceCount}x; last ${new Date(item.lastSeenAt).toISOString()})${item.evidence ? ` — evidence: ${item.evidence}` : ""}`).join("\n")
      : "- No blockers recorded yet.",
    "",
    "## Verification Evidence",
    goal.verificationEvidence.length
      ? goal.verificationEvidence.map((item) => `- [${item.status}] ${item.requirement}${item.evidence ? ` — evidence: ${item.evidence}` : ""}`).join("\n")
      : "- No verification evidence recorded yet.",
  ].filter((line) => line != null).join("\n");
}
