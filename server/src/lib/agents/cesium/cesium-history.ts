import type { AgentStoredEvent } from "../types.js";
import { asRecord, asString, truncate, truncateMiddle } from "./cesium-coerce.js";
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

export {
  CESIUM_TIME_GAP_REMINDER_MS,
  cesiumEnvironmentChangeNotice,
  cesiumEnvironmentReminderSnapshot,
  cesiumRelocationChangeNotice,
  formatCesiumDateLabel,
  formatCesiumTimeGapDuration,
  latestCesiumEnvironmentReminderSnapshot,
  latestMcpReminderSnapshot,
  mcpReminderChangeNotice,
  mcpReminderSnapshot,
  previousUserMessageCreatedAt,
  type CesiumEnvironmentReminderSnapshot,
  type McpReminderSnapshot,
} from "./cesium-environment-reminders.js";

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

type HistoryBuildState = {
  messages: CesiumHistoryMessage[];
  pending: PendingHistoryToolCall[];
  /** Assistant text streamed before this batch of tool calls; the live turn sends it with them. */
  pendingContent: string;
  /** Model-facing tool output budget, reset per turn exactly like the live loop. */
  usedToolResultChars: number;
};

function flushPendingToolCalls(state: HistoryBuildState): void {
  const { messages, pending } = state;
  if (pending.length === 0) {
    return;
  }
  messages.push({
    role: "assistant",
    content: state.pendingContent,
    toolCalls: pending.map(({ id, name, arguments: args }) => ({ id, name, arguments: args })),
  });
  for (const call of pending) {
    let content = MISSING_TOOL_RESULT_MESSAGE;
    if (call.result?.trim()) {
      const normalized = normalizeCesiumToolResultForModel({
        toolName: call.name,
        result: call.result,
        usedToolResultChars: state.usedToolResultChars,
      });
      state.usedToolResultChars = normalized.usedToolResultChars;
      content = normalized.content;
    }
    messages.push({
      role: "tool",
      toolCallId: call.id,
      name: call.name,
      content,
    });
  }
  pending.length = 0;
  state.pendingContent = "";
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

type SystemReminderEvent = Extract<AgentStoredEvent, { kind: "system_reminder" }>;

/** Reason of the per-turn context reminder; each one stays on its own user message. */
export const CESIUM_TURN_CONTEXT_REMINDER_REASON = "context";

const LEGACY_DYNAMIC_REMINDER_REASONS = new Set(["mode", "plan_handoff", "other"]);

/** Reminders that open a turn (as opposed to inline mid-turn context). */
export function isTurnReminder(event: AgentStoredEvent): boolean {
  return (
    event.kind === "system_reminder" &&
    event.placement !== "inline" &&
    Boolean(event.targetMessageId) &&
    (event.reason === CESIUM_TURN_CONTEXT_REMINDER_REASON ||
      LEGACY_DYNAMIC_REMINDER_REASONS.has(event.reason))
  );
}

/**
 * Targeted reminders merged onto their user messages. Per-turn context
 * reminders are append-only: each stays byte-identical on the message it
 * opened, so a turn never rewrites earlier context. Reminders written before
 * that scheme (one full block per turn, of which only the newest was
 * replayed) keep their newest-only rule until the first context reminder
 * supersedes them all.
 */
export function selectTargetedReminders(
  events: AgentStoredEvent[]
): Map<string, SystemReminderEvent[]> {
  const hasContextReminders = events.some(
    (event) =>
      event.kind === "system_reminder" && event.reason === CESIUM_TURN_CONTEXT_REMINDER_REASON
  );
  const latestLegacySeq = new Map<string, number>();
  for (const event of events) {
    if (event.kind === "system_reminder" && LEGACY_DYNAMIC_REMINDER_REASONS.has(event.reason)) {
      latestLegacySeq.set(event.reason, Math.max(latestLegacySeq.get(event.reason) ?? -1, event.seq));
    }
  }
  const reminders = new Map<string, SystemReminderEvent[]>();
  for (const event of events) {
    if (event.kind !== "system_reminder" || !event.targetMessageId || !event.text.trim()) {
      continue;
    }
    if (LEGACY_DYNAMIC_REMINDER_REASONS.has(event.reason)) {
      if (hasContextReminders || latestLegacySeq.get(event.reason) !== event.seq) {
        continue;
      }
    }
    const existing = reminders.get(event.targetMessageId) ?? [];
    existing.push(event);
    reminders.set(event.targetMessageId, existing);
  }
  return reminders;
}

/**
 * Section hashes of the newest context reminder, provided the window still
 * holds a full one: deltas only make sense on top of a full reminder the
 * model can see. Null means the next reminder must be full.
 */
export function latestContextReminderBaseline(
  windowEvents: AgentStoredEvent[]
): Record<string, string> | null {
  let sawFull = false;
  let baseline: Record<string, string> | null = null;
  for (const event of [...windowEvents].sort((a, b) => a.seq - b.seq)) {
    if (event.kind !== "system_reminder" || event.reason !== CESIUM_TURN_CONTEXT_REMINDER_REASON) {
      continue;
    }
    const raw = asRecord(event.raw);
    if (raw?.contextReminder === "full") {
      sawFull = true;
    }
    const hashes = asRecord(raw?.contextSectionHashes);
    if (sawFull && hashes) {
      baseline = Object.fromEntries(
        Object.entries(hashes).filter((entry): entry is [string, string] => typeof entry[1] === "string")
      );
    }
  }
  return baseline;
}

/**
 * The slice of the log the model sees: everything after the newest
 * compaction summary's source range. The summary itself opens the window, so
 * a compacted prefix stays fixed until the next compaction.
 */
export function selectHistoryWindow(events: AgentStoredEvent[]): {
  summary: Extract<AgentStoredEvent, { kind: "compression_summary" }> | null;
  events: AgentStoredEvent[];
} {
  const sorted = [...events].sort((a, b) => a.seq - b.seq);
  let summary: Extract<AgentStoredEvent, { kind: "compression_summary" }> | null = null;
  for (const event of sorted) {
    if (event.kind === "compression_summary" && event.sourceRange) {
      summary = event;
    }
  }
  if (!summary?.sourceRange) {
    return { summary: null, events: sorted };
  }
  const toSeq = summary.sourceRange.toSeq;
  return {
    summary,
    events: sorted.filter(
      (event) =>
        event.seq > toSeq && !(event.kind === "compression_summary" && event.sourceRange)
    ),
  };
}

export function normalizeEventsToHistory(
  events: AgentStoredEvent[],
  systemPrompt: string = CESIUM_SYSTEM_PROMPT
): CesiumHistoryMessage[] {
  const messages: CesiumHistoryMessage[] = [{ role: "system", content: systemPrompt }];
  const state: HistoryBuildState = {
    messages,
    pending: [],
    pendingContent: "",
    usedToolResultChars: 0,
  };
  const assistantTextById = new Map<string, string>();
  const sorted = [...events].sort((a, b) => a.seq - b.seq);
  const remindersByMessageId = selectTargetedReminders(sorted);
  for (const event of sorted) {
    switch (event.kind) {
      case "user_message":
        flushPendingToolCalls(state);
        {
          const reminders = (remindersByMessageId.get(event.messageId) ?? []).map((reminder) =>
            reminder.text.trim()
          );
          const content = reminders.length
            ? `${reminders.join("\n\n")}\n\n${event.content}`
            : event.content;
          const images = (event.attachments ?? [])
            .filter(
              (attachment) =>
                typeof attachment?.mimeType === "string" &&
                attachment.mimeType.startsWith("image/") &&
                typeof attachment?.data === "string" &&
                attachment.data.length > 0
            )
            .slice(0, 6)
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
        if (isTurnReminder(event)) {
          state.usedToolResultChars = 0;
        }
        // Targeted reminders were merged onto their user message above. Inline
        // reminders (context that landed between tool iterations, or a seed
        // written before the first prompt) replay as their own user-role
        // message at exactly this position, after the tool results that
        // preceded them - the same shape the model saw live, byte for byte.
        if (event.placement === "inline" && event.text.trim()) {
          flushPendingToolCalls(state);
          const images = (event.images ?? []).filter((image) => image.data.length > 0);
          messages.push({
            role: "user",
            content: event.text,
            ...(images.length > 0 ? { images } : {}),
          });
        }
        break;
      case "assistant_message_chunk":
        assistantTextById.set(event.messageId, `${assistantTextById.get(event.messageId) ?? ""}${event.text}`);
        break;
      case "assistant_message_end": {
        flushPendingToolCalls(state);
        const text = assistantTextById.get(event.messageId)?.trim();
        if (text) {
          messages.push({ role: "assistant", content: text });
        }
        assistantTextById.delete(event.messageId);
        break;
      }
      // Reasoning is not replayed: the live loop never sends it back within a
      // turn, and re-sending stale chain-of-thought on later turns only costs
      // tokens and rewrites the cached prefix.
      case "reasoning":
        break;
      case "tool_call":
        if (state.pending.length === 0) {
          // Text streamed before this batch belongs to the batch's assistant
          // message, as in the live request; the message end keeps only the rest.
          const streamed = [...assistantTextById.values()].join("").trim();
          assistantTextById.clear();
          state.pendingContent = streamed;
        }
        state.pending.push(toolCallFromStoredEvent(event));
        break;
      case "tool_call_update":
        if (event.status === "completed" || event.status === "failed") {
          const detail = event.detail?.trim()
            ? event.detail
            : event.status === "failed"
              ? "Tool call failed."
              : "Tool call completed with no output.";
          const pending = state.pending.find((call) => call.id === event.toolCallId);
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
            state.pending.push({
              id: event.toolCallId,
              name,
              arguments: serializeToolCallArguments(name, request?.arguments, event.detail),
              result: detail,
            });
          }
        }
        break;
      case "plan":
        // A todo or plan-file tool writes its plan while the call is still
        // pending; the tool result already told the model what happened.
        if (state.pending.length > 0) {
          break;
        }
        messages.push({
          role: "assistant",
          content: event.entries.map((entry) => `- [${entry.status}] ${entry.content}`).join("\n"),
        });
        break;
      case "compression_summary":
        flushPendingToolCalls(state);
        messages.push({
          role: "user",
          content: `[Compressed earlier conversation]\n${event.summary}`,
        });
        break;
      case "agent_handoff":
        flushPendingToolCalls(state);
        messages.push({
          role: "assistant",
          content: `[Handoff from ${event.fromAgent} to ${event.toAgent}]`,
        });
        break;
      case "chat_fork":
        flushPendingToolCalls(state);
        messages.push({
          role: "user",
          content: `[Forked chat]\n${event.transcript}`,
        });
        break;
      default:
        break;
    }
  }
  flushPendingToolCalls(state);
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
  let assistantText = "";
  const flushAssistant = () => {
    if (assistantText.trim()) {
      lines.push(`Assistant: ${truncate(assistantText.trim(), 1000)}`);
    }
    assistantText = "";
  };
  for (const event of events) {
    if (event.kind === "assistant_message_chunk") {
      assistantText += event.text;
      continue;
    }
    flushAssistant();
    switch (event.kind) {
      case "user_message":
        if (event.hidden) {
          break;
        }
        lines.push(`User: ${truncate(event.content, 1000)}`);
        break;
      case "system_reminder":
        // Turn context is re-sent in full after a compaction; copying it into
        // the digest only repeats boilerplate once per compressed turn.
        if (
          isTurnReminder(event) ||
          event.reason === "goal" ||
          event.reason === "burn" ||
          event.reason === "linked_conversation"
        ) {
          break;
        }
        lines.push(truncate(event.text, 1000));
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
  flushAssistant();
  // The compressed range runs oldest -> newest: the head carries the original
  // task framing and the tail carries the latest work before the retained
  // window. Head-only truncation dropped exactly the recent end.
  return truncateMiddle(lines.join("\n"), 16_000);
}
