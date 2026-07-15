import type { AgentStoredEvent } from "@/lib/agent-types";

/** Recompute context usage after this many completed assistant messages. */
export const CONTEXT_USAGE_RESPONSES_PER_REFRESH = 2;

/** Recompute context usage after each completed or failed tool call. */
export const CONTEXT_USAGE_TOOL_RESULTS_PER_REFRESH = 1;

/**
 * Monotonic generation for context-usage fetches. Bumps on completed tool calls
 * and every N assistant completions (`assistant_message_end`).
 */
export function computeContextUsageRefreshGeneration(
  events: AgentStoredEvent[] | undefined,
  options?: {
    assistantResponsesPerRefresh?: number;
    toolResultsPerRefresh?: number;
  }
): number {
  if (!events?.length) {
    return 0;
  }
  const assistantPer =
    options?.assistantResponsesPerRefresh ?? CONTEXT_USAGE_RESPONSES_PER_REFRESH;
  const toolPer = options?.toolResultsPerRefresh ?? CONTEXT_USAGE_TOOL_RESULTS_PER_REFRESH;
  if (assistantPer < 1 || toolPer < 1) {
    return 0;
  }

  let assistantEnds = 0;
  let toolResults = 0;
  for (const event of events) {
    if (event.kind === "assistant_message_end") {
      assistantEnds += 1;
    } else if (
      event.kind === "tool_call_update" &&
      (event.status === "completed" || event.status === "failed")
    ) {
      toolResults += 1;
    }
  }

  return (
    Math.floor(assistantEnds / assistantPer) + Math.floor(toolResults / toolPer)
  );
}
