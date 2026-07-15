import {
  formatGrepToolTitle,
  formatReadToolTitle,
  formatTerminalCommandTitle,
  formatUpdateToolTitle,
  truncateGenericToolTitle,
} from "./tool-display-labels.js";
import { asRecord, asString } from "./json-coerce.js";
import type {
  AgentEventInput,
  AgentToolCallStatus,
} from "./types.js";

export type PiAgentRecord = Record<string, unknown>;

type NormalizeToolInput = {
  conversationId: string;
  eventId: string;
  toolCallId: string;
  toolName: string;
  args?: unknown;
  partialResult?: unknown;
  result?: unknown;
  isError?: boolean;
  emitAsUpdate?: boolean;
  status?: AgentToolCallStatus;
};

function compactJson(value: unknown, max = 1_200): string | undefined {
  if (value == null) {
    return undefined;
  }
  if (typeof value === "string") {
    return value.trim() || undefined;
  }
  try {
    const text = JSON.stringify(value);
    if (!text || text === "{}" || text === "[]") {
      return undefined;
    }
    return text.length > max ? `${text.slice(0, max)}...` : text;
  } catch {
    return undefined;
  }
}

function toolTextFromResult(result: unknown): string | undefined {
  const record = asRecord(result);
  if (!record) {
    return compactJson(result);
  }
  const content = Array.isArray(record.content) ? record.content : [];
  const textParts = content.flatMap((entry) => {
    const item = asRecord(entry);
    return item?.type === "text" && typeof item.text === "string" ? [item.text] : [];
  });
  if (textParts.length > 0) {
    return textParts.join("\n");
  }
  return compactJson(record.details) ?? compactJson(record);
}

function piToolKind(toolName: string): string {
  const normalized = toolName.trim().toLowerCase();
  switch (normalized) {
    case "read":
      return "read";
    case "grep":
      return "grep";
    case "find":
    case "ls":
      return "search";
    case "bash":
      return "terminal";
    case "edit":
    case "write":
      return "edit";
    default:
      return "tool";
  }
}

function piToolTitle(toolName: string, args: unknown): string {
  const record = asRecord(args);
  const normalized = toolName.trim().toLowerCase();
  switch (normalized) {
    case "read":
      return formatReadToolTitle(asString(record?.path));
    case "grep":
      return formatGrepToolTitle(asString(record?.pattern));
    case "find":
      return truncateGenericToolTitle(asString(record?.pattern) ?? asString(record?.path), "Find in workspace");
    case "ls":
      return truncateGenericToolTitle(asString(record?.path), "List directory");
    case "bash":
      return formatTerminalCommandTitle(asString(record?.command) ?? "Command");
    case "edit":
    case "write":
      return formatUpdateToolTitle(asString(record?.path), normalized === "write" ? "Write file" : "Edit file");
    default:
      return truncateGenericToolTitle(toolName, "Tool");
  }
}

function piToolDetail(input: NormalizeToolInput): string | undefined {
  if (input.partialResult != null) {
    return toolTextFromResult(input.partialResult);
  }
  if (input.result != null) {
    return toolTextFromResult(input.result);
  }
  return compactJson(input.args);
}

function piToolLocations(args: unknown): Array<{ path: string }> | undefined {
  const pathValue = asString(asRecord(args)?.path);
  return pathValue ? [{ path: pathValue }] : undefined;
}

export function piAgentToolEventFromExecution(input: NormalizeToolInput): AgentEventInput {
  const status =
    input.status ??
    (input.isError ? "failed" : input.emitAsUpdate ? "in_progress" : "in_progress");
  const common = {
    eventId: input.eventId,
    conversationId: input.conversationId,
    toolCallId: input.toolCallId,
    title: piToolTitle(input.toolName, input.args),
    toolKind: piToolKind(input.toolName),
    status,
    detail: piToolDetail(input),
    locations: piToolLocations(input.args),
    raw: {
      toolName: input.toolName,
      args: input.args,
      partialResult: input.partialResult,
      result: input.result,
      isError: input.isError,
    },
  };
  return input.emitAsUpdate
    ? { ...common, kind: "tool_call_update" }
    : { ...common, kind: "tool_call" };
}

export function piAgentEventsFromSessionEvent(input: {
  event: { type: string; [key: string]: unknown };
  conversationId: string;
  assistantMessageId: string;
  eventId: () => string;
}): AgentEventInput[] {
  const { event, conversationId, assistantMessageId } = input;
  switch (event.type) {
    case "message_update": {
      const assistantMessageEvent = asRecord(event.assistantMessageEvent);
      const deltaType = asString(assistantMessageEvent?.type);
      const delta = asString(assistantMessageEvent?.delta);
      if (!delta) {
        return [];
      }
      if (deltaType === "text_delta") {
        return [
          {
            eventId: input.eventId(),
            conversationId,
            kind: "assistant_message_chunk",
            messageId: assistantMessageId,
            text: delta,
            raw: event,
          },
        ];
      }
      if (deltaType === "thinking_delta") {
        return [
          {
            eventId: input.eventId(),
            conversationId,
            kind: "reasoning",
            messageId: `${assistantMessageId}-reasoning`,
            text: delta,
            raw: event,
          },
        ];
      }
      return [];
    }
    case "tool_execution_start":
      return [
        piAgentToolEventFromExecution({
          conversationId,
          eventId: input.eventId(),
          toolCallId: asString(event.toolCallId) ?? "pi-tool",
          toolName: asString(event.toolName) ?? "tool",
          args: event.args,
          status: "in_progress",
        }),
      ];
    case "tool_execution_update":
      return [
        piAgentToolEventFromExecution({
          conversationId,
          eventId: input.eventId(),
          toolCallId: asString(event.toolCallId) ?? "pi-tool",
          toolName: asString(event.toolName) ?? "tool",
          args: event.args,
          partialResult: event.partialResult,
          emitAsUpdate: true,
          status: "in_progress",
        }),
      ];
    case "tool_execution_end":
      return [
        piAgentToolEventFromExecution({
          conversationId,
          eventId: input.eventId(),
          toolCallId: asString(event.toolCallId) ?? "pi-tool",
          toolName: asString(event.toolName) ?? "tool",
          args: event.args,
          result: event.result,
          isError: event.isError === true,
          emitAsUpdate: true,
          status: event.isError === true ? "failed" : "completed",
        }),
      ];
    case "agent_end":
      return [
        {
          eventId: input.eventId(),
          conversationId,
          kind: "assistant_message_end",
          messageId: assistantMessageId,
          stopReason: event.willRetry === true ? "running" : "completed",
          raw: event,
        },
        {
          eventId: input.eventId(),
          conversationId,
          kind: "status",
          status: event.willRetry === true ? "running" : "idle",
          raw: event,
        },
      ];
    default:
      return [];
  }
}
