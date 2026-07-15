import type {
  InteractionUpdate,
  SDKAssistantMessage,
  SDKMessage,
  SDKStatusMessage,
  SDKTaskMessage,
  SDKThinkingMessage,
  SDKToolUseMessage,
} from "@cursor/sdk";
import type {
  AgentEventInput,
  AgentPlanEntry,
  AgentStoredEvent,
  AgentToolCallStatus,
  AgentToolLocation,
} from "./types.js";
import { asRecord, firstString } from "./json-coerce.js";
import {
  detailForToolPayload,
  inferCanonicalToolKind,
  locationsForToolPayload,
  titleForCanonicalTool,
} from "./tool-normalize.js";

type CursorSdkToolPayload = {
  name?: string;
  args?: unknown;
  result?: unknown;
  toolCall?: unknown;
};

const PATH_KEYS = [
  "path",
  "file",
  "filepath",
  "filePath",
  "targetFile",
  "target_file",
  "absolutePath",
  "relativePath",
];

function nestedValue(record: Record<string, unknown> | undefined): Record<string, unknown> | undefined {
  return asRecord(record?.value);
}

function compactJson(value: unknown, limit = 360): string | undefined {
  if (value == null) {
    return undefined;
  }
  const text = typeof value === "string" ? value : JSON.stringify(value);
  const trimmed = text.trim();
  if (!trimmed) {
    return undefined;
  }
  return trimmed.length > limit ? `${trimmed.slice(0, limit - 1)}…` : trimmed;
}

function inferToolKind(name: string, payload: CursorSdkToolPayload): string {
  return inferCanonicalToolKind({
    name,
    input: payload.args,
    result: payload.result,
  });
}

function statusFromSdk(status: SDKToolUseMessage["status"]): AgentToolCallStatus {
  switch (status) {
    case "running":
      return "in_progress";
    case "completed":
      return "completed";
    case "error":
      return "failed";
    default: {
      const exhaustive: never = status;
      return exhaustive;
    }
  }
}

function titleForTool(name: string, kind: string, payload: CursorSdkToolPayload): string {
  return titleForCanonicalTool({
    name,
    kind,
    payload: { input: payload.args, result: payload.result },
  });
}

function locationsForTool(payload: CursorSdkToolPayload): AgentToolLocation[] | undefined {
  return locationsForToolPayload({ input: payload.args, result: payload.result });
}

function detailForTool(payload: CursorSdkToolPayload): string | undefined {
  return detailForToolPayload({ input: payload.args, result: payload.result });
}

export function textFromCursorSdkAssistantMessage(event: SDKAssistantMessage): string {
  return event.message.content
    .flatMap((block) => (block.type === "text" ? [block.text] : []))
    .join("");
}

export function cursorSdkToolEventToAgentEvent(input: {
  event: SDKToolUseMessage;
  conversationId: string;
  eventId: string;
}): AgentEventInput {
  const payload: CursorSdkToolPayload = {
    name: input.event.name,
    args: input.event.args,
    result: input.event.result,
  };
  const toolKind = inferToolKind(input.event.name, payload);
  const common = {
    eventId: input.eventId,
    conversationId: input.conversationId,
    toolCallId: input.event.call_id,
    title: titleForTool(input.event.name, toolKind, payload),
    toolKind,
    status: statusFromSdk(input.event.status),
    detail: detailForTool(payload),
    locations: locationsForTool(payload),
    raw: input.event,
  };
  return input.event.status === "running"
    ? { kind: "tool_call", ...common }
    : { kind: "tool_call_update", ...common };
}

function todoLikeText(value: Record<string, unknown>): string {
  return (
    firstString(value, ["content", "text", "title", "description"]) ??
    compactJson(value, 120) ??
    "Todo item"
  );
}

function todoLikeStatus(value: Record<string, unknown>): AgentPlanEntry["status"] {
  const raw = firstString(value, ["status", "state"])?.toLowerCase();
  if (raw === "completed" || raw === "done") return "completed";
  if (raw === "blocked" || raw === "stuck") return "blocked";
  if (
    raw === "in_progress" ||
    raw === "inprogress" ||
    raw === "in progress" ||
    raw === "running"
  ) return "in_progress";
  return "pending";
}

export function isTodoToolName(name: string): boolean {
  return /todo/i.test(name);
}

export function isCreatePlanToolName(name: string): boolean {
  const lowered = name.toLowerCase();
  return lowered.includes("create_plan") || lowered === "createplan" || lowered === "cursor/create_plan";
}

export function isAskQuestionToolName(name: string): boolean {
  const lowered = name.toLowerCase();
  return (
    lowered.includes("ask_question") ||
    lowered.includes("askquestion") ||
    lowered === "cursor/ask_question"
  );
}

export function isPlanMarkdownPath(path: string): boolean {
  const normalized = path.replace(/\\/g, "/").toLowerCase();
  return (
    normalized.endsWith(".plan.md") ||
    normalized.includes("/.cursor/plans/") ||
    normalized.startsWith(".cursor/plans/") ||
    normalized.includes("/plans/") && normalized.endsWith(".md")
  );
}

export function detectPlanFilePathFromToolPayload(payload: CursorSdkToolPayload): string | undefined {
  const records = [asRecord(payload.args), asRecord(payload.result), nestedValue(asRecord(payload.result))].filter(
    (value): value is Record<string, unknown> => value != null
  );
  for (const record of records) {
    const path =
      firstString(record, PATH_KEYS) ??
      firstString(record, ["planUri", "plan_uri", "uri", "filePath", "filepath"]);
    if (path && isPlanMarkdownPath(path)) {
      return path;
    }
  }
  return undefined;
}

export type CursorSdkCreatePlanPayload = {
  name?: string;
  overview?: string;
  planMarkdown?: string;
  planUri?: string;
  entries: AgentPlanEntry[];
};

export function parseCursorSdkCreatePlanPayload(payload: unknown): CursorSdkCreatePlanPayload | null {
  const record = asRecord(payload);
  if (!record) {
    return null;
  }
  const planMarkdown =
    firstString(record, ["plan", "markdown", "content", "body"]) ??
    (typeof record.plan === "string" ? record.plan : undefined);
  const entries = planEntriesFromCursorSdkToolPayload(record);
  const name = firstString(record, ["name", "title"]);
  const overview = firstString(record, ["overview", "summary"]);
  const planUri = firstString(record, ["planUri", "plan_uri", "uri"]);
  if (!planMarkdown && entries.length === 0 && !name && !overview) {
    return null;
  }
  return {
    name,
    overview,
    planMarkdown,
    planUri,
    entries,
  };
}

export type CursorSdkAskQuestionPayload = {
  prompt: string;
  options: Array<{ id: string; label: string }>;
  questions?: Array<{
    id: string;
    prompt: string;
    options: Array<{ id: string; label: string }>;
    allowMultiple?: boolean;
  }>;
  allowMultiple?: boolean;
};

export function parseCursorSdkAskQuestionPayload(payload: unknown): CursorSdkAskQuestionPayload | null {
  const record = asRecord(payload);
  if (!record) {
    return null;
  }
  const prompt =
    firstString(record, ["prompt", "question", "title", "text"]) ??
    firstString(asRecord(record.question), ["prompt", "text"]);
  if (!prompt) {
    return null;
  }
  const rawOptions =
    (Array.isArray(record.options) && record.options) ||
    (Array.isArray(record.choices) && record.choices) ||
    [];
  const options = rawOptions.flatMap((item, index) => {
    if (typeof item === "string" && item.trim()) {
      return [{ id: `option-${index}`, label: item.trim() }];
    }
    const optionRecord = asRecord(item);
    if (!optionRecord) {
      return [];
    }
    const label =
      firstString(optionRecord, ["label", "text", "name", "title"]) ??
      firstString(optionRecord, ["id"]);
    if (!label) {
      return [];
    }
    return [
      {
        id: firstString(optionRecord, ["id"]) ?? `option-${index}`,
        label,
      },
    ];
  });
  if (options.length === 0) {
    return null;
  }
  return {
    prompt,
    options,
    allowMultiple: record.allowMultiple === true || record.allow_multiple === true,
  };
}

export function planEntriesFromCursorSdkToolPayload(payload: unknown): AgentPlanEntry[] {
  const record = asRecord(payload);
  const maybeList =
    (Array.isArray(record?.todos) && record?.todos) ||
    (Array.isArray(record?.items) && record?.items) ||
    (Array.isArray(record?.list) && record?.list) ||
    (Array.isArray(payload) && payload) ||
    [];
  return maybeList.flatMap((item, index): AgentPlanEntry[] => {
    const itemRecord = asRecord(item);
    if (!itemRecord) {
      return [];
    }
    const content = todoLikeText(itemRecord).trim();
    if (!content) {
      return [];
    }
    return [
      {
        id: firstString(itemRecord, ["id"]) ?? `cursor-sdk-todo-${index}`,
        content,
        status: todoLikeStatus(itemRecord),
      },
    ];
  });
}

export function cursorSdkMessageKind(event: SDKMessage): SDKMessage["type"] {
  return event.type;
}

export function cursorSdkStatusToAgentStatus(
  event: SDKStatusMessage
): Extract<AgentStoredEvent, { kind: "status" }>["status"] | null {
  switch (event.status) {
    case "CREATING":
    case "RUNNING":
      return "running";
    case "FINISHED":
      return "idle";
    case "ERROR":
      return "failed";
    case "CANCELLED":
      return "cancelled";
    case "EXPIRED":
      return "failed";
    default: {
      const exhaustive: never = event.status;
      return exhaustive;
    }
  }
}

export function cursorSdkTaskText(event: SDKTaskMessage): string | undefined {
  return event.text?.trim() || event.status?.trim() || undefined;
}

export function cursorSdkThinkingText(event: SDKThinkingMessage): string {
  return event.text;
}

export function cursorSdkDeltaText(update: InteractionUpdate): {
  kind: "assistant" | "thinking" | "shell" | "none";
  text?: string;
  raw?: unknown;
} {
  switch (update.type) {
    case "text-delta":
      return { kind: "assistant", text: update.text, raw: update };
    case "thinking-delta":
      return { kind: "thinking", text: update.text, raw: update };
    case "shell-output-delta":
      return { kind: "shell", text: compactJson(update.event), raw: update };
    case "thinking-completed":
    case "tool-call-started":
    case "tool-call-completed":
    case "partial-tool-call":
    case "token-delta":
    case "step-started":
    case "step-completed":
    case "turn-ended":
    case "user-message-appended":
    case "summary":
    case "summary-started":
    case "summary-completed":
      return { kind: "none", raw: update };
    default:
      return { kind: "none", raw: update };
  }
}
