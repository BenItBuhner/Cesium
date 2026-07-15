import { randomUUID } from "node:crypto";
import { getStorage } from "../../storage/runtime.js";
import type { WorkspaceRecord } from "../workspace-registry.js";
import {
  BURN_GOAL_SNAPSHOT_LIMIT,
  burnGoalLatestSnapshotFreshness,
  burnGoalRemainingSummary,
  type BurnGoalBlocker,
  type BurnGoalItemStatus,
  type BurnGoalMilestone,
  type BurnGoalPatch,
  type BurnGoalProgressSnapshot,
  type BurnGoalRecord,
  type BurnGoalStatus,
  type BurnGoalTodo,
  type BurnGoalVerification,
} from "./burn-goal-types.js";

const TERMINAL_STATUSES: BurnGoalStatus[] = [
  "blocked",
  "usage_limited",
  "budget_limited",
  "complete",
  "cancelled",
];

function nowMs(): number {
  return Date.now();
}

function asStatus(value: unknown): BurnGoalItemStatus {
  const normalized = String(value ?? "pending").trim().toLowerCase();
  if (normalized === "done" || normalized === "completed") return "completed";
  if (normalized === "in-progress" || normalized === "in_progress") return "in_progress";
  if (normalized === "blocked") return "blocked";
  return "pending";
}

function stringValue(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function normalizeMilestones(values: unknown[], previous: BurnGoalMilestone[]): BurnGoalMilestone[] {
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

function normalizeTodos(values: unknown[], previous: BurnGoalTodo[]): BurnGoalTodo[] {
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

function normalizeVerification(values: unknown[]): BurnGoalVerification[] {
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

export function createBurnGoalRecord(input: {
  workspace: WorkspaceRecord;
  conversationId: string;
  objective: string;
  tokenBudget?: number | null;
}): BurnGoalRecord {
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

export async function readBurnGoalForConversation(input: {
  workspace: WorkspaceRecord;
  conversationId: string;
}): Promise<BurnGoalRecord | null> {
  const storage = await getStorage();
  return storage.getBurnGoalByConversation(input.workspace.id, input.conversationId);
}

export async function ensureBurnGoalForConversation(input: {
  workspace: WorkspaceRecord;
  conversationId: string;
  objective: string;
  tokenBudget?: number | null;
}): Promise<BurnGoalRecord> {
  const storage = await getStorage();
  const existing = await storage.getBurnGoalByConversation(
    input.workspace.id,
    input.conversationId
  );
  if (existing && !TERMINAL_STATUSES.includes(existing.status)) {
    return existing;
  }
  const record = createBurnGoalRecord(input);
  await storage.upsertBurnGoal(record);
  return record;
}

export async function updateBurnGoal(input: {
  workspace: WorkspaceRecord;
  conversationId: string;
  patch: BurnGoalPatch;
}): Promise<BurnGoalRecord> {
  const storage = await getStorage();
  const updated = await storage.updateBurnGoal(
    input.workspace.id,
    input.conversationId,
    input.patch
  );
  if (!updated) {
    throw new Error("No Burn goal exists for this conversation.");
  }
  return updated;
}

export async function updateBurnGoalPlan(input: {
  workspace: WorkspaceRecord;
  conversationId: string;
  planSummary?: string | null;
  milestones?: unknown[];
  todos?: unknown[];
}): Promise<BurnGoalRecord> {
  const current = await readBurnGoalForConversation(input);
  if (!current) {
    throw new Error("No Burn goal exists for this conversation.");
  }
  const milestones = input.milestones
    ? normalizeMilestones(input.milestones, current.milestones)
    : current.milestones;
  const todos = input.todos
    ? normalizeTodos(input.todos, current.todos)
    : current.todos;
  return updateBurnGoal({
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

export function validateBurnGoalSnapshotSummary(summary: string): void {
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
        throw new Error(`Burn progress summary headings must use size 2 markdown headers: ${line}`);
      }
      current = heading[2]?.trim();
      if (!current) {
        throw new Error("Burn progress summary headings cannot be empty.");
      }
      sections.set(current, sections.get(current) ?? 0);
      continue;
    }

    if (!current) {
      throw new Error("Burn progress summary content must appear under size 2 markdown headers.");
    }
    if (!line.trimStart().startsWith("- ")) {
      throw new Error(`Burn progress summary section "${current}" must use bullet list items.`);
    }
    sections.set(current, (sections.get(current) ?? 0) + 1);
  }

  for (const section of REQUIRED_SNAPSHOT_SECTIONS) {
    if (!sections.has(section)) {
      throw new Error(`Burn progress summary is missing the ## ${section} section.`);
    }
    if ((sections.get(section) ?? 0) === 0) {
      throw new Error(`Burn progress summary section ## ${section} needs at least one bullet.`);
    }
  }

  for (const [section, bullets] of sections) {
    if (bullets === 0) {
      throw new Error(`Burn progress summary section ## ${section} needs at least one bullet.`);
    }
  }
}

export async function appendBurnGoalSnapshot(input: {
  workspace: WorkspaceRecord;
  conversationId: string;
  progressPercent: number;
  summary: string;
  headline?: string | null;
}): Promise<BurnGoalRecord> {
  const current = await readBurnGoalForConversation(input);
  if (!current) {
    throw new Error("No Burn goal exists for this conversation.");
  }
  const progressPercent = Math.min(100, Math.max(0, Math.round(input.progressPercent)));
  if (!Number.isFinite(input.progressPercent) || progressPercent !== input.progressPercent) {
    throw new Error("burn_goal_summarize.progressPercent must be an integer from 0 to 100.");
  }
  const summary = input.summary.trim();
  if (!summary) {
    throw new Error("burn_goal_summarize.summary is required.");
  }
  validateBurnGoalSnapshotSummary(summary);
  const nextRevision = current.revision + 1;
  const snapshot: BurnGoalProgressSnapshot = {
    id: `burn-snapshot-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    createdAt: nowMs(),
    progressPercent,
    summary,
    headline: stringValue(input.headline) ?? undefined,
    revision: nextRevision,
  };
  return updateBurnGoal({
    workspace: input.workspace,
    conversationId: input.conversationId,
    patch: {
      progressPercent,
      headline: snapshot.headline ?? current.headline,
      snapshots: [...current.snapshots, snapshot].slice(-BURN_GOAL_SNAPSHOT_LIMIT),
      revision: nextRevision,
      status: current.status === "planning" ? "active" : current.status,
      phase: current.phase === "planning" ? "executing" : current.phase,
    },
  });
}

export async function updateBurnGoalProgress(input: {
  workspace: WorkspaceRecord;
  conversationId: string;
  milestones?: unknown[];
  todos?: unknown[];
  verificationEvidence?: unknown[];
}): Promise<BurnGoalRecord> {
  const current = await readBurnGoalForConversation(input);
  if (!current) {
    throw new Error("No Burn goal exists for this conversation.");
  }
  return updateBurnGoal({
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

export async function blockBurnGoal(input: {
  workspace: WorkspaceRecord;
  conversationId: string;
  reason: string;
  evidence?: string | null;
}): Promise<BurnGoalRecord> {
  const current = await readBurnGoalForConversation(input);
  if (!current) {
    throw new Error("No Burn goal exists for this conversation.");
  }
  const normalizedReason = input.reason.trim();
  const existing = current.blockerHistory.find(
    (item) => item.reason.trim().toLowerCase() === normalizedReason.toLowerCase()
  );
  const blocker: BurnGoalBlocker = existing
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
    return updateBurnGoal({
      workspace: input.workspace,
      conversationId: input.conversationId,
      patch: { blockerHistory },
    });
  }
  return updateBurnGoal({
    workspace: input.workspace,
    conversationId: input.conversationId,
    patch: { blockerHistory, status: "blocked" },
  });
}

export async function pauseBurnGoal(input: {
  workspace: WorkspaceRecord;
  conversationId: string;
  reason?: string | null;
}): Promise<BurnGoalRecord> {
  const current = await readBurnGoalForConversation(input);
  if (!current) {
    throw new Error("No Burn goal exists for this conversation.");
  }
  if (current.status === "complete" || current.status === "cancelled") {
    throw new Error(`Cannot pause a Burn goal with status ${current.status}.`);
  }
  const reason = stringValue(input.reason);
  return updateBurnGoal({
    workspace: input.workspace,
    conversationId: input.conversationId,
    patch: {
      status: "paused",
      headline: reason ? `Paused: ${reason}` : current.headline,
    },
  });
}

export async function resumeBurnGoal(input: {
  workspace: WorkspaceRecord;
  conversationId: string;
}): Promise<BurnGoalRecord> {
  const current = await readBurnGoalForConversation(input);
  if (!current) {
    throw new Error("No Burn goal exists for this conversation.");
  }
  if (current.status === "complete" || current.status === "cancelled") {
    throw new Error(`Cannot resume a Burn goal with status ${current.status}.`);
  }
  return updateBurnGoal({
    workspace: input.workspace,
    conversationId: input.conversationId,
    patch: {
      status: "active",
      phase: current.phase === "planning" ? "executing" : current.phase,
    },
  });
}

export async function completeBurnGoal(input: {
  workspace: WorkspaceRecord;
  conversationId: string;
}): Promise<BurnGoalRecord> {
  const current = await readBurnGoalForConversation(input);
  if (!current) {
    throw new Error("No Burn goal exists for this conversation.");
  }
  const incompleteMilestones = current.milestones.filter((item) => item.status !== "completed");
  const incompleteTodos = current.todos.filter((item) => item.status !== "completed");
  const failedEvidence = current.verificationEvidence.filter((item) => item.status !== "passed");
  if (incompleteMilestones.length || incompleteTodos.length || failedEvidence.length) {
    throw new Error(
      [
        "Burn goal is not complete yet.",
        incompleteMilestones.length ? `${incompleteMilestones.length} milestone(s) remain.` : null,
        incompleteTodos.length ? `${incompleteTodos.length} todo(s) remain.` : null,
        failedEvidence.length ? `${failedEvidence.length} verification item(s) are not passed.` : null,
      ].filter(Boolean).join(" ")
    );
  }
  return updateBurnGoal({
    workspace: input.workspace,
    conversationId: input.conversationId,
    patch: {
      status: "complete",
      phase: "complete",
      completedAt: nowMs(),
    },
  });
}

function formatBurnSnapshotForModel(snapshot: BurnGoalProgressSnapshot): string {
  return [
    `Updated: ${new Date(snapshot.createdAt).toISOString()}`,
    `Progress: ${snapshot.progressPercent}%`,
    snapshot.headline ? `Headline: ${snapshot.headline}` : null,
    `Revision: ${snapshot.revision}`,
    snapshot.summary,
  ].filter(Boolean).join("\n");
}

function formatRecentBurnSnapshotsForModel(goal: BurnGoalRecord): string {
  const recent = goal.snapshots.slice(-3);
  if (recent.length === 0) {
    return "- No Burn progress snapshots have been recorded yet.";
  }
  return recent
    .map((snapshot, index) =>
      [
        `### ${index === recent.length - 1 ? "Latest" : "Previous"} Progress Snapshot`,
        formatBurnSnapshotForModel(snapshot),
      ].join("\n")
    )
    .join("\n\n");
}

export function formatBurnGoalForModel(goal: BurnGoalRecord): string {
  const latestSnapshot = goal.snapshots.at(-1);
  const snapshotFreshness = burnGoalLatestSnapshotFreshness(goal);
  return [
    `Burn goal id: ${goal.goalId}`,
    `Objective: ${goal.objective}`,
    `Revision: ${goal.revision}`,
    goal.progressPercent == null ? null : `Progress: ${goal.progressPercent}%`,
    goal.headline ? `Headline: ${goal.headline}` : null,
    `Latest summary freshness: ${snapshotFreshness}`,
    burnGoalRemainingSummary(goal),
    latestSnapshot
      ? [
          "",
          "## Latest Progress Snapshot",
          formatBurnSnapshotForModel(latestSnapshot),
        ].filter(Boolean).join("\n")
      : null,
    "",
    "## Recent Progress Snapshot History",
    formatRecentBurnSnapshotsForModel(goal),
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
