import type { AgentEventInput, AgentPlanEntry, AgentToolCallStatus, AgentToolLocation } from "./types.js";
import { extractToolEditPreview } from "./tool-edit-preview.js";

type ToolPayload = {
  id?: string;
  name?: string;
  input?: unknown;
  result?: unknown;
  isError?: boolean;
};

const PATH_KEYS = [
  "path",
  "file",
  "file_path",
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

function compactJson(value: unknown, limit = 520): string | undefined {
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

function shellSearchPattern(command: string | undefined): string | undefined {
  if (!command) {
    return undefined;
  }
  const match =
    command.match(/\b(?:rg|grep)\b\s+(?:-[^\s]+\s+)*(?:"([^"]+)"|'([^']+)'|([^\s|&;]+))/i) ??
    command.match(/\b(?:rg|grep)\b.*?(?:"([^"]+)"|'([^']+)')/i);
  return match?.[1] ?? match?.[2] ?? match?.[3];
}

function humanizeToolName(name: string): string {
  return name
    .replace(/([a-z])([A-Z])/g, "$1 $2")
    .replace(/[_-]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/^./, (char) => char.toUpperCase());
}

export function textFromClaudeAssistantMessage(message: unknown): string {
  const content = asRecord(message)?.message;
  const blocks = Array.isArray(asRecord(content)?.content)
    ? (asRecord(content)?.content as unknown[])
    : [];
  return blocks
    .flatMap((block) => {
      const record = asRecord(block);
      return record?.type === "text" && typeof record.text === "string" ? [record.text] : [];
    })
    .join("");
}

export function thinkingTextFromClaudeAssistantMessage(message: unknown): string {
  const content = asRecord(message)?.message;
  const blocks = Array.isArray(asRecord(content)?.content)
    ? (asRecord(content)?.content as unknown[])
    : [];
  return blocks
    .flatMap((block) => {
      const record = asRecord(block);
      if (!record) {
        return [];
      }
      if (
        (record.type === "thinking" || record.type === "redacted_thinking") &&
        typeof record.thinking === "string"
      ) {
        return [record.thinking];
      }
      return [];
    })
    .join("\n");
}

export function toolUsesFromClaudeAssistantMessage(message: unknown): ToolPayload[] {
  const content = asRecord(message)?.message;
  const blocks = Array.isArray(asRecord(content)?.content)
    ? (asRecord(content)?.content as unknown[])
    : [];
  return blocks.flatMap((block) => {
    const record = asRecord(block);
    if (record?.type !== "tool_use") {
      return [];
    }
    return [
      {
        id: typeof record.id === "string" ? record.id : undefined,
        name: typeof record.name === "string" ? record.name : undefined,
        input: record.input,
      },
    ];
  });
}

export function textDeltaFromClaudeStreamEvent(message: unknown): string {
  const event = asRecord(message)?.event;
  const eventRecord = asRecord(event);
  const delta = asRecord(eventRecord?.delta);
  if (eventRecord?.type === "content_block_delta" && delta?.type === "text_delta") {
    return typeof delta.text === "string" ? delta.text : "";
  }
  if (eventRecord?.type === "content_block_delta" && delta?.type === "thinking_delta") {
    return typeof delta.thinking === "string" ? delta.thinking : "";
  }
  return "";
}

export function streamEventKind(message: unknown): "text" | "thinking" | "stop" | "other" {
  const event = asRecord(message)?.event;
  const eventRecord = asRecord(event);
  const delta = asRecord(eventRecord?.delta);
  if (eventRecord?.type === "message_stop") {
    return "stop";
  }
  if (eventRecord?.type === "content_block_delta" && delta?.type === "thinking_delta") {
    return "thinking";
  }
  if (eventRecord?.type === "content_block_delta" && delta?.type === "text_delta") {
    return "text";
  }
  return "other";
}

export function inferClaudeToolKind(name: string, payload: ToolPayload): string {
  const lowered = name.toLowerCase();
  const input = asRecord(payload.input);
  const command = firstString(input, ["command", "cmd", "script"]);
  const haystack = `${lowered} ${compactJson(payload.input, 240) ?? ""} ${
    compactJson(payload.result, 240) ?? ""
  }`.toLowerCase();
  if (lowered.includes("todo")) return "todo";
  if (lowered === "agent" || lowered.includes("task")) return "task";
  if (lowered.includes("grep")) return "grep";
  if (lowered.includes("glob") || lowered.includes("search")) return "search";
  if (command && /\b(?:rg|grep)\b/i.test(command)) return "grep";
  if (lowered.includes("web")) return "search_web";
  if (lowered.includes("bash") || lowered.includes("shell")) return "terminal";
  if (/\b(write|edit|multiedit|patch|replace|update|create)\b/.test(haystack)) return "edit";
  if (/\b(read|open|view|cat)\b/.test(haystack)) return "read";
  return "tool";
}

function locationsForTool(payload: ToolPayload): AgentToolLocation[] | undefined {
  const records = [asRecord(payload.input), asRecord(payload.result)].filter(
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
      if (!Array.isArray(value)) {
        continue;
      }
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
  const locations = [...paths].slice(0, 24).map((path) => ({ path }));
  return locations.length > 0 ? locations : undefined;
}

function titleForTool(name: string, kind: string, payload: ToolPayload): string {
  const input = asRecord(payload.input);
  const path = firstString(input, PATH_KEYS) ?? firstString(asRecord(payload.result), PATH_KEYS);
  const command = firstString(input, ["command", "cmd", "script"]);
  const query =
    firstString(input, ["query", "pattern", "regex", "glob", "search", "term"]) ??
    shellSearchPattern(command);
  switch (kind) {
    case "read":
      return path ? `Read ${path}` : "Read file";
    case "edit":
      return path ? `Update ${path}` : "Update file";
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

function detailForTool(payload: ToolPayload): string | undefined {
  const result = asRecord(payload.result);
  const input = asRecord(payload.input);
  return (
    firstString(result, ["message", "summary", "error", "stderr", "stdout", "output"]) ??
    firstString(input, ["description", "prompt", "query", "command"]) ??
    compactJson(payload.result ?? payload.input)
  );
}

export function claudeToolUseToAgentEvent(input: {
  tool: ToolPayload;
  conversationId: string;
  eventId: string;
  status: AgentToolCallStatus;
}): AgentEventInput {
  const name = input.tool.name || "Tool";
  const kind = inferClaudeToolKind(name, input.tool);
  const title = titleForTool(name, kind, input.tool);
  return {
    eventId: input.eventId,
    conversationId: input.conversationId,
    kind: input.status === "in_progress" || input.status === "pending" ? "tool_call" : "tool_call_update",
    toolCallId: input.tool.id || `${name}-${input.eventId}`,
    title,
    toolKind: kind,
    status: input.status,
    detail: detailForTool(input.tool),
    locations: locationsForTool(input.tool),
    editPreview: extractToolEditPreview(input.tool.input, input.tool.result),
    raw: input.tool,
  };
}

export function toolResultFromClaudeUserMessage(message: unknown): ToolPayload[] {
  const record = asRecord(message);
  const messageParam = asRecord(record?.message);
  const blocks = Array.isArray(messageParam?.content) ? (messageParam.content as unknown[]) : [];
  const results: ToolPayload[] = [];
  for (const block of blocks) {
    const blockRecord = asRecord(block);
    if (blockRecord?.type !== "tool_result") {
      continue;
    }
    results.push({
      id: typeof blockRecord.tool_use_id === "string" ? blockRecord.tool_use_id : undefined,
      result: blockRecord.content,
      isError: blockRecord.is_error === true,
    });
  }
  if (record?.tool_use_result != null && results.length === 0) {
    const resultRecord = asRecord(record.tool_use_result);
    results.push({
      id: firstString(resultRecord, ["tool_use_id", "toolUseId", "id"]),
      result: record.tool_use_result,
      isError: resultRecord?.is_error === true || resultRecord?.isError === true,
    });
  }
  return results;
}

export function planEntriesFromClaudeToolPayload(payload: unknown): AgentPlanEntry[] {
  const record = asRecord(payload);
  const todos = Array.isArray(record?.todos)
    ? record.todos
    : Array.isArray(record?.items)
      ? record.items
      : Array.isArray(record?.tasks)
        ? record.tasks
        : [];
  return todos.flatMap((item, index) => {
    const itemRecord = asRecord(item);
    const content =
      firstString(itemRecord, ["content", "text", "title", "description"]) ??
      (typeof item === "string" ? item : "");
    const trimmed = content.trim();
    if (!trimmed) {
      return [];
    }
    const statusValue = firstString(itemRecord, ["status"]);
    const status =
      statusValue === "in_progress" || statusValue === "completed" || statusValue === "pending"
        ? statusValue
        : "pending";
    return [
      {
        id: firstString(itemRecord, ["id"]) ?? `claude-sdk-todo-${index}`,
        content: trimmed,
        priority: firstString(itemRecord, ["priority"]),
        status,
      },
    ];
  });
}
