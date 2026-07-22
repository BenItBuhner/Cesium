import type { McpServerSummary } from "@cesium/core/mcp";
import type { AgentStoredEvent } from "../types.js";
import { asRecord, asString, truncate } from "./cesium-coerce.js";
import {
  CESIUM_SYSTEM_PROMPT,
  CESIUM_TOOL_RESULT_MODEL_MAX_CHARS,
  CESIUM_TOOL_RESULT_MODEL_TOTAL_MAX_CHARS,
  HISTORY_EVENT_LIMIT,
} from "./cesium-prompt.js";
import { inferCesiumToolNameFromTitle, serializeToolCallArguments } from "./cesium-tools.js";
import type {
  CesiumAdapterResult,
  CesiumHistoryMessage,
  CesiumHistoryToolCall,
} from "./cesium-types.js";

type PendingHistoryToolCall = CesiumHistoryToolCall & {
  result?: string;
};

export function estimateHistoryTokens(messages: CesiumHistoryMessage[]): number {
  let chars = 0;
  for (const message of messages) {
    chars += message.content.length;
    if (message.toolCalls) {
      chars += JSON.stringify(message.toolCalls).length;
    }
    if (message.name) {
      chars += message.name.length;
    }
  }
  return Math.ceil(chars / 4);
}

export type McpReminderSnapshot = {
  revision?: number;
  dateLabel?: string;
  mcpServers: Array<{ id: string; label: string; summary: string }>;
};

export function mcpReminderSnapshot(input: {
  revision?: number;
  dateLabel?: string | null;
  summaries: McpServerSummary[];
}): McpReminderSnapshot {
  return {
    revision: input.revision,
    dateLabel: input.dateLabel ?? undefined,
    mcpServers: input.summaries.map((summary) => ({
      id: summary.id,
      label: summary.label,
      summary: summary.summary ?? "",
    })),
  };
}

export function latestMcpReminderSnapshot(events: AgentStoredEvent[]): McpReminderSnapshot | null {
  for (let i = events.length - 1; i >= 0; i -= 1) {
    const event = events[i]!;
    if (event.kind !== "system_reminder") {
      continue;
    }
    const raw = asRecord(event.raw);
    const snapshot = asRecord(raw?.mcpReminderSnapshot);
    const servers = Array.isArray(snapshot?.mcpServers)
      ? snapshot.mcpServers
          .map((entry) => {
            const record = asRecord(entry);
            const id = asString(record?.id);
            const label = asString(record?.label);
            if (!id || !label) {
              return null;
            }
            return {
              id,
              label,
              summary: asString(record?.summary) ?? "",
            };
          })
          .filter((entry): entry is McpReminderSnapshot["mcpServers"][number] => Boolean(entry))
      : null;
    if (!servers) {
      continue;
    }
    return {
      revision: typeof snapshot?.revision === "number" ? snapshot.revision : undefined,
      dateLabel: asString(snapshot?.dateLabel),
      mcpServers: servers,
    };
  }
  return null;
}

export function mcpReminderChangeNotice(
  previous: McpReminderSnapshot | null,
  current: McpReminderSnapshot
): string | null {
  if (!previous) {
    return null;
  }
  const lines: string[] = [];
  if (
    previous.revision != null &&
    current.revision != null &&
    previous.revision !== current.revision
  ) {
    lines.push("- MCP catalog revision changed; reread mirrored schemas before using MCP tools.");
  }
  if (previous.dateLabel && current.dateLabel && previous.dateLabel !== current.dateLabel) {
    lines.push(`- Date changed from ${previous.dateLabel} to ${current.dateLabel}.`);
  }
  const previousServers = new Map(previous.mcpServers.map((server) => [server.id, server]));
  const currentServers = new Map(current.mcpServers.map((server) => [server.id, server]));
  for (const [id, server] of currentServers) {
    if (!previousServers.has(id)) {
      lines.push(`- MCP server enabled: ${server.label}.`);
    }
  }
  for (const [id, server] of previousServers) {
    if (!currentServers.has(id)) {
      lines.push(`- MCP server disabled or removed: ${server.label}.`);
    }
  }
  for (const [id, server] of currentServers) {
    const prior = previousServers.get(id);
    if (prior && prior.summary !== server.summary) {
      lines.push(`- MCP server refreshed: ${server.label}.`);
    }
  }
  return lines.length ? lines.join("\n") : null;
}

export function normalizeCesiumToolResultForModel(input: {
  toolName: string;
  result: string;
  usedToolResultChars: number;
  perToolLimit?: number;
  totalLimit?: number;
}): { content: string; usedToolResultChars: number; truncated: boolean } {
  const perToolLimit = input.perToolLimit ?? CESIUM_TOOL_RESULT_MODEL_MAX_CHARS;
  const totalLimit = input.totalLimit ?? CESIUM_TOOL_RESULT_MODEL_TOTAL_MAX_CHARS;
  const remaining = Math.max(0, totalLimit - input.usedToolResultChars);
  const budget = Math.min(perToolLimit, remaining);
  if (budget <= 0) {
    return {
      content:
        `[${input.toolName} result omitted from model context: cumulative tool output exceeded ${totalLimit} characters. ` +
        "The full result remains available in the conversation tool log.]",
      usedToolResultChars: input.usedToolResultChars,
      truncated: true,
    };
  }
  if (input.result.length <= budget) {
    return {
      content: input.result,
      usedToolResultChars: input.usedToolResultChars + input.result.length,
      truncated: false,
    };
  }
  const omitted = input.result.length - budget;
  return {
    content:
      `${input.result.slice(0, budget)}\n...[truncated ${omitted} chars from ${input.toolName} result for model context. ` +
      "Full output is preserved in the conversation tool log.]",
    usedToolResultChars: input.usedToolResultChars + budget,
    truncated: true,
  };
}

export function isEmptyCesiumAdapterResult(result: CesiumAdapterResult): boolean {
  return result.text.trim().length === 0 && result.toolRequests.length === 0;
}

function toolCallFromStoredEvent(event: Extract<AgentStoredEvent, { kind: "tool_call" }>): CesiumHistoryToolCall {
  const raw = asRecord(event.raw);
  const request = asRecord(raw?.request) ?? raw;
  const name =
    asString(request?.name) ??
    inferCesiumToolNameFromTitle(event.title) ??
    event.title.split(" ")[0] ??
    "tool";
  return {
    id: event.toolCallId,
    name,
    arguments: serializeToolCallArguments(name, request?.arguments, event.detail),
  };
}

const MISSING_TOOL_RESULT_MESSAGE =
  "Tool call did not complete or was interrupted before returning a result.";

function flushPendingToolCalls(
  messages: CesiumHistoryMessage[],
  pending: PendingHistoryToolCall[]
): void {
  if (pending.length === 0) {
    return;
  }
  const resolved = pending.map((call) => ({
    ...call,
    result: call.result?.trim() ? call.result : MISSING_TOOL_RESULT_MESSAGE,
  }));
  messages.push({
    role: "assistant",
    content: "",
    toolCalls: resolved.map(({ id, name, arguments: args }) => ({ id, name, arguments: args })),
  });
  for (const call of resolved) {
    messages.push({
      role: "tool",
      toolCallId: call.id,
      name: call.name,
      content: call.result!,
    });
  }
  pending.length = 0;
}

export function satisfyOpenAiToolProtocol(messages: CesiumHistoryMessage[]): CesiumHistoryMessage[] {
  const out: CesiumHistoryMessage[] = [];
  let index = 0;
  while (index < messages.length) {
    const message = messages[index]!;
    if (message.role !== "assistant" || !message.toolCalls?.length) {
      out.push(message);
      index += 1;
      continue;
    }
    out.push(message);
    const missing = new Map(message.toolCalls.map((call) => [call.id, call]));
    index += 1;
    while (index < messages.length && messages[index]!.role === "tool") {
      const tool = messages[index]!;
      out.push(tool);
      if (tool.toolCallId) {
        missing.delete(tool.toolCallId);
      }
      index += 1;
    }
    for (const call of missing.values()) {
      out.push({
        role: "tool",
        toolCallId: call.id,
        name: call.name,
        content: MISSING_TOOL_RESULT_MESSAGE,
      });
    }
  }
  return out;
}

function systemRemindersByTargetMessageId(
  events: AgentStoredEvent[]
): Map<string, string[]> {
  const reminders = new Map<string, string[]>();
  const latestDynamicReminderSeq = new Map<string, number>();
  for (const event of events) {
    if (event.kind !== "system_reminder") {
      continue;
    }
    if (event.reason !== "mode" && event.reason !== "plan_handoff" && event.reason !== "other") {
      continue;
    }
    latestDynamicReminderSeq.set(
      event.reason,
      Math.max(latestDynamicReminderSeq.get(event.reason) ?? -1, event.seq)
    );
  }
  for (const event of events) {
    if (event.kind !== "system_reminder" || !event.targetMessageId || !event.text.trim()) {
      continue;
    }
    const latestSeq = latestDynamicReminderSeq.get(event.reason);
    if (latestSeq != null && event.seq !== latestSeq) {
      continue;
    }
    const existing = reminders.get(event.targetMessageId) ?? [];
    existing.push(event.text.trim());
    reminders.set(event.targetMessageId, existing);
  }
  return reminders;
}

export function normalizeEventsToHistory(events: AgentStoredEvent[]): CesiumHistoryMessage[] {
  const messages: CesiumHistoryMessage[] = [{ role: "system", content: CESIUM_SYSTEM_PROMPT }];
  const assistantTextById = new Map<string, string>();
  const pendingToolCalls: PendingHistoryToolCall[] = [];
  const sorted = [...events].sort((a, b) => a.seq - b.seq);
  const remindersByMessageId = systemRemindersByTargetMessageId(sorted);
  for (const event of sorted) {
    switch (event.kind) {
      case "user_message":
        flushPendingToolCalls(messages, pendingToolCalls);
        {
          const reminders = remindersByMessageId.get(event.messageId) ?? [];
          const content = reminders.length
            ? `${reminders.join("\n\n")}\n\n${event.content}`
            : event.content;
          const images = (event.attachments ?? [])
            .filter((attachment) => attachment.mimeType.startsWith("image/"))
            .map((attachment) => ({
              mimeType: attachment.mimeType,
              data: attachment.data,
              name: attachment.name,
            }));
          messages.push({
            role: "user",
            content,
            ...(images.length > 0 ? { images } : {}),
          });
        }
        break;
      case "system_reminder":
        break;
      case "assistant_message_chunk":
        assistantTextById.set(event.messageId, `${assistantTextById.get(event.messageId) ?? ""}${event.text}`);
        break;
      case "assistant_message_end": {
        flushPendingToolCalls(messages, pendingToolCalls);
        const text = assistantTextById.get(event.messageId)?.trim();
        if (text) {
          messages.push({ role: "assistant", content: text });
        }
        assistantTextById.delete(event.messageId);
        break;
      }
      case "reasoning":
        flushPendingToolCalls(messages, pendingToolCalls);
        if (event.text.trim()) {
          messages.push({ role: "assistant", content: `[Reasoning]\n${event.text.trim()}` });
        }
        break;
      case "tool_call":
        pendingToolCalls.push(toolCallFromStoredEvent(event));
        break;
      case "tool_call_update":
        if (event.status === "completed" || event.status === "failed") {
          const detail =
            event.detail?.trim() ??
            (event.status === "failed" ? "Tool call failed." : "Tool call completed with no output.");
          const pending = pendingToolCalls.find((call) => call.id === event.toolCallId);
          if (pending) {
            pending.result = detail;
          } else {
            const updateRaw = asRecord(event.raw);
            const request = asRecord(updateRaw?.request);
            const name =
              asString(request?.name) ??
              inferCesiumToolNameFromTitle(event.title) ??
              (event.title ?? "tool").split(" ")[0] ??
              "tool";
            pendingToolCalls.push({
              id: event.toolCallId,
              name,
              arguments: serializeToolCallArguments(name, request?.arguments, event.detail),
              result: detail,
            });
          }
        }
        break;
      case "plan":
        flushPendingToolCalls(messages, pendingToolCalls);
        messages.push({
          role: "assistant",
          content: event.entries.map((entry) => `- [${entry.status}] ${entry.content}`).join("\n"),
        });
        break;
      case "compression_summary":
        flushPendingToolCalls(messages, pendingToolCalls);
        messages.push({
          role: "user",
          content: `[Compressed earlier conversation]\n${event.summary}`,
        });
        break;
      case "agent_handoff":
        flushPendingToolCalls(messages, pendingToolCalls);
        messages.push({
          role: "assistant",
          content: `[Handoff from ${event.fromAgent} to ${event.toAgent}]`,
        });
        break;
      case "chat_fork":
        flushPendingToolCalls(messages, pendingToolCalls);
        messages.push({
          role: "user",
          content: `[Forked chat]\n${event.transcript}`,
        });
        break;
      default:
        break;
    }
  }
  flushPendingToolCalls(messages, pendingToolCalls);
  for (const text of assistantTextById.values()) {
    if (text.trim()) {
      messages.push({ role: "assistant", content: text.trim() });
    }
  }
  return satisfyOpenAiToolProtocol(repairOpenAiMessageSequence(messages)).slice(
    -HISTORY_EVENT_LIMIT
  );
}

export function repairOpenAiMessageSequence(messages: CesiumHistoryMessage[]): CesiumHistoryMessage[] {
  const repaired: CesiumHistoryMessage[] = [];
  for (const message of messages) {
    if (message.role === "tool") {
      const previous = repaired[repaired.length - 1];
      const hasMatchingCall =
        previous?.role === "assistant" &&
        previous.toolCalls?.some((call) => call.id === message.toolCallId);
      if (!hasMatchingCall && message.toolCallId) {
        repaired.push({
          role: "assistant",
          content: "",
          toolCalls: [
            {
              id: message.toolCallId,
              name: message.name ?? "tool",
              arguments: "{}",
            },
          ],
        });
      }
    }
    repaired.push(message);
  }
  return repaired;
}

export function summarizeForCompression(events: AgentStoredEvent[]): string {
  const lines: string[] = [];
  for (const event of events) {
    switch (event.kind) {
      case "user_message":
        if (event.hidden) {
          break;
        }
        lines.push(`User: ${truncate(event.content, 1000)}`);
        break;
      case "system_reminder":
        if (event.reason === "goal" || event.reason === "burn") {
          break;
        }
        lines.push(truncate(event.text, 1000));
        break;
      case "assistant_message_chunk":
        if (event.text.trim()) {
          lines.push(`Assistant: ${truncate(event.text.trim(), 1000)}`);
        }
        break;
      case "tool_call":
        lines.push(`Tool: ${event.title}${event.detail ? ` - ${truncate(event.detail, 400)}` : ""}`);
        break;
      case "tool_call_update":
        if (event.status === "failed") {
          lines.push(`Tool failed: ${event.title ?? event.toolCallId}${event.detail ? ` - ${truncate(event.detail, 400)}` : ""}`);
        } else if (event.status === "completed" && event.detail?.trim()) {
          lines.push(`Tool result: ${event.title ?? event.toolCallId} - ${truncate(event.detail, 600)}`);
        }
        break;
      case "plan":
        lines.push(`Plan: ${event.entries.map((entry) => `${entry.status}: ${entry.content}`).join("; ")}`);
        break;
      default:
        break;
    }
  }
  return truncate(lines.join("\n"), 16_000);
}
