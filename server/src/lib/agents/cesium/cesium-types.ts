import type { CesiumNativeReasoning } from "@cesium/core/cesium-history";
import type { AgentTokenUsage } from "../types.js";

export type {
  CesiumHistoryMessage,
  CesiumHistoryToolCall,
  CesiumImagePart,
  CesiumNativeReasoning,
  CesiumRole,
} from "@cesium/core/cesium-history";

export type CesiumToolRequest = {
  id: string;
  name: string;
  arguments: Record<string, unknown>;
  /** Length of the argument text when it was not valid JSON; `arguments` is then `{}`. */
  unparsedArgumentChars?: number;
};

/** Why the model stopped; `length` means it ran into the output-token limit. */
export type CesiumStopReason = "stop" | "tool_calls" | "length" | "other";

export type CesiumAdapterResult = {
  text: string;
  reasoning?: string;
  nativeReasoning?: CesiumNativeReasoning;
  toolRequests: CesiumToolRequest[];
  usage?: AgentTokenUsage;
  stopReason?: CesiumStopReason;
  raw?: unknown;
};

/** Adds one response's native reasoning items to what the response already produced. */
export function appendNativeReasoning(
  current: CesiumNativeReasoning | undefined,
  next: CesiumNativeReasoning
): CesiumNativeReasoning {
  return current && current.format === next.format
    ? { format: current.format, items: [...current.items, ...next.items] }
    : next;
}

export type CesiumAdapterStreamEvent =
  | { kind: "text_delta"; text: string; raw?: unknown }
  | { kind: "reasoning_delta"; text: string; raw?: unknown }
  | { kind: "native_reasoning"; reasoning: CesiumNativeReasoning; raw?: unknown }
  | { kind: "tool_request"; request: CesiumToolRequest; raw?: unknown }
  | { kind: "usage"; usage: AgentTokenUsage; raw?: unknown }
  | { kind: "raw"; raw: unknown }
  | { kind: "done"; stopReason?: CesiumStopReason; raw?: unknown };
