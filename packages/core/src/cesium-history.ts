/**
 * Model history from the stored event log, shared by both Cesium harness
 * engines: the server turn loop and the browser machine. The output is
 * provider-neutral; each engine maps it onto its wire format.
 */
import type { AgentModelUsage, AgentStoredEvent, AgentTokenUsage } from "./protocol";
import { buildCesiumBaseSystemPrompt } from "./mcp";
import { asRecord, asString, truncate, truncateMiddle } from "./cesium-coerce";
import { inferCesiumToolNameFromTitle, serializeToolCallArguments } from "./cesium-tools";

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

/**
 * Reasoning a response produced alongside its tool calls, in the provider's
 * own item format (Responses `reasoning` items, Anthropic signed `thinking`
 * blocks). Only an adapter of the same format sends it back.
 */
export type CesiumNativeReasoning = {
  format: "openai-responses" | "anthropic";
  items: Array<Record<string, unknown>>;
};

export type CesiumHistoryMessage = {
  role: CesiumRole;
  content: string;
  /** Image attachments for multimodal / vision models (OpenAI-compatible image_url parts). */
  images?: CesiumImagePart[];
  toolCallId?: string;
  name?: string;
  toolCalls?: CesiumHistoryToolCall[];
  nativeReasoning?: CesiumNativeReasoning;
};

/** The native reasoning stored on a batch's first tool call, when it is well formed. */
export function nativeReasoningFromRaw(raw: unknown): CesiumNativeReasoning | undefined {
  const value = asRecord(asRecord(raw)?.nativeReasoning);
  if (!value || (value.format !== "openai-responses" && value.format !== "anthropic")) {
    return undefined;
  }
  const items = Array.isArray(value.items)
    ? value.items.filter((item): item is Record<string, unknown> => asRecord(item) !== null)
    : [];
  return items.length > 0 ? { format: value.format, items } : undefined;
}

/** Characters of one tool result the model sees when no smaller budget was stored with it. */
export const CESIUM_TOOL_RESULT_MODEL_MAX_CHARS = 12_000;
/** Messages kept from the end of a rebuilt history. */
export const CESIUM_HISTORY_MESSAGE_LIMIT = 20_000;

const CESIUM_SYSTEM_PROMPT = buildCesiumBaseSystemPrompt();

/** Tokens the next request starts from: this prompt plus the reply it carries forward. */
export function contextTokensAfterResponse(usage: AgentTokenUsage): number {
  return usage.inputTokens + Math.max(0, usage.outputTokens - (usage.reasoningTokens ?? 0));
}

type PendingHistoryToolCall = CesiumHistoryToolCall & {
  /** The event log's id for the call; `id` is the one the model issued. */
  storedId: string;
  /** Browser-machine calls keep the model-facing result in `raw.result` of their updates. */
  resultInRaw?: boolean;
  result?: string;
  budget?: number;
  spillPath?: string;
};

/** Rough per-image cost; providers bill a typical screenshot at roughly this many tokens. */
const IMAGE_TOKEN_ESTIMATE = 1_000;

export function estimateHistoryTokens(messages: CesiumHistoryMessage[]): number {
  let chars = 0;
  let images = 0;
  for (const message of messages) {
    chars += message.content.length;
    if (message.toolCalls) {
      chars += JSON.stringify(message.toolCalls).length;
    }
    if (message.nativeReasoning) {
      chars += JSON.stringify(message.nativeReasoning.items).length;
    }
    if (message.name) {
      chars += message.name.length;
    }
    images += message.images?.length ?? 0;
  }
  return Math.ceil(chars / 4) + images * IMAGE_TOKEN_ESTIMATE;
}

/**
 * The newest provider-reported usage inside the history window, for the model
 * that produced it. A different model tokenizes differently, so its counts do
 * not carry over.
 */
export function latestReportedUsage(
  windowEvents: AgentStoredEvent[],
  modelId: string
): { usage: AgentModelUsage; seq: number } | null {
  let latest: { usage: AgentModelUsage; seq: number } | null = null;
  for (const event of windowEvents) {
    if (event.kind === "assistant_message_end" && event.usage && (!latest || event.seq > latest.seq)) {
      latest = { usage: event.usage, seq: event.seq };
    }
  }
  return latest && latest.usage.modelId === modelId ? latest : null;
}

/**
 * Context size in tokens: the provider's count as of its newest response plus
 * an estimate for what was logged after it. Null when no response in the
 * window reported usage, so callers fall back to a full estimate.
 */
export function reportedContextTokens(windowEvents: AgentStoredEvent[], modelId: string): number | null {
  const latest = latestReportedUsage(windowEvents, modelId);
  if (!latest) {
    return null;
  }
  const after = windowEvents.filter((event) => event.seq > latest.seq);
  const afterTokens = after.length > 0 ? estimateHistoryTokens(normalizeEventsToHistory(after).slice(1)) : 0;
  return contextTokensAfterResponse(latest.usage) + afterTokens;
}

/**
 * What the model sees of one tool result: all of it within `budget`
 * characters, otherwise its head and tail around a note saying where the
 * rest is. Depends only on its inputs, so history rebuilt from the stored
 * result and budget repeats the live request byte for byte.
 */
export function normalizeCesiumToolResultForModel(input: {
  toolName: string;
  result: string;
  budget?: number;
  spillPath?: string;
}): { content: string; truncated: boolean } {
  const budget = input.budget ?? CESIUM_TOOL_RESULT_MODEL_MAX_CHARS;
  if (input.result.length <= budget) {
    return { content: input.result, truncated: false };
  }
  const headLength = Math.ceil(budget / 2);
  const tailLength = budget - headLength;
  const omitted = input.result.length - headLength - tailLength;
  const where = input.spillPath
    ? `The full output is saved at ${input.spillPath}; read_file it with offset/limit for the rest.`
    : "The full output is kept in the conversation tool log.";
  return {
    content:
      `${input.result.slice(0, headLength)}\n...[${omitted} chars of this ${input.toolName} result omitted from the middle. ${where}]...\n` +
      (tailLength > 0 ? input.result.slice(-tailLength) : ""),
    truncated: true,
  };
}

/**
 * What a pruned tool result becomes: enough to know it existed and how to get
 * it back, plus the boundary's summary of what it showed when one was written.
 */
export function prunedToolResultStub(
  toolName: string,
  resultChars: number,
  spillPath?: string,
  summary?: string
): string {
  return (
    `[${toolName} output (${resultChars} chars) pruned to free context.` +
    (summary ? ` What it showed: ${summary}` : "") +
    (spillPath ? ` It is saved at ${spillPath}.` : " Run the tool again if you still need it.") +
    "]"
  );
}

/** Summaries the window's pruning boundaries wrote for the results they stubbed. */
export function prunedToolSummaries(window: {
  summary: Extract<AgentStoredEvent, { kind: "compression_summary" }> | null;
  events: AgentStoredEvent[];
}): Map<string, string> {
  const summaries = new Map<string, string>();
  const add = (event: Extract<AgentStoredEvent, { kind: "compression_summary" }> | null) => {
    for (const [id, text] of Object.entries(event?.prunedSummaries ?? {})) {
      if (typeof text === "string" && text.trim()) {
        summaries.set(id, text);
      }
    }
  };
  add(window.summary);
  for (const event of window.events) {
    if (event.kind === "compression_summary") {
      add(event);
    }
  }
  return summaries;
}

/** Tool calls whose results a compaction boundary pruned, for the window the model sees. */
export function prunedToolCallIds(window: {
  summary: Extract<AgentStoredEvent, { kind: "compression_summary" }> | null;
  events: AgentStoredEvent[];
}): Set<string> {
  const ids = new Set<string>(window.summary?.prunedToolCallIds ?? []);
  for (const event of window.events) {
    if (event.kind === "compression_summary") {
      for (const id of event.prunedToolCallIds ?? []) {
        ids.add(id);
      }
    }
  }
  return ids;
}

/** The model-facing budget and spill file a completed tool result was stored with. */
function storedToolResultShape(raw: unknown): { budget?: number; spillPath?: string } {
  const record = asRecord(raw);
  const budget = record?.modelBudget;
  return {
    ...(typeof budget === "number" && budget > 0 ? { budget } : {}),
    ...(asString(record?.spillPath) ? { spillPath: asString(record?.spillPath) } : {}),
  };
}

/**
 * Server calls store `{request: {id, name, arguments}}` (or the request
 * itself) and are keyed by their own id. Browser-machine calls store the
 * model's `{callId, name, argsJson}`, which replays verbatim.
 */
function toolCallFromStoredEvent(event: Extract<AgentStoredEvent, { kind: "tool_call" }>): PendingHistoryToolCall {
  const raw = asRecord(event.raw);
  const request = asRecord(raw?.request) ?? raw;
  const name =
    asString(request?.name) ??
    inferCesiumToolNameFromTitle(event.title) ??
    event.title.split(" ")[0] ??
    "tool";
  if (typeof raw?.argsJson === "string") {
    return {
      id: asString(raw.callId) ?? event.toolCallId,
      storedId: event.toolCallId,
      resultInRaw: true,
      name,
      arguments: raw.argsJson,
    };
  }
  return {
    id: event.toolCallId,
    storedId: event.toolCallId,
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
  /** The model response the pending calls came from, when the log recorded it. */
  pendingResponseId?: string;
  /** Native reasoning of that response, stored on its first call. */
  pendingNativeReasoning?: CesiumNativeReasoning;
  pruned: ReadonlySet<string>;
  prunedSummaries: ReadonlyMap<string, string>;
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
    ...(state.pendingNativeReasoning ? { nativeReasoning: state.pendingNativeReasoning } : {}),
  });
  for (const call of pending) {
    let content = MISSING_TOOL_RESULT_MESSAGE;
    if (call.result?.trim() && state.pruned.has(call.storedId)) {
      content = prunedToolResultStub(
        call.name,
        call.result.length,
        call.spillPath,
        state.prunedSummaries.get(call.storedId)
      );
    } else if (call.result?.trim()) {
      content = normalizeCesiumToolResultForModel({
        toolName: call.name,
        result: call.result,
        budget: call.budget,
        spillPath: call.spillPath,
      }).content;
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
  state.pendingResponseId = undefined;
  state.pendingNativeReasoning = undefined;
}

/**
 * Text of messages that never got an end (the stream failed or was stopped)
 * closes where the log moved on, as the server's interruption repair would
 * have closed it; left open, it would trail every later request instead.
 */
function flushDanglingAssistantText(
  messages: CesiumHistoryMessage[],
  assistantTextById: Map<string, string>
): void {
  for (const text of assistantTextById.values()) {
    if (text.trim()) {
      messages.push({ role: "assistant", content: text.trim() });
    }
  }
  assistantTextById.clear();
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
  systemPrompt: string = CESIUM_SYSTEM_PROMPT,
  /** Results a boundary pruned; defaults to the boundaries among `events`. */
  pruned: ReadonlySet<string> = prunedToolCallIds({ summary: null, events }),
  /** What those boundaries wrote about the results they pruned. */
  prunedSummaries: ReadonlyMap<string, string> = prunedToolSummaries({ summary: null, events })
): CesiumHistoryMessage[] {
  const messages: CesiumHistoryMessage[] = [{ role: "system", content: systemPrompt }];
  const state: HistoryBuildState = {
    messages,
    pending: [],
    pendingContent: "",
    pruned,
    prunedSummaries,
  };
  const assistantTextById = new Map<string, string>();
  const sorted = [...events].sort((a, b) => a.seq - b.seq);
  const remindersByMessageId = selectTargetedReminders(sorted);
  for (const event of sorted) {
    switch (event.kind) {
      case "user_message":
        flushPendingToolCalls(state);
        flushDanglingAssistantText(messages, assistantTextById);
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
        // Text after a finished batch opens the next model response.
        if (state.pending.length > 0 && state.pending.every((call) => call.result !== undefined)) {
          flushPendingToolCalls(state);
        }
        assistantTextById.set(event.messageId, `${assistantTextById.get(event.messageId) ?? ""}${event.text}`);
        break;
      case "assistant_message_end": {
        // A retried attempt's text never reached a later request.
        if (event.stopReason === "discarded") {
          assistantTextById.delete(event.messageId);
          break;
        }
        flushPendingToolCalls(state);
        const text = assistantTextById.get(event.messageId)?.trim();
        if (text) {
          messages.push({ role: "assistant", content: text });
        }
        assistantTextById.delete(event.messageId);
        break;
      }
      // Reasoning text is not replayed as content. Provider-native reasoning
      // that came with tool calls is stored on the batch's first call and
      // travels with that assistant message, as it did in the live turn.
      case "reasoning":
        break;
      case "tool_call": {
        const responseId = asString(asRecord(event.raw)?.responseId);
        if (state.pending.length > 0 && responseId && state.pendingResponseId !== responseId) {
          flushPendingToolCalls(state);
        }
        state.pendingResponseId = responseId ?? state.pendingResponseId;
        if (state.pending.length === 0) {
          // Text streamed before this batch belongs to the batch's assistant
          // message, as in the live request; the message end keeps only the rest.
          const streamed = [...assistantTextById.values()].join("").trim();
          assistantTextById.clear();
          state.pendingContent = streamed;
          state.pendingNativeReasoning = nativeReasoningFromRaw(event.raw);
        }
        state.pending.push(toolCallFromStoredEvent(event));
        break;
      }
      case "tool_call_update": {
        const pending = state.pending.find((call) => call.storedId === event.toolCallId);
        const rawResult = asRecord(event.raw)?.result;
        // A rejected or cancelled browser call still answers the model.
        if (
          pending?.resultInRaw &&
          typeof rawResult === "string" &&
          (event.status === "completed" || event.status === "failed" || event.status === "cancelled")
        ) {
          pending.result = rawResult;
          break;
        }
        if (event.status === "completed" || event.status === "failed") {
          const detail = event.detail?.trim()
            ? event.detail
            : event.status === "failed"
              ? "Tool call failed."
              : "Tool call completed with no output.";
          const shape = event.status === "completed" ? storedToolResultShape(event.raw) : {};
          if (pending) {
            pending.result = detail;
            Object.assign(pending, shape);
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
              storedId: event.toolCallId,
              name,
              arguments: serializeToolCallArguments(name, request?.arguments, event.detail),
              result: detail,
              ...shape,
            });
          }
        }
        break;
      }
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
        // A prune-only boundary changes which results are stubbed, not the sequence.
        if (event.prunedToolCallIds && !event.summary.trim()) {
          break;
        }
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
  flushDanglingAssistantText(messages, assistantTextById);
  return satisfyOpenAiToolProtocol(repairOpenAiMessageSequence(messages)).slice(
    -CESIUM_HISTORY_MESSAGE_LIMIT
  );
}

export function repairOpenAiMessageSequence(messages: CesiumHistoryMessage[]): CesiumHistoryMessage[] {
  const repaired: CesiumHistoryMessage[] = [];
  for (const message of messages) {
    if (message.role === "tool") {
      // Results of one batch follow each other; they all answer the assistant message before them.
      let openerIndex = repaired.length - 1;
      while (openerIndex >= 0 && repaired[openerIndex]!.role === "tool") {
        openerIndex -= 1;
      }
      const opener = repaired[openerIndex];
      const hasMatchingCall =
        opener?.role === "assistant" &&
        opener.toolCalls?.some((call) => call.id === message.toolCallId);
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
    if (event.kind === "assistant_message_end" && event.stopReason === "discarded") {
      assistantText = "";
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
