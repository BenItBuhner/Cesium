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
  | "idle";

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
};

export type AgentRailStatusContext = {
  /** True when the conversation finished a turn the user has not viewed yet. */
  unreadCompletion?: boolean;
};

/** Needs a user decision (approval/answer) or ended in an error. */
export function agentRailConversationNeedsAttention(
  conversation: Pick<
    AgentRailConversationSummary,
    "status" | "hasPendingPermission" | "hasPendingQuestion"
  >
): boolean {
  return (
    conversation.hasPendingPermission ||
    conversation.hasPendingQuestion === true ||
    conversation.status === "awaiting_permission" ||
    conversation.status === "awaiting_question" ||
    conversation.status === "failed"
  );
}

export function getAgentRailStatusKind(
  conversation: Pick<
    AgentRailConversationSummary,
    "status" | "hasPendingPermission" | "hasPendingQuestion"
  >,
  ctx?: AgentRailStatusContext
): AgentRailStatusKind {
  if (conversation.hasPendingPermission || conversation.status === "awaiting_permission") {
    return "permission";
  }
  if (conversation.hasPendingQuestion === true || conversation.status === "awaiting_question") {
    return "question";
  }
  if (conversation.status === "failed") {
    return "failed";
  }
  if (conversation.status === "running") {
    return "running";
  }
  if (conversation.status === "pause_requested" || conversation.status === "pausing") {
    return "pausing";
  }
  if (conversation.status === "paused") {
    return "paused";
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
    default:
      return { ...base, tone: "muted", description: null };
  }
}

/** Priority first (attention on top), then most recently updated. */
export function compareAgentRailByStatusPriority(
  a: Pick<
    AgentRailConversationSummary,
    "status" | "hasPendingPermission" | "hasPendingQuestion" | "updatedAt" | "id"
  >,
  b: Pick<
    AgentRailConversationSummary,
    "status" | "hasPendingPermission" | "hasPendingQuestion" | "updatedAt" | "id"
  >,
  ctx?: { unreadCompletionByConversationId?: Record<string, true> }
): number {
  const pa =
    STATUS_PRIORITY[
      getAgentRailStatusKind(a, {
        unreadCompletion: Boolean(ctx?.unreadCompletionByConversationId?.[a.id]),
      })
    ];
  const pb =
    STATUS_PRIORITY[
      getAgentRailStatusKind(b, {
        unreadCompletion: Boolean(ctx?.unreadCompletionByConversationId?.[b.id]),
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

export const AGENT_RAIL_ROW_DETAIL_MODES = ["compact", "auto", "expanded"] as const;

/**
 * How much per-row detail the rail shows.
 * - `compact`: single-line rows (title + status glyph only).
 * - `auto`: single-line, but rows that need something (attention / running /
 *   failed / unread result) grow a small description line.
 * - `expanded`: every row shows a detail line (status or last-updated time).
 */
export type AgentRailRowDetailMode = (typeof AGENT_RAIL_ROW_DETAIL_MODES)[number];

export function isAgentRailRowDetailMode(value: unknown): value is AgentRailRowDetailMode {
  return (
    typeof value === "string" &&
    AGENT_RAIL_ROW_DETAIL_MODES.includes(value as AgentRailRowDetailMode)
  );
}
