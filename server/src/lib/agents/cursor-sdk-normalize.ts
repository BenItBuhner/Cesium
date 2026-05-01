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

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function firstString(record: Record<string, unknown> | undefined, keys: string[]): string | undefined {
  if (!record) {
    return undefined;
  }
  for (const key of keys) {
    const value = record[key];
    if (typeof value === "string" && value.trim()) {
      return value.trim();
    }
  }
  return undefined;
}

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

function humanizeToolName(name: string): string {
  return name
    .replace(/([a-z])([A-Z])/g, "$1 $2")
    .replace(/[_-]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/^./, (char) => char.toUpperCase());
}

function inferToolKind(name: string, payload: CursorSdkToolPayload): string {
  const lowered = name.toLowerCase();
  const haystack = `${lowered} ${compactJson(payload.args, 240) ?? ""} ${
    compactJson(payload.result, 240) ?? ""
  }`.toLowerCase();
  if (lowered.includes("todo")) return "todo";
  if (lowered.includes("task") || lowered.includes("agent")) return "task";
  if (lowered.includes("grep")) return "grep";
  if (lowered.includes("semsearch") || lowered.includes("semantic")) return "search";
  if (lowered.includes("glob") || lowered.includes("search") || lowered.includes("find")) return "search";
  if (lowered.includes("web")) return "search_web";
  if (lowered.includes("shell") || lowered.includes("terminal") || lowered.includes("bash")) return "terminal";
  if (/\b(delete|remove|rm)\b/.test(haystack)) return "delete";
  if (/\b(edit|write|patch|replace|update|create)\b/.test(haystack)) return "edit";
  if (/\b(read|open|view|cat)\b/.test(haystack)) return "read";
  return "tool";
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
  const args = asRecord(payload.args);
  const result = asRecord(payload.result);
  const path = firstString(args, PATH_KEYS) ?? firstString(result, PATH_KEYS);
  const query =
    firstString(args, ["query", "pattern", "regex", "search", "term", "globPattern"]) ??
    firstString(result, ["query", "pattern", "regex", "search", "term", "globPattern"]);
  const command = firstString(args, ["command", "cmd", "script"]);
  switch (kind) {
    case "read":
      return path ? `Read ${path}` : "Read file";
    case "edit":
      return path ? `Update ${path}` : "Update file";
    case "delete":
      return path ? `Delete ${path}` : "Delete file";
    case "grep":
      return query ? `Grep ${query}` : "Grep workspace";
    case "search":
      return query ? `Find ${query}` : "Find in workspace";
    case "search_web":
      return query ? `Web · ${query}` : "Web search";
    case "terminal":
      return command ? `Run ${command}` : "Run command";
    case "todo":
      return "Update todos";
    case "task":
      return "Task";
    default:
      return humanizeToolName(name);
  }
}

function locationsForTool(payload: CursorSdkToolPayload): AgentToolLocation[] | undefined {
  const result = asRecord(payload.result);
  const records = [asRecord(payload.args), result, nestedValue(result)].filter(
    (value): value is Record<string, unknown> => value != null
  );
  const paths = new Set<string>();
  for (const record of records) {
    const path = firstString(record, PATH_KEYS);
    if (path) {
      paths.add(path);
    }
    for (const key of ["files", "paths", "matchedFiles", "results"]) {
      const value = record[key];
      if (Array.isArray(value)) {
        for (const item of value) {
          if (typeof item === "string" && item.trim()) {
            paths.add(item.trim());
          } else {
            const itemPath = firstString(asRecord(item), PATH_KEYS);
            if (itemPath) {
              paths.add(itemPath);
            }
          }
        }
      }
    }
  }
  const locations = [...paths].slice(0, 24).map((path) => ({ path }));
  return locations.length > 0 ? locations : undefined;
}

function detailForTool(payload: CursorSdkToolPayload): string | undefined {
  const result = asRecord(payload.result);
  const value = nestedValue(result);
  const args = asRecord(payload.args);
  const totalFiles =
    typeof value?.totalFiles === "number"
      ? value.totalFiles
      : typeof result?.totalFiles === "number"
        ? result.totalFiles
        : undefined;
  if (totalFiles != null) {
    return `${totalFiles} files matched`;
  }
  const totalLines =
    typeof value?.totalLines === "number"
      ? value.totalLines
      : typeof result?.totalLines === "number"
        ? result.totalLines
        : undefined;
  if (totalLines != null) {
    return `${totalLines} lines`;
  }
  return (
    firstString(result, ["message", "summary", "error", "stderr", "stdout", "output"]) ??
    firstString(value, ["message", "summary", "error", "stderr", "stdout", "output"]) ??
    firstString(args, ["description", "prompt", "query", "command"]) ??
    compactJson(payload.result)
  );
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
  if (raw === "in_progress" || raw === "in progress" || raw === "running") return "in_progress";
  return "pending";
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
