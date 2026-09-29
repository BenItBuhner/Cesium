import type { AgentTokenUsage } from "../types.js";

export type CesiumRole = "system" | "user" | "assistant" | "tool";

export type CesiumHistoryToolCall = {
  id: string;
  name: string;
  arguments: string;
};

export type CesiumImagePart = {
  mimeType: string;
  data: string;
  name?: string;
};

export type CesiumHistoryMessage = {
  role: CesiumRole;
  content: string;
  /** Image attachments for multimodal / vision models (OpenAI-compatible image_url parts). */
  images?: CesiumImagePart[];
  toolCallId?: string;
  name?: string;
  toolCalls?: CesiumHistoryToolCall[];
};

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
  toolRequests: CesiumToolRequest[];
  usage?: AgentTokenUsage;
  stopReason?: CesiumStopReason;
  raw?: unknown;
};

export type CesiumAdapterStreamEvent =
  | { kind: "text_delta"; text: string; raw?: unknown }
  | { kind: "reasoning_delta"; text: string; raw?: unknown }
  | { kind: "tool_request"; request: CesiumToolRequest; raw?: unknown }
  | { kind: "usage"; usage: AgentTokenUsage; raw?: unknown }
  | { kind: "raw"; raw: unknown }
  | { kind: "done"; stopReason?: CesiumStopReason; raw?: unknown };
