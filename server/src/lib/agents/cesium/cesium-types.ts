export type CesiumRole = "system" | "user" | "assistant" | "tool";

export type CesiumHistoryToolCall = {
  id: string;
  name: string;
  arguments: string;
};

export type CesiumHistoryImage = {
  mimeType: string;
  data: string;
};

export type CesiumHistoryMessage = {
  role: CesiumRole;
  content: string;
  images?: CesiumHistoryImage[];
  toolCallId?: string;
  name?: string;
  toolCalls?: CesiumHistoryToolCall[];
};

export type CesiumToolRequest = {
  id: string;
  name: string;
  arguments: Record<string, unknown>;
};

export type CesiumAdapterResult = {
  text: string;
  reasoning?: string;
  toolRequests: CesiumToolRequest[];
  raw?: unknown;
};

export type CesiumAdapterStreamEvent =
  | { kind: "text_delta"; text: string; raw?: unknown }
  | { kind: "reasoning_delta"; text: string; raw?: unknown }
  | { kind: "tool_request"; request: CesiumToolRequest; raw?: unknown }
  | { kind: "raw"; raw: unknown }
  | { kind: "done"; raw?: unknown };
