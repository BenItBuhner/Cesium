export type GoalStatus =
  | "planning"
  | "active"
  | "paused"
  | "blocked"
  | "usage_limited"
  | "budget_limited"
  | "complete"
  | "cancelled";

export type GoalPhase =
  | "planning"
  | "executing"
  | "milestone_review"
  | "final_audit"
  | "complete";

export type GoalItemStatus =
  | "pending"
  | "in_progress"
  | "blocked"
  | "completed";

export type GoalMilestone = {
  id: string;
  title: string;
  description?: string;
  status: GoalItemStatus;
  evidence?: string;
  updatedAt: number;
};

export type GoalTodo = {
  id: string;
  content: string;
  status: GoalItemStatus;
  milestoneId?: string;
  evidence?: string;
  updatedAt: number;
};

export type GoalBlocker = {
  id: string;
  reason: string;
  occurrenceCount: number;
  firstSeenAt: number;
  lastSeenAt: number;
  evidence?: string;
};

export type GoalVerification = {
  requirement: string;
  status: "unverified" | "passed" | "failed";
  evidence?: string;
  updatedAt: number;
};

export type GoalProgressSnapshot = {
  id: string;
  createdAt: number;
  progressPercent: number;
  summary: string;
  headline?: string;
  revision: number;
};

export type GoalCompactionMetadata = {
  generation: number;
  lastCompactedSeq?: number;
  sourceRange?: { fromSeq: number; toSeq: number };
  summaryTokens?: number;
  retainedTokens?: number;
  updatedAt?: number;
};

export type GoalRecord = {
  schemaVersion: 1;
  goalId: string;
  workspaceId: string;
  conversationId: string;
  objective: string;
  status: GoalStatus;
  phase: GoalPhase;
  tokenBudget: number | null;
  tokensUsed: number;
  timeUsedSeconds: number;
  progressPercent: number | null;
  headline: string | null;
  revision: number;
  planSummary: string;
  milestones: GoalMilestone[];
  todos: GoalTodo[];
  blockerHistory: GoalBlocker[];
  verificationEvidence: GoalVerification[];
  snapshots: GoalProgressSnapshot[];
  compaction: GoalCompactionMetadata;
  createdAt: number;
  updatedAt: number;
  completedAt: number | null;
};

export type GoalPatch = Partial<
  Pick<
    GoalRecord,
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

export const GOAL_SNAPSHOT_LIMIT = 25;
export const GOAL_SNAPSHOT_STALE_MS = 45 * 60 * 1000;

export function normalizeGoalProgressPercent(value: unknown): number | null {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return null;
  }
  return Math.min(100, Math.max(0, Math.round(value)));
}

export function normalizeGoalRevision(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return 0;
  }
  return Math.max(0, Math.round(value));
}

export function normalizeGoalSnapshots(value: unknown): GoalProgressSnapshot[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value.flatMap((item): GoalProgressSnapshot[] => {
    if (!item || typeof item !== "object") {
      return [];
    }
    const record = item as Partial<GoalProgressSnapshot>;
    const id = typeof record.id === "string" && record.id.trim() ? record.id.trim() : "";
    const createdAt =
      typeof record.createdAt === "number" && Number.isFinite(record.createdAt)
        ? record.createdAt
        : null;
    const progressPercent = normalizeGoalProgressPercent(record.progressPercent);
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
        revision: normalizeGoalRevision(record.revision),
      },
    ];
  }).slice(-GOAL_SNAPSHOT_LIMIT);
}

export function goalHasRunnableWork(goal: GoalRecord | null): boolean {
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

export function goalLatestSnapshotFreshness(
  goal: GoalRecord,
  nowMs = Date.now()
): "missing" | "fresh" | "stale" {
  const latest = goal.snapshots.at(-1);
  if (!latest) {
    return "missing";
  }
  return nowMs - latest.createdAt > GOAL_SNAPSHOT_STALE_MS ? "stale" : "fresh";
}

export function goalRemainingSummary(goal: GoalRecord): string {
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
