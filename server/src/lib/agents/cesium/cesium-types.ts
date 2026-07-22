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
};

export type CesiumTokenUsage = {
  inputTokens?: number;
  outputTokens?: number;
  totalTokens?: number;
};

export type CesiumAdapterResult = {
  text: string;
  reasoning?: string;
  toolRequests: CesiumToolRequest[];
  usage?: CesiumTokenUsage;
  raw?: unknown;
};

export type CesiumAdapterStreamEvent =
  | { kind: "text_delta"; text: string; raw?: unknown }
  | { kind: "reasoning_delta"; text: string; raw?: unknown }
  | { kind: "tool_request"; request: CesiumToolRequest; raw?: unknown }
  | { kind: "raw"; raw: unknown }
  | { kind: "done"; raw?: unknown; usage?: CesiumTokenUsage };
