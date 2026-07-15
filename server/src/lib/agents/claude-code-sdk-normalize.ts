import type { AgentEventInput, AgentPlanEntry, AgentToolCallStatus, AgentToolLocation } from "./types.js";
import { asRecord, firstString } from "./json-coerce.js";
import { extractToolEditPreview } from "./tool-edit-preview.js";
import {
  detailForToolPayload,
  inferCanonicalToolKind,
  locationsForToolPayload,
  titleForCanonicalTool,
} from "./tool-normalize.js";

type ToolPayload = {
  id?: string;
  name?: string;
  input?: unknown;
  result?: unknown;
  isError?: boolean;
};

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
  return inferCanonicalToolKind({
    name,
    input: payload.input,
    result: payload.result,
  });
}

function locationsForTool(payload: ToolPayload): AgentToolLocation[] | undefined {
  return locationsForToolPayload({ input: payload.input, result: payload.result });
}

function titleForTool(name: string, kind: string, payload: ToolPayload): string {
  return titleForCanonicalTool({
    name,
    kind,
    payload: { input: payload.input, result: payload.result },
  });
}

function detailForTool(payload: ToolPayload): string | undefined {
  return detailForToolPayload({ input: payload.input, result: payload.result });
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
    const statusValue = firstString(itemRecord, ["status"])?.toLowerCase();
    const status =
      statusValue === "in_progress" ||
      statusValue === "blocked" ||
      statusValue === "stuck" ||
      statusValue === "completed" ||
      statusValue === "pending"
        ? statusValue === "stuck"
          ? "blocked"
          : statusValue
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
