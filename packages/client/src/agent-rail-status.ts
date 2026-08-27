import type { AgentRailConversationSummary } from "@cesium/core";

/**
 * Presentation-level status for one agent rail row.
 *
 * Collapses the raw conversation status + pending-intervention fields into a
 * small set of states the rail can rank and render consistently. Ordered by
 * priority: states that need the user first, then active work, then results.
 */
export type AgentRailStatusKind =
  | "permission"
  | "question"
  | "failed"
  | "running"
  | "pausing"
  | "paused"
  | "done_unread"
  | "stopped"
  | "idle"
  | "settled";

/** Visual tone; maps onto existing theme tokens in the row component. */
export type AgentRailStatusTone =
  | "attention"
  | "error"
  | "active"
  | "accent"
  | "muted";

export type AgentRailStatusInfo = {
  kind: AgentRailStatusKind;
  /** 0 = most urgent. Used to order the Needs-attention section. */
  priority: number;
  /** True when the conversation is blocked on a user decision or failed. */
  needsAttention: boolean;
  /** True while the agent itself is doing work. */
  active: boolean;
  tone: AgentRailStatusTone;
  /**
   * One short line describing what the conversation needs or is doing.
   * `null` for settled states that need no callout (idle / read results).
   */
  description: string | null;
};

const STATUS_PRIORITY: Record<AgentRailStatusKind, number> = {
  permission: 0,
  question: 1,
  failed: 2,
  running: 3,
  pausing: 4,
  paused: 5,
  done_unread: 6,
  stopped: 7,
  idle: 8,
  // Explicitly settled by the user: always ranks below everything else until
  // a new prompt unsettles the conversation.
  settled: 9,
};

/** True when the user marked the conversation settled (and nothing cleared it since). */
export function agentRailConversationIsSettled(
  conversation: Pick<AgentRailConversationSummary, "settledAt" | "settledUntil">,
  now = Date.now()
): boolean {
  if (conversation.settledAt == null) {
    return false;
  }
  // Timed settle ("ignore for a day"): treated as unsettled once it elapses,
  // even before the server's lazy expiry catches up on the next refresh.
  if (conversation.settledUntil != null && conversation.settledUntil <= now) {
    return false;
  }
  return true;
}

export type AgentRailStatusContext = {
  /** True when the conversation finished a turn the user has not viewed yet. */
  unreadCompletion?: boolean;
  /** True when a failed run has been viewed (or seen while visible). */
  acknowledgedFailure?: boolean;
};

/** Needs a user decision (approval/answer) or an unread failure. */
export function agentRailConversationNeedsAttention(
  conversation: Pick<
    AgentRailConversationSummary,
    "status" | "hasPendingPermission" | "hasPendingQuestion" | "settledAt" | "settledUntil"
  >,
  ctx?: AgentRailStatusContext
): boolean {
  if (
    conversation.hasPendingPermission ||
    conversation.hasPendingQuestion === true ||
    conversation.status === "awaiting_permission" ||
    conversation.status === "awaiting_question"
  ) {
    return true;
  }
  if (conversation.status === "failed") {
    // Settling a failed conversation acknowledges the failure.
    return !ctx?.acknowledgedFailure && !agentRailConversationIsSettled(conversation);
  }
  return false;
}

export function getAgentRailStatusKind(
  conversation: Pick<
    AgentRailConversationSummary,
    "status" | "hasPendingPermission" | "hasPendingQuestion" | "settledAt" | "settledUntil"
  >,
  ctx?: AgentRailStatusContext
): AgentRailStatusKind {
  const settled = agentRailConversationIsSettled(conversation);
  // Blocked-on-user states always surface, settled or not: the agent cannot
  // proceed without a decision, and answering/prompting unsettles anyway.
  if (conversation.hasPendingPermission || conversation.status === "awaiting_permission") {
    return "permission";
  }
  if (conversation.hasPendingQuestion === true || conversation.status === "awaiting_question") {
    return "question";
  }
  if (conversation.status === "failed" && !ctx?.acknowledgedFailure && !settled) {
    return "failed";
  }
  // Live work keeps its spinner on the row even when settled; elevation into
  // the Running section is suppressed separately (agent-rail-elevate).
  if (conversation.status === "running") {
    return "running";
  }
  if (conversation.status === "pause_requested" || conversation.status === "pausing") {
    return "pausing";
  }
  if (conversation.status === "paused") {
    return settled ? "settled" : "paused";
  }
  if (settled) {
    // Settling also clears review status: the user has decided they're done.
    return "settled";
  }
  if (ctx?.unreadCompletion) {
    return "done_unread";
  }
  if (conversation.status === "cancelled" || conversation.status === "interrupted") {
    return "stopped";
  }
  return "idle";
}

export function getAgentRailStatusInfo(
  conversation: Pick<
    AgentRailConversationSummary,
    | "status"
    | "hasPendingPermission"
    | "hasPendingQuestion"
    | "pendingPermissionTitle"
    | "lastErrorSummary"
    | "settledAt"
    | "settledUntil"
  >,
  ctx?: AgentRailStatusContext
): AgentRailStatusInfo {
  const kind = getAgentRailStatusKind(conversation, ctx);
  const base = {
    kind,
    priority: STATUS_PRIORITY[kind],
    needsAttention: kind === "permission" || kind === "question" || kind === "failed",
    active: kind === "running" || kind === "pausing",
  };
  switch (kind) {
    case "permission":
      return {
        ...base,
        tone: "attention",
        description: conversation.pendingPermissionTitle
          ? `Needs approval · ${conversation.pendingPermissionTitle}`
          : "Needs your approval",
      };
    case "question":
      return { ...base, tone: "attention", description: "Waiting for your answer" };
    case "failed":
      return {
        ...base,
        tone: "error",
        description: conversation.lastErrorSummary
          ? `Failed · ${conversation.lastErrorSummary}`
          : "Run failed",
      };
    case "running":
      return { ...base, tone: "active", description: "Working…" };
    case "pausing":
      return { ...base, tone: "active", description: "Pausing…" };
    case "paused":
      return { ...base, tone: "muted", description: "Paused" };
    case "done_unread":
      return { ...base, tone: "accent", description: "Finished" };
    case "stopped":
      return { ...base, tone: "muted", description: null };
    case "settled":
      // Quiet on purpose: settled rows should take up as little room as
      // possible. The row's settle toggle is the visible state cue.
      return { ...base, tone: "muted", description: null };
    default:
      return { ...base, tone: "muted", description: null };
  }
}

/** Priority first (attention on top), then most recently updated. */
export function compareAgentRailByStatusPriority(
  a: Pick<
    AgentRailConversationSummary,
    "status" | "hasPendingPermission" | "hasPendingQuestion" | "settledAt" | "settledUntil" | "updatedAt" | "id"
  >,
  b: Pick<
    AgentRailConversationSummary,
    "status" | "hasPendingPermission" | "hasPendingQuestion" | "settledAt" | "settledUntil" | "updatedAt" | "id"
  >,
  ctx?: {
    unreadCompletionByConversationId?: Record<string, true>;
    acknowledgedFailureByConversationId?: Record<string, true>;
  }
): number {
  const pa =
    STATUS_PRIORITY[
      getAgentRailStatusKind(a, {
        unreadCompletion: Boolean(ctx?.unreadCompletionByConversationId?.[a.id]),
        acknowledgedFailure: Boolean(ctx?.acknowledgedFailureByConversationId?.[a.id]),
      })
    ];
  const pb =
    STATUS_PRIORITY[
      getAgentRailStatusKind(b, {
        unreadCompletion: Boolean(ctx?.unreadCompletionByConversationId?.[b.id]),
        acknowledgedFailure: Boolean(ctx?.acknowledgedFailureByConversationId?.[b.id]),
      })
    ];
  if (pa !== pb) {
    return pa - pb;
  }
  if (b.updatedAt !== a.updatedAt) {
    return b.updatedAt - a.updatedAt;
  }
  return a.id.localeCompare(b.id);
}

/** Compact "5m ago" style timestamps for rail row detail lines. */
export function formatAgentRailRelativeTime(timestamp: number, now = Date.now()): string {
  const seconds = Math.floor((now - timestamp) / 1000);
  const minutes = Math.floor(seconds / 60);
  const hours = Math.floor(minutes / 60);
  const days = Math.floor(hours / 24);
  if (days > 0) return `${days}d ago`;
  if (hours > 0) return `${hours}h ago`;
  if (minutes > 0) return `${minutes}m ago`;
  return "just now";
}

export const AGENT_RAIL_ROW_DETAIL_MODES = ["compact", "balanced", "expanded"] as const;

/**
 * How much per-row detail the rail shows.
 * - `compact`: strict single-line rows - title plus a status dot (spinner while
 *   running); no icons, no description text anywhere.
 * - `balanced`: single-line, but rows that need something (approval, answer,
 *   failure, active work, unread result) grow a small description line.
 * - `expanded`: every row shows a detail line (status or last-updated time).
 */
export type AgentRailRowDetailMode = (typeof AGENT_RAIL_ROW_DETAIL_MODES)[number];

export function isAgentRailRowDetailMode(value: unknown): value is AgentRailRowDetailMode {
  return (
    typeof value === "string" &&
    AGENT_RAIL_ROW_DETAIL_MODES.includes(value as AgentRailRowDetailMode)
  );
}

export const AGENT_RAIL_PRIORITY_BUCKETS = [
  "attention",
  "active",
  "review",
  "recent",
  "settled",
] as const;

/**
 * Flat priority grouping buckets, in render order. Urgent-first so the user
 * stays in flow: blocked-on-you, then working, then results to review, then
 * everything settled.
 */
export type AgentRailPriorityBucket = (typeof AGENT_RAIL_PRIORITY_BUCKETS)[number];

export const AGENT_RAIL_PRIORITY_BUCKET_LABELS: Record<AgentRailPriorityBucket, string> = {
  attention: "Needs attention",
  active: "Running",
  review: "Review",
  recent: "Recent",
  settled: "Settled",
};

export function getAgentRailPriorityBucket(
  conversation: Pick<
    AgentRailConversationSummary,
    "status" | "hasPendingPermission" | "hasPendingQuestion" | "settledAt" | "settledUntil"
  >,
  ctx?: AgentRailStatusContext
): AgentRailPriorityBucket {
  const kind = getAgentRailStatusKind(conversation, ctx);
  switch (kind) {
    case "permission":
    case "question":
    case "failed":
      return "attention";
    case "running":
    case "pausing":
      return "active";
    case "done_unread":
      return "review";
    case "settled":
      return "settled";
    default:
      return "recent";
  }
}
