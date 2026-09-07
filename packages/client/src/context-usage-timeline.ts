import type {
  AgentContextSegmentKind,
  AgentContextUsageCategoryId,
  AgentContextUsageSegment,
} from "@cesium/core";

export type ContextUsageViewMode = "pooled" | "sequential";

export const CONTEXT_USAGE_VIEW_MODE_STORAGE_KEY = "opencursor.context-usage.view-mode";

export function isContextUsageViewMode(value: unknown): value is ContextUsageViewMode {
  return value === "pooled" || value === "sequential";
}

export function readStoredContextUsageViewMode(
  storage: Pick<Storage, "getItem"> | null | undefined
): ContextUsageViewMode {
  try {
    const raw = storage?.getItem(CONTEXT_USAGE_VIEW_MODE_STORAGE_KEY);
    return isContextUsageViewMode(raw) ? raw : "pooled";
  } catch {
    return "pooled";
  }
}

export function writeStoredContextUsageViewMode(
  storage: Pick<Storage, "setItem"> | null | undefined,
  mode: ContextUsageViewMode
): void {
  try {
    storage?.setItem(CONTEXT_USAGE_VIEW_MODE_STORAGE_KEY, mode);
  } catch {
    // Private mode / quota errors must never break the panel.
  }
}

/** Plural noun used when a run of small same-category blocks is collapsed into one row. */
const CATEGORY_GROUP_NOUN: Record<AgentContextUsageCategoryId, string> = {
  system_prompt: "system prompt blocks",
  tool_definitions: "tool definition blocks",
  mcp: "MCP blocks",
  summarized_conversation: "compaction summaries",
  conversation: "conversation blocks",
};

export type CondensedContextSegment = {
  id: string;
  kind: AgentContextSegmentKind | "group";
  categoryId: AgentContextUsageCategoryId;
  colorKey: string;
  label: string;
  detail?: string;
  tokens: number;
  /** Number of underlying timeline segments (1 for a standalone block). */
  count: number;
  segmentIds: string[];
  seqStart?: number;
  seqEnd?: number;
};

/**
 * Threshold under which a block is "small" for legend condensing: half a
 * percent of the window, never below 500 tokens so tiny windows still group.
 */
export function contextTimelineCondenseThreshold(limitTokens: number): number {
  return Math.max(500, Math.round(limitTokens * 0.005));
}

function groupRow(run: AgentContextUsageSegment[]): CondensedContextSegment {
  const first = run[0]!;
  if (run.length === 1) {
    return {
      id: first.id,
      kind: first.kind,
      categoryId: first.categoryId,
      colorKey: first.colorKey,
      label: first.label,
      detail: first.detail,
      tokens: first.tokens,
      count: 1,
      segmentIds: [first.id],
      seqStart: first.seqStart,
      seqEnd: first.seqEnd,
    };
  }
  const last = run[run.length - 1]!;
  const kinds = new Map<string, number>();
  for (const segment of run) {
    kinds.set(segment.kind, (kinds.get(segment.kind) ?? 0) + 1);
  }
  const kindSummary = [...kinds.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 3)
    .map(([kind, count]) => `${count} ${describeContextSegmentKind(kind as AgentContextSegmentKind, count)}`)
    .join(", ");
  return {
    id: `group:${first.id}:${last.id}`,
    kind: "group",
    categoryId: first.categoryId,
    colorKey: first.colorKey,
    label: `${run.length} ${CATEGORY_GROUP_NOUN[first.categoryId]}`,
    detail: kindSummary,
    tokens: run.reduce((sum, segment) => sum + segment.tokens, 0),
    count: run.length,
    segmentIds: run.map((segment) => segment.id),
    seqStart: first.seqStart,
    seqEnd: last.seqEnd ?? last.seqStart,
  };
}

/**
 * Condense a chronological timeline for the compact dock legend. Runs of
 * consecutive same-category blocks that are each below `minTokens` collapse
 * into one group row; any block at or above the threshold stays standalone so
 * large insertions are always visible at the position they were loaded.
 */
export function condenseContextTimeline(
  segments: AgentContextUsageSegment[],
  options: { minTokens: number }
): CondensedContextSegment[] {
  const rows: CondensedContextSegment[] = [];
  let run: AgentContextUsageSegment[] = [];
  const flush = () => {
    if (run.length > 0) {
      rows.push(groupRow(run));
      run = [];
    }
  };
  for (const segment of segments) {
    const small = segment.tokens < options.minTokens;
    if (!small) {
      flush();
      rows.push(groupRow([segment]));
      continue;
    }
    if (run.length > 0 && run[0]!.categoryId !== segment.categoryId) {
      flush();
    }
    run.push(segment);
  }
  flush();
  return rows;
}

export function describeContextSegmentKind(
  kind: AgentContextSegmentKind,
  count = 1
): string {
  const plural = count !== 1;
  switch (kind) {
    case "system_prompt":
      return plural ? "system prompts" : "system prompt";
    case "tool_definitions":
      return plural ? "tool definition sets" : "tool definitions";
    case "mcp_definitions":
      return plural ? "MCP sections" : "MCP section";
    case "user_message":
      return plural ? "user messages" : "user message";
    case "system_reminder":
      return plural ? "system reminders" : "system reminder";
    case "assistant_message":
      return plural ? "assistant replies" : "assistant reply";
    case "reasoning":
      return plural ? "reasoning blocks" : "reasoning";
    case "tool_call":
      return plural ? "tool calls" : "tool call";
    case "plan":
      return plural ? "plan updates" : "plan update";
    case "compaction_summary":
      return plural ? "compaction summaries" : "compaction summary";
    case "agent_handoff":
      return plural ? "agent handoffs" : "agent handoff";
    case "chat_fork":
      return plural ? "forked chats" : "forked chat";
    default:
      return plural ? "blocks" : "block";
  }
}

/** Largest blocks first - the answer to "what is eating my context?". */
export function largestContextSegments(
  segments: AgentContextUsageSegment[],
  limit = 3
): AgentContextUsageSegment[] {
  return [...segments].sort((a, b) => b.tokens - a.tokens).slice(0, Math.max(0, limit));
}
