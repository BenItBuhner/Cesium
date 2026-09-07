import { asRecord, asString, parseJsonArgs } from "./cesium/cesium-coerce.js";
import {
  inferCesiumToolNameFromTitle,
  serializeToolCallArguments,
} from "./cesium/cesium-tools.js";
import type {
  AgentContextSegmentKind,
  AgentContextTranscript,
  AgentContextTranscriptEntry,
  AgentContextTranscriptToolCall,
  AgentContextUsageCategory,
  AgentContextUsageCategoryId,
  AgentContextUsageSegment,
  AgentContextUsageSnapshot,
  AgentConversationRecord,
  AgentStoredEvent,
} from "./types.js";

type SystemReminderEvent = Extract<AgentStoredEvent, { kind: "system_reminder" }>;
type AssistantChunkEvent = Extract<AgentStoredEvent, { kind: "assistant_message_chunk" }>;
type ToolCallEvent = Extract<AgentStoredEvent, { kind: "tool_call" }>;
type ToolCallUpdateEvent = Extract<AgentStoredEvent, { kind: "tool_call_update" }>;

export const CONTEXT_CATEGORY_ORDER: readonly AgentContextUsageCategoryId[] = [
  "system_prompt",
  "tool_definitions",
  "mcp",
  "summarized_conversation",
  "conversation",
];

export const CONTEXT_CATEGORY_LABEL: Record<AgentContextUsageCategoryId, string> = {
  system_prompt: "System prompt",
  tool_definitions: "Tool definitions",
  mcp: "MCP",
  summarized_conversation: "Summarized conversation",
  conversation: "Conversation",
};

export const CONTEXT_CATEGORY_COLOR_KEY: Record<AgentContextUsageCategoryId, string> = {
  system_prompt: "system",
  tool_definitions: "tools",
  mcp: "mcp",
  summarized_conversation: "summarized",
  conversation: "conversation",
};

const SEGMENT_DETAIL_MAX_CHARS = 96;

/** Character-based estimate shared by every context accounting path (~4 chars/token). */
export function estimateContextTokensFromText(text: string): number {
  const trimmed = text.trim();
  return trimmed ? Math.ceil(trimmed.length / 4) : 0;
}

function firstLine(text: string | undefined): string | undefined {
  if (!text) {
    return undefined;
  }
  const line = text
    .split("\n")
    .map((part) => part.trim())
    .find((part) => part.length > 0);
  if (!line) {
    return undefined;
  }
  return line.length > SEGMENT_DETAIL_MAX_CHARS
    ? `${line.slice(0, SEGMENT_DETAIL_MAX_CHARS - 1)}…`
    : line;
}

function segmentId(kind: AgentContextSegmentKind, seq: number): string {
  return `${kind}:${seq}`;
}

/**
 * Targeted reminders that replay merged onto their user message. Mirrors the
 * selection in `normalizeEventsToHistory`: for the dynamic reasons (`mode`,
 * `plan_handoff`, `other`) only the newest reminder of each reason survives.
 */
function targetedRemindersByMessageId(
  events: AgentStoredEvent[]
): Map<string, SystemReminderEvent[]> {
  const latestDynamicSeq = new Map<string, number>();
  for (const event of events) {
    if (event.kind !== "system_reminder") {
      continue;
    }
    if (event.reason !== "mode" && event.reason !== "plan_handoff" && event.reason !== "other") {
      continue;
    }
    latestDynamicSeq.set(
      event.reason,
      Math.max(latestDynamicSeq.get(event.reason) ?? -1, event.seq)
    );
  }
  const byMessageId = new Map<string, SystemReminderEvent[]>();
  for (const event of events) {
    if (event.kind !== "system_reminder" || !event.targetMessageId || !event.text.trim()) {
      continue;
    }
    const latestSeq = latestDynamicSeq.get(event.reason);
    if (latestSeq != null && event.seq !== latestSeq) {
      continue;
    }
    const existing = byMessageId.get(event.targetMessageId) ?? [];
    existing.push(event);
    byMessageId.set(event.targetMessageId, existing);
  }
  return byMessageId;
}

function toolNameFromEvent(
  event: ToolCallEvent | ToolCallUpdateEvent,
  fallbackTitle?: string
): string {
  const raw = asRecord(event.raw);
  const request = asRecord(raw?.request) ?? raw;
  const title = event.title ?? fallbackTitle;
  return (
    asString(request?.name) ??
    inferCesiumToolNameFromTitle(title) ??
    title?.trim().split(/\s+/)[0] ??
    "tool"
  );
}

/**
 * Arguments as the history serializes them. `tool_call` rows may carry the
 * arguments JSON in `detail`; for `tool_call_update` rows `detail` is the
 * result, so only the raw request is consulted there.
 */
function toolArgumentsFromEvent(
  event: ToolCallEvent | ToolCallUpdateEvent,
  name: string
): { serialized: string; parsed: Record<string, unknown> | string | null } {
  const raw = asRecord(event.raw);
  const request = asRecord(raw?.request) ?? raw;
  const detail = event.kind === "tool_call" ? event.detail : undefined;
  const serialized = serializeToolCallArguments(name, request?.arguments, detail);
  if (serialized !== "{}") {
    return { serialized, parsed: parseJsonArgs(serialized) };
  }
  // Non-Cesium harnesses may store plain-text call details; keep them verbatim.
  const plain = detail?.trim();
  if (plain) {
    return { serialized: plain, parsed: plain };
  }
  return { serialized: "{}", parsed: null };
}

/** MCP payloads count toward the MCP bucket: tool schemas, `call_mcp_tool` traffic, and reads of the mirrored `mcp-servers/` metadata. */
function isMcpToolCall(toolKind: string, name: string, args: Record<string, unknown> | string | null): boolean {
  if (toolKind === "mcp" || name === "call_mcp_tool" || name === "refresh_mcp_servers") {
    return true;
  }
  if (args && typeof args === "object") {
    const path = asString(args.path) ?? asString(args.file) ?? asString(args.directory);
    if (path && /^\.?\/?mcp-servers(\/|$)/.test(path)) {
      return true;
    }
  }
  return false;
}

type PendingAssistant = {
  messageId: string;
  text: string;
  firstChunk: AssistantChunkEvent;
  lastChunk: AssistantChunkEvent;
};

type ToolEntryState = {
  entry: AgentContextTranscriptEntry;
  callEvent: ToolCallEvent | null;
  latestUpdate: ToolCallUpdateEvent | null;
  argsSerialized: string;
};

/** One row for the whole streamed message; `firstSeq` is the client-side compaction marker for swallowed chunk rows. */
function mergedAssistantChunkRow(pending: PendingAssistant): AssistantChunkEvent {
  const row: AssistantChunkEvent & { firstSeq?: number } = {
    ...pending.lastChunk,
    text: pending.text,
  };
  if (pending.firstChunk.seq !== pending.lastChunk.seq) {
    row.firstSeq = pending.firstChunk.seq;
  }
  return row;
}

function toolEntryTokens(state: ToolEntryState): number {
  const call = state.entry.toolCall!;
  return (
    estimateContextTokensFromText(state.argsSerialized) +
    estimateContextTokensFromText(call.result ?? "")
  );
}

function refreshToolEntry(state: ToolEntryState): void {
  const call = state.entry.toolCall!;
  const categoryId: AgentContextUsageCategoryId = isMcpToolCall(
    call.toolKind,
    call.name,
    call.arguments
  )
    ? "mcp"
    : "conversation";
  state.entry.categoryId = categoryId;
  state.entry.colorKey = CONTEXT_CATEGORY_COLOR_KEY[categoryId];
  state.entry.label = call.title || call.name;
  state.entry.detail = `${call.name} · ${call.status}`;
  state.entry.tokens = toolEntryTokens(state);
  state.entry.events = [
    ...(state.callEvent ? [state.callEvent] : []),
    ...(state.latestUpdate ? [state.latestUpdate] : []),
  ];
  const seqs = state.entry.events.map((event) => event.seq);
  state.entry.seqStart = Math.min(...seqs);
  state.entry.seqEnd = Math.max(...seqs);
}

/**
 * Project stored events onto the chronological blocks the model receives.
 * Follows `normalizeEventsToHistory` block-for-block (user + merged targeted
 * reminders, inline reminders, assistant text per message id, reasoning, tool
 * call + result, plan, compaction summary, handoff, fork) so every block's
 * estimate lines up with the history that is actually sent. Events that never
 * reach the model (status, permissions, questions, subagent cards) are skipped.
 */
export function buildConversationContextEntries(
  events: AgentStoredEvent[]
): AgentContextTranscriptEntry[] {
  const sorted = [...events].sort((a, b) => a.seq - b.seq);
  const remindersByMessageId = targetedRemindersByMessageId(sorted);
  const entries: AgentContextTranscriptEntry[] = [];
  const assistantById = new Map<string, PendingAssistant>();
  const toolStates = new Map<string, ToolEntryState>();

  const pushText = (input: {
    kind: AgentContextSegmentKind;
    categoryId: AgentContextUsageCategoryId;
    label: string;
    text: string;
    tokensText?: string;
    detail?: string;
    events: AgentStoredEvent[];
    extra?: Partial<AgentContextTranscriptEntry>;
  }): AgentContextTranscriptEntry => {
    const seqStart = Math.min(
      ...input.events.map((event) => (event as { firstSeq?: number }).firstSeq ?? event.seq)
    );
    const entry: AgentContextTranscriptEntry = {
      id: segmentId(input.kind, seqStart),
      kind: input.kind,
      categoryId: input.categoryId,
      label: input.label,
      tokens: estimateContextTokensFromText(input.tokensText ?? input.text),
      colorKey: CONTEXT_CATEGORY_COLOR_KEY[input.categoryId],
      seqStart,
      seqEnd: Math.max(...input.events.map((event) => event.seq)),
      createdAt: input.events[0]?.createdAt,
      detail: input.detail,
      text: input.text,
      events: input.events,
      ...input.extra,
    };
    entries.push(entry);
    return entry;
  };

  const finishAssistant = (messageId: string, endEvent?: AgentStoredEvent) => {
    const pending = assistantById.get(messageId);
    if (!pending) {
      return;
    }
    assistantById.delete(messageId);
    const text = pending.text.trim();
    if (!text) {
      return;
    }
    pushText({
      kind: "assistant_message",
      categoryId: "conversation",
      label: "Assistant reply",
      text,
      detail: firstLine(text),
      events: [mergedAssistantChunkRow(pending), ...(endEvent ? [endEvent] : [])],
    });
  };

  for (const event of sorted) {
    switch (event.kind) {
      case "user_message": {
        if (event.hidden) {
          break;
        }
        const reminderEvents = remindersByMessageId.get(event.messageId) ?? [];
        const reminderText = reminderEvents.map((reminder) => reminder.text.trim());
        const historyContent = reminderText.length
          ? `${reminderText.join("\n\n")}\n\n${event.content}`
          : event.content;
        const attachments = (event.attachments ?? []).map((attachment) => ({
          name: attachment.name,
          mimeType: attachment.mimeType,
          kind: attachment.kind,
          size: attachment.size,
        }));
        pushText({
          kind: "user_message",
          categoryId: "conversation",
          label: "User message",
          text: event.content,
          tokensText: historyContent,
          detail: firstLine(event.displayContent ?? event.content),
          events: [event, ...reminderEvents],
          extra: {
            ...(reminderEvents.length
              ? {
                  reminders: reminderEvents.map((reminder) => ({
                    reason: reminder.reason,
                    text: reminder.text,
                  })),
                }
              : {}),
            ...(attachments.length ? { attachments } : {}),
          },
        });
        break;
      }
      case "system_reminder":
        if (event.placement === "inline" && event.text.trim()) {
          pushText({
            kind: "system_reminder",
            categoryId: "conversation",
            label: "System reminder",
            text: event.text,
            detail: event.reason,
            events: [event],
          });
        }
        break;
      case "assistant_message_chunk": {
        const pending = assistantById.get(event.messageId);
        if (pending) {
          pending.text += event.text;
          pending.lastChunk = event;
        } else {
          assistantById.set(event.messageId, {
            messageId: event.messageId,
            text: event.text,
            firstChunk: event,
            lastChunk: event,
          });
        }
        break;
      }
      case "assistant_message_end":
        finishAssistant(event.messageId, event);
        break;
      case "reasoning":
        if (event.text.trim()) {
          pushText({
            kind: "reasoning",
            categoryId: "conversation",
            label: "Reasoning",
            text: event.text.trim(),
            tokensText: `[Reasoning]\n${event.text.trim()}`,
            detail: firstLine(event.text),
            events: [event],
          });
        }
        break;
      case "tool_call": {
        const name = toolNameFromEvent(event);
        const args = toolArgumentsFromEvent(event, name);
        const toolCall: AgentContextTranscriptToolCall = {
          toolCallId: event.toolCallId,
          name,
          title: event.title,
          toolKind: event.toolKind,
          status: event.status,
          arguments: args.parsed,
          result: null,
          ...(event.editPreview ? { editPreview: event.editPreview } : {}),
          ...(event.locations ? { locations: event.locations } : {}),
          ...(event.pluginId ? { pluginId: event.pluginId } : {}),
          ...(event.pluginName ? { pluginName: event.pluginName } : {}),
          ...(event.pluginIconUrl ? { pluginIconUrl: event.pluginIconUrl } : {}),
        };
        const entry: AgentContextTranscriptEntry = {
          id: segmentId("tool_call", event.seq),
          kind: "tool_call",
          categoryId: "conversation",
          label: event.title,
          tokens: 0,
          colorKey: CONTEXT_CATEGORY_COLOR_KEY.conversation,
          seqStart: event.seq,
          seqEnd: event.seq,
          createdAt: event.createdAt,
          toolCall,
          events: [event],
        };
        const state: ToolEntryState = {
          entry,
          callEvent: event,
          latestUpdate: null,
          argsSerialized: args.serialized,
        };
        toolStates.set(event.toolCallId, state);
        entries.push(entry);
        refreshToolEntry(state);
        break;
      }
      case "tool_call_update": {
        let state = toolStates.get(event.toolCallId);
        if (!state) {
          const name = toolNameFromEvent(event);
          const args = toolArgumentsFromEvent(event, name);
          const entry: AgentContextTranscriptEntry = {
            id: segmentId("tool_call", event.seq),
            kind: "tool_call",
            categoryId: "conversation",
            label: event.title ?? name,
            tokens: 0,
            colorKey: CONTEXT_CATEGORY_COLOR_KEY.conversation,
            seqStart: event.seq,
            seqEnd: event.seq,
            createdAt: event.createdAt,
            toolCall: {
              toolCallId: event.toolCallId,
              name,
              title: event.title ?? name,
              toolKind: event.toolKind ?? "tool",
              status: event.status,
              arguments: args.parsed,
              result: null,
            },
            events: [],
          };
          state = {
            entry,
            callEvent: null,
            latestUpdate: null,
            argsSerialized: args.serialized,
          };
          toolStates.set(event.toolCallId, state);
          entries.push(entry);
        }
        const call = state.entry.toolCall!;
        call.status = event.status;
        if (event.title?.trim()) {
          call.title = event.title;
        }
        if (event.toolKind?.trim()) {
          call.toolKind = event.toolKind;
        }
        if (event.detail != null && event.detail.trim()) {
          call.result = event.detail;
        } else if (event.status === "failed" && !call.result) {
          call.result = "Tool call failed.";
        } else if (event.status === "completed" && !call.result) {
          call.result = "Tool call completed with no output.";
        }
        if (event.editPreview) call.editPreview = event.editPreview;
        if (event.locations) call.locations = event.locations;
        if (event.pluginId) call.pluginId = event.pluginId;
        if (event.pluginName) call.pluginName = event.pluginName;
        if (event.pluginIconUrl) call.pluginIconUrl = event.pluginIconUrl;
        state.latestUpdate = event;
        refreshToolEntry(state);
        break;
      }
      case "plan": {
        const text = event.entries
          .map((entry) => `- [${entry.status}] ${entry.content}`)
          .join("\n");
        if (text.trim()) {
          pushText({
            kind: "plan",
            categoryId: "conversation",
            label: "Plan update",
            text,
            detail: `${event.entries.length} item${event.entries.length === 1 ? "" : "s"}`,
            events: [event],
          });
        }
        break;
      }
      case "compression_summary":
        pushText({
          kind: "compaction_summary",
          categoryId: "summarized_conversation",
          label: "Compaction summary",
          text: event.summary,
          tokensText: `[Compressed earlier conversation]\n${event.summary}`,
          detail: `${event.compressedTurnCount} turn${event.compressedTurnCount === 1 ? "" : "s"} compressed`,
          events: [event],
          extra: {
            compaction: {
              retainedTurnCount: event.retainedTurnCount,
              compressedTurnCount: event.compressedTurnCount,
              ...(event.sourceRange ? { sourceRange: event.sourceRange } : {}),
              ...(event.estimatedTokensBefore != null
                ? { estimatedTokensBefore: event.estimatedTokensBefore }
                : {}),
              ...(event.estimatedTokensAfter != null
                ? { estimatedTokensAfter: event.estimatedTokensAfter }
                : {}),
              ...(event.generation != null ? { generation: event.generation } : {}),
            },
          },
        });
        break;
      case "agent_handoff":
        pushText({
          kind: "agent_handoff",
          categoryId: "conversation",
          label: "Agent handoff",
          text: `[Handoff from ${event.fromAgent} to ${event.toAgent}]`,
          detail: `${event.fromAgent} → ${event.toAgent}`,
          events: [event],
        });
        break;
      case "chat_fork":
        pushText({
          kind: "chat_fork",
          categoryId: "conversation",
          label: "Forked chat",
          text: event.transcript,
          tokensText: `[Forked chat]\n${event.transcript}`,
          detail: `from ${event.fromAgent}`,
          events: [event],
        });
        break;
      default:
        break;
    }
  }
  // Streams cut off before `assistant_message_end` still occupy context.
  for (const messageId of [...assistantById.keys()]) {
    finishAssistant(messageId);
  }
  return entries.sort((a, b) => (a.seqStart ?? 0) - (b.seqStart ?? 0));
}

/**
 * Best-effort transcript for harnesses whose system prompt and tool schemas
 * Cesium never sees (Codex, Claude Code, Pi, ACP agents): conversation blocks
 * are reconstructed from the stored transcript, and provider-native totals
 * are kept when the harness reports them.
 */
export function buildEventsOnlyContextTranscript(input: {
  conversation: Pick<AgentConversationRecord, "id" | "config">;
  events: AgentStoredEvent[];
  usage: AgentContextUsageSnapshot | null;
}): AgentContextTranscript {
  const entries = buildConversationContextEntries(input.events);
  const timeline = entries.map(contextEntryToSegment);
  const estimatedUsed = timeline.reduce((sum, segment) => sum + segment.tokens, 0);
  const providerUsage = input.usage?.supported ? input.usage : null;
  const limitTokens = providerUsage?.limitTokens ?? 0;
  const usedTokens = providerUsage?.usedTokens ?? estimatedUsed;
  return {
    conversationId: input.conversation.id,
    backendId: input.conversation.config.backendId ?? "cesium-agent",
    modelId: input.conversation.config.modelId ?? null,
    generatedAt: Date.now(),
    usage: {
      supported: providerUsage != null,
      limitTokens,
      usedTokens,
      percentFull:
        providerUsage?.percentFull ??
        (limitTokens > 0 ? Math.min(100, Math.round((usedTokens / limitTokens) * 100)) : 0),
      categories: providerUsage?.categories ?? poolContextEntries(timeline),
      approximate: true,
      timeline,
    },
    entries,
    notes: [
      "This agent runs in an external harness, so its system prompt and tool schemas are not visible to Cesium. " +
        "Conversation blocks are reconstructed from the stored transcript with character-based token estimates.",
      ...(providerUsage
        ? ["Totals in the header come from the harness itself; per-block counts are estimates."]
        : []),
    ],
  };
}

/** Strip verbatim content, leaving the lightweight segment for the dock. */
export function contextEntryToSegment(entry: AgentContextTranscriptEntry): AgentContextUsageSegment {
  return {
    id: entry.id,
    kind: entry.kind,
    categoryId: entry.categoryId,
    label: entry.label,
    tokens: entry.tokens,
    colorKey: entry.colorKey,
    ...(entry.seqStart != null ? { seqStart: entry.seqStart } : {}),
    ...(entry.seqEnd != null ? { seqEnd: entry.seqEnd } : {}),
    ...(entry.createdAt != null ? { createdAt: entry.createdAt } : {}),
    ...(entry.detail ? { detail: entry.detail } : {}),
  };
}

/**
 * Pool chronological blocks into the classic category rows. Zero rows are
 * dropped, except Conversation stays visible whenever conversation blocks
 * exist so an active chat never renders an empty legend.
 */
export function poolContextEntries(
  entries: AgentContextUsageSegment[]
): AgentContextUsageCategory[] {
  const totals = new Map<AgentContextUsageCategoryId, number>();
  const present = new Set<AgentContextUsageCategoryId>();
  for (const entry of entries) {
    totals.set(entry.categoryId, (totals.get(entry.categoryId) ?? 0) + entry.tokens);
    present.add(entry.categoryId);
  }
  return CONTEXT_CATEGORY_ORDER.filter(
    (id) => (totals.get(id) ?? 0) > 0 || (id === "conversation" && present.has(id))
  ).map((id) => ({
    id,
    label: CONTEXT_CATEGORY_LABEL[id],
    tokens: totals.get(id) ?? 0,
    colorKey: CONTEXT_CATEGORY_COLOR_KEY[id],
  }));
}
