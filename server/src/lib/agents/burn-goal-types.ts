export type BurnGoalStatus =
  | "planning"
  | "active"
  | "paused"
  | "blocked"
  | "usage_limited"
  | "budget_limited"
  | "complete"
  | "cancelled";

export type BurnGoalPhase =
  | "planning"
  | "executing"
  | "milestone_review"
  | "final_audit"
  | "complete";

export type BurnGoalItemStatus =
  | "pending"
  | "in_progress"
  | "blocked"
  | "completed";

export type BurnGoalMilestone = {
  id: string;
  title: string;
  description?: string;
  status: BurnGoalItemStatus;
  evidence?: string;
  updatedAt: number;
};

export type BurnGoalTodo = {
  id: string;
  content: string;
  status: BurnGoalItemStatus;
  milestoneId?: string;
  evidence?: string;
  updatedAt: number;
};

export type BurnGoalBlocker = {
  id: string;
  reason: string;
  occurrenceCount: number;
  firstSeenAt: number;
  lastSeenAt: number;
  evidence?: string;
};

export type BurnGoalVerification = {
  requirement: string;
  status: "unverified" | "passed" | "failed";
  evidence?: string;
  updatedAt: number;
};

export type BurnGoalProgressSnapshot = {
  id: string;
  createdAt: number;
  progressPercent: number;
  summary: string;
  headline?: string;
  revision: number;
};

export type BurnGoalCompactionMetadata = {
  generation: number;
  lastCompactedSeq?: number;
  sourceRange?: { fromSeq: number; toSeq: number };
  summaryTokens?: number;
  retainedTokens?: number;
  updatedAt?: number;
};

export type BurnGoalRecord = {
  schemaVersion: 1;
  goalId: string;
  workspaceId: string;
  conversationId: string;
  objective: string;
  status: BurnGoalStatus;
  phase: BurnGoalPhase;
  tokenBudget: number | null;
  tokensUsed: number;
  timeUsedSeconds: number;
  progressPercent: number | null;
  headline: string | null;
  revision: number;
  planSummary: string;
  milestones: BurnGoalMilestone[];
  todos: BurnGoalTodo[];
  blockerHistory: BurnGoalBlocker[];
  verificationEvidence: BurnGoalVerification[];
  snapshots: BurnGoalProgressSnapshot[];
  compaction: BurnGoalCompactionMetadata;
  createdAt: number;
  updatedAt: number;
  completedAt: number | null;
};

export type BurnGoalPatch = Partial<
  Pick<
    BurnGoalRecord,
    | "objective"
    | "status"
    | "phase"
    | "tokenBudget"
    | "tokensUsed"
    | "timeUsedSeconds"
    | "progressPercent"
    | "headline"
    | "revision"
    | "planSummary"
    | "milestones"
    | "todos"
    | "blockerHistory"
    | "verificationEvidence"
    | "snapshots"
    | "compaction"
    | "completedAt"
  >
>;

export const BURN_GOAL_SNAPSHOT_LIMIT = 25;
export const BURN_GOAL_SNAPSHOT_STALE_MS = 45 * 60 * 1000;

export function normalizeBurnGoalProgressPercent(value: unknown): number | null {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return null;
  }
  return Math.min(100, Math.max(0, Math.round(value)));
}

export function normalizeBurnGoalRevision(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return 0;
  }
  return Math.max(0, Math.round(value));
}

export function normalizeBurnGoalSnapshots(value: unknown): BurnGoalProgressSnapshot[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value.flatMap((item): BurnGoalProgressSnapshot[] => {
    if (!item || typeof item !== "object") {
      return [];
    }
    const record = item as Partial<BurnGoalProgressSnapshot>;
    const id = typeof record.id === "string" && record.id.trim() ? record.id.trim() : "";
    const createdAt =
      typeof record.createdAt === "number" && Number.isFinite(record.createdAt)
        ? record.createdAt
        : null;
    const progressPercent = normalizeBurnGoalProgressPercent(record.progressPercent);
    const summary =
      typeof record.summary === "string" && record.summary.trim()
        ? record.summary.trim()
        : "";
    if (!id || createdAt == null || progressPercent == null || !summary) {
      return [];
    }
    const headline =
      typeof record.headline === "string" && record.headline.trim()
        ? record.headline.trim()
        : undefined;
    return [
      {
        id,
        createdAt,
        progressPercent,
        summary,
        headline,
        revision: normalizeBurnGoalRevision(record.revision),
      },
    ];
  }).slice(-BURN_GOAL_SNAPSHOT_LIMIT);
}

export function burnGoalHasRunnableWork(goal: BurnGoalRecord | null): boolean {
  if (!goal) return false;
  if (
    goal.status !== "planning" &&
    goal.status !== "active"
  ) {
    return false;
  }
  if (goal.phase === "complete") return false;
  return (
    goal.milestones.some((item) => item.status === "pending" || item.status === "in_progress") ||
    goal.todos.some((item) => item.status === "pending" || item.status === "in_progress") ||
    goal.phase === "planning" ||
    goal.phase === "final_audit"
  );
}

export function burnGoalLatestSnapshotFreshness(
  goal: BurnGoalRecord,
  nowMs = Date.now()
): "missing" | "fresh" | "stale" {
  const latest = goal.snapshots.at(-1);
  if (!latest) {
    return "missing";
  }
  return nowMs - latest.createdAt > BURN_GOAL_SNAPSHOT_STALE_MS ? "stale" : "fresh";
}

export function burnGoalRemainingSummary(goal: BurnGoalRecord): string {
  const runnableMilestones = goal.milestones.filter(
    (item) => item.status === "pending" || item.status === "in_progress"
  );
  const runnableTodos = goal.todos.filter(
    (item) => item.status === "pending" || item.status === "in_progress"
  );
  const blockedTodos = goal.todos.filter((item) => item.status === "blocked");
  return [
    `Phase: ${goal.phase}`,
    `Status: ${goal.status}`,
    `Milestones remaining: ${runnableMilestones.length}`,
    `Todos remaining: ${runnableTodos.length}`,
    blockedTodos.length ? `Blocked todos: ${blockedTodos.length}` : null,
  ].filter(Boolean).join("\n");
}
