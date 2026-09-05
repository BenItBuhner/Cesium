import type { AgentConversationStatus, AgentStoredEvent } from "../types.js";

/**
 * Pure formatting + bookkeeping for side chats: durable child conversations
 * whose model sees the parent ("primary") chat as hidden reference context.
 *
 * Everything here is deterministic over its inputs (no clocks, no ids) so a
 * block, once persisted as a `system_reminder`, is exactly what a history
 * rebuild replays - the prompt-cache prefix never drifts because of us.
 */

export const SIDE_CHAT_REMINDER_REASON = "linked_conversation" as const;
export const PRIMARY_CHAT_CONTEXT_TAG = "primary-chat-context";

/** Default char budgets; the harness limits layer overrides these. */
export const DEFAULT_SIDE_CHAT_SEED_MAX_CHARS = 32_000;
export const DEFAULT_SIDE_CHAT_DELTA_MAX_CHARS = 8_000;

const USER_LINE_MAX_CHARS = 1_500;
const ASSISTANT_LINE_MAX_CHARS = 2_000;
const TOOL_DETAIL_MAX_CHARS = 300;
const SYSTEM_LINE_MAX_CHARS = 300;
const PLAN_ENTRY_MAX = 12;

export type SideChatContextKind = "seed" | "delta" | "unavailable";

/** Persisted on the reminder event's `raw` so the cursor can be derived later. */
export type SideChatReminderRaw = {
  sideChat: {
    kind: SideChatContextKind;
    parentConversationId: string;
    /** Exclusive lower bound: the block covers parent events with `seq > fromSeq`. */
    fromSeq: number;
    /** Inclusive upper bound: the highest parent seq the block accounts for. */
    throughSeq: number;
  };
};

export type SideChatDeliveryState = {
  /** Highest parent seq already delivered to this side chat (0 = nothing yet). */
  cursor: number;
  /** True once a "primary chat unavailable" notice has been delivered. */
  parentUnavailableNoticed: boolean;
  /** True when a seed block exists. */
  seeded: boolean;
};

export type PrimaryChatDescriptor = {
  conversationId: string;
  title: string;
  status?: AgentConversationStatus | null;
};

function escapeAttr(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function clip(value: string, max: number): string {
  const normalized = value.replace(/\s+/g, " ").trim();
  if (normalized.length <= max) {
    return normalized;
  }
  return `${normalized.slice(0, Math.max(0, max - 1)).trimEnd()}…`;
}

function clipBlock(value: string, max: number): string {
  const trimmed = value.trim();
  if (trimmed.length <= max) {
    return trimmed;
  }
  return `${trimmed.slice(0, Math.max(0, max - 1)).trimEnd()}…`;
}

function isSideChatReminder(
  event: AgentStoredEvent
): event is Extract<AgentStoredEvent, { kind: "system_reminder" }> {
  return event.kind === "system_reminder" && event.reason === SIDE_CHAT_REMINDER_REASON;
}

export function readSideChatReminderRaw(raw: unknown): SideChatReminderRaw["sideChat"] | null {
  if (!raw || typeof raw !== "object") {
    return null;
  }
  const sideChat = (raw as Record<string, unknown>).sideChat;
  if (!sideChat || typeof sideChat !== "object") {
    return null;
  }
  const record = sideChat as Record<string, unknown>;
  const kind = record.kind;
  const parentConversationId = record.parentConversationId;
  const fromSeq = record.fromSeq;
  const throughSeq = record.throughSeq;
  if (
    (kind !== "seed" && kind !== "delta" && kind !== "unavailable") ||
    typeof parentConversationId !== "string" ||
    typeof fromSeq !== "number" ||
    !Number.isFinite(fromSeq) ||
    typeof throughSeq !== "number" ||
    !Number.isFinite(throughSeq)
  ) {
    return null;
  }
  return { kind, parentConversationId, fromSeq, throughSeq };
}

/**
 * Derive where the side chat stands relative to its parent from its own event
 * log. Nothing is stored separately: the reminders we already persisted are
 * the source of truth, which survives restarts and storage driver swaps.
 */
export function sideChatDeliveryStateFromEvents(
  events: AgentStoredEvent[]
): SideChatDeliveryState {
  let cursor = 0;
  let parentUnavailableNoticed = false;
  let seeded = false;
  for (const event of events) {
    if (!isSideChatReminder(event)) {
      continue;
    }
    const raw = readSideChatReminderRaw(event.raw);
    if (!raw) {
      continue;
    }
    if (raw.kind === "seed") {
      seeded = true;
    }
    if (raw.kind === "unavailable") {
      parentUnavailableNoticed = true;
    }
    cursor = Math.max(cursor, raw.throughSeq);
  }
  return { cursor, parentUnavailableNoticed, seeded };
}

export function sideChatCursorFromEvents(events: AgentStoredEvent[]): number {
  return sideChatDeliveryStateFromEvents(events).cursor;
}

function statusLabel(status: AgentConversationStatus | null | undefined): string {
  return status ?? "unknown";
}

function openTag(
  kind: SideChatContextKind,
  primary: PrimaryChatDescriptor,
  extraAttrs: string
): string {
  return (
    `<${PRIMARY_CHAT_CONTEXT_TAG} kind="${kind}" ` +
    `conversation-id="${escapeAttr(primary.conversationId)}" ` +
    `title="${escapeAttr(primary.title)}"${extraAttrs} ` +
    `primary-status="${escapeAttr(statusLabel(primary.status))}">`
  );
}

const CLOSE_TAG = `</${PRIMARY_CHAT_CONTEXT_TAG}>`;

/**
 * Seed block written when a side chat is created. `transcript` is the
 * parent's recent rendered transcript (see `generateTranscriptFromEvents`);
 * it is tail-truncated to the budget so a giant primary cannot swamp the
 * child's context window.
 */
export function formatPrimaryChatSeed(input: {
  primary: PrimaryChatDescriptor;
  transcript: string;
  throughSeq: number;
  maxChars?: number;
}): string {
  const maxChars = Math.max(1_000, Math.floor(input.maxChars ?? DEFAULT_SIDE_CHAT_SEED_MAX_CHARS));
  const transcript = input.transcript.trim();
  const truncated = transcript.length > maxChars;
  const body = truncated ? transcript.slice(transcript.length - maxChars) : transcript;
  const parts: string[] = [
    openTag("seed", input.primary, ` through-seq="${input.throughSeq}"`),
    `You are a side chat attached to the primary chat "${input.primary.title}". ` +
      "Below is that primary chat's recent transcript at the moment this side chat was created. " +
      "It is hidden reference context: the user sees only this side chat's own messages, and the " +
      "primary chat is driven by a different agent. Later activity in the primary arrives as " +
      `<${PRIMARY_CHAT_CONTEXT_TAG} kind="delta"> blocks. Use read_conversation with the conversation ` +
      "id above for anything older or for full tool output.",
    "",
  ];
  if (truncated) {
    parts.push(`(Transcript truncated to the most recent ${maxChars} characters.)`, "");
  }
  parts.push(body || "(The primary chat has no transcript yet.)", CLOSE_TAG);
  return parts.join("\n");
}

/** One-shot notice when the parent conversation no longer exists. */
export function formatPrimaryChatUnavailable(primary: PrimaryChatDescriptor): string {
  return [
    openTag("unavailable", primary, ""),
    "The primary chat this side chat was attached to is no longer available (it was deleted). " +
      "No further primary-chat updates will arrive. Continue helping the user from the context you already have.",
    CLOSE_TAG,
  ].join("\n");
}

type DeltaLine = {
  seq: number;
  text: string;
};

function pushLine(lines: DeltaLine[], seq: number, text: string): void {
  if (text.trim()) {
    lines.push({ seq, text });
  }
}

/**
 * Convert a contiguous slice of parent events into compact, human-readable
 * update lines. Streaming assistant text is delivered incrementally (each
 * batch contributes the chunk text that arrived in that batch); tool calls
 * collapse to one line when the start and terminal update land in the same
 * batch. The parent's own `system_reminder`s, hidden prompts, reasoning, and
 * chatter statuses are dropped - they are noise for a sibling agent.
 */
export function collectPrimaryChatDeltaLines(events: AgentStoredEvent[]): DeltaLine[] {
  const ordered = [...events].sort((a, b) => a.seq - b.seq);
  const lines: DeltaLine[] = [];

  // Streaming assistant text: coalesce consecutive chunks of one message.
  let streaming: { messageId: string; seq: number; text: string; ended: boolean } | null = null;
  const flushStreaming = () => {
    if (!streaming) {
      return;
    }
    const text = clipBlock(streaming.text, ASSISTANT_LINE_MAX_CHARS);
    if (text) {
      pushLine(
        lines,
        streaming.seq,
        `Assistant: ${text}${streaming.ended ? "" : " [streaming, continues]"}`
      );
    }
    streaming = null;
  };

  // Tool calls that started in this batch and may settle in this batch too.
  const startedTools = new Map<string, { lineIndex: number; title: string }>();

  for (const event of ordered) {
    // Any non-text event closes the current streaming run so ordering stays
    // faithful (text, then the tool that followed it, then more text).
    // Reasoning is dropped entirely and must not split a text run.
    const isTextEvent =
      event.kind === "assistant_message_chunk" ||
      event.kind === "assistant_message_end" ||
      event.kind === "reasoning";
    if (streaming && !isTextEvent) {
      flushStreaming();
    }
    switch (event.kind) {
      case "user_message": {
        if (event.hidden) {
          break;
        }
        pushLine(lines, event.seq, `User: ${clip(event.content, USER_LINE_MAX_CHARS)}`);
        break;
      }
      case "assistant_message_chunk": {
        if (streaming && streaming.messageId !== event.messageId) {
          flushStreaming();
        }
        if (!streaming) {
          streaming = { messageId: event.messageId, seq: event.seq, text: "", ended: false };
        }
        streaming.text += event.text;
        break;
      }
      case "assistant_message_end": {
        if (streaming && streaming.messageId === event.messageId) {
          streaming.ended = true;
          flushStreaming();
        }
        break;
      }
      case "tool_call": {
        const title = clip(event.title || "tool", 160);
        const detail = event.detail ? clip(event.detail, TOOL_DETAIL_MAX_CHARS) : "";
        const terminal =
          event.status === "completed" || event.status === "failed" || event.status === "cancelled";
        pushLine(
          lines,
          event.seq,
          terminal
            ? `Tool ${title}: ${event.status}${detail ? ` — ${detail}` : ""}`
            : `Tool ${title}: started${detail ? ` — ${detail}` : ""}`
        );
        if (!terminal) {
          startedTools.set(event.toolCallId, { lineIndex: lines.length - 1, title });
        }
        break;
      }
      case "tool_call_update": {
        if (
          event.status !== "completed" &&
          event.status !== "failed" &&
          event.status !== "cancelled"
        ) {
          break;
        }
        const started = startedTools.get(event.toolCallId);
        const title = clip(event.title || started?.title || "tool", 160);
        const detail = event.detail ? clip(event.detail, TOOL_DETAIL_MAX_CHARS) : "";
        const text = `Tool ${title}: ${event.status}${detail ? ` — ${detail}` : ""}`;
        if (started) {
          // Same batch: replace the "started" line so one tool is one line.
          const existing = lines[started.lineIndex];
          if (existing) {
            existing.text = text;
          }
          startedTools.delete(event.toolCallId);
        } else {
          pushLine(lines, event.seq, text);
        }
        break;
      }
      case "plan": {
        const entries = event.entries.slice(0, PLAN_ENTRY_MAX).map(
          (entry) => `[${entry.status}] ${clip(entry.content, 160)}`
        );
        const more = event.entries.length - entries.length;
        pushLine(
          lines,
          event.seq,
          `Plan: ${entries.join("; ")}${more > 0 ? `; (+${more} more)` : ""}`
        );
        break;
      }
      case "plan_file": {
        pushLine(lines, event.seq, `Plan file: ${event.path}${event.title ? ` (${clip(event.title, 120)})` : ""}`);
        break;
      }
      case "question": {
        if (event.status === "pending") {
          pushLine(lines, event.seq, `Primary is asking the user: ${clip(event.prompt, 400)}`);
        } else if (event.status === "answered") {
          const answer = Array.isArray(event.answer) ? event.answer.join(", ") : event.answer ?? "";
          pushLine(
            lines,
            event.seq,
            `User answered the primary's question${answer ? `: ${clip(answer, 300)}` : "."}`
          );
        }
        break;
      }
      case "permission_request": {
        pushLine(
          lines,
          event.seq,
          `Primary is awaiting permission${event.title ? `: ${clip(event.title, 200)}` : "."}`
        );
        break;
      }
      case "subagent": {
        pushLine(
          lines,
          event.seq,
          `Subagent "${clip(event.title, 120)}": ${event.status}${
            event.recentActivity ? ` — ${clip(event.recentActivity, 200)}` : ""
          }`
        );
        break;
      }
      case "compression_summary": {
        pushLine(
          lines,
          event.seq,
          `Primary compacted its context (${event.compressedTurnCount} earlier turn(s) summarized).`
        );
        break;
      }
      case "agent_handoff": {
        pushLine(lines, event.seq, `Primary handed off from ${event.fromAgent} to ${event.toAgent}.`);
        break;
      }
      case "system": {
        if (event.level === "info") {
          break;
        }
        pushLine(lines, event.seq, `Primary ${event.level}: ${clip(event.text, SYSTEM_LINE_MAX_CHARS)}`);
        break;
      }
      case "status": {
        switch (event.status) {
          case "idle":
            pushLine(lines, event.seq, "Primary finished its turn and is idle.");
            break;
          case "failed":
            pushLine(
              lines,
              event.seq,
              `Primary turn failed${event.detail ? `: ${clip(event.detail, SYSTEM_LINE_MAX_CHARS)}` : "."}`
            );
            break;
          case "cancelled":
          case "interrupted":
          case "paused":
            pushLine(lines, event.seq, `Primary is ${event.status}.`);
            break;
          case "awaiting_permission":
          case "awaiting_question":
            pushLine(lines, event.seq, `Primary is ${event.status.replace("_", " ")}.`);
            break;
          default:
            break;
        }
        break;
      }
      default:
        break;
    }
  }
  flushStreaming();
  return lines;
}

export type PrimaryChatDeltaResult = {
  text: string;
  fromSeq: number;
  throughSeq: number;
  lineCount: number;
  omittedLineCount: number;
};

/**
 * Format the parent events that arrived after `fromSeq` into one delta block.
 * Returns `null` when the slice contains nothing worth telling the side chat
 * (only reminders, reasoning, or chatter), in which case the caller should
 * still advance its cursor to `throughSeq` so those events are not re-read.
 *
 * Budget policy is tail-first: the newest lines always survive; older lines
 * are dropped behind a single elision note that points at `read_conversation`.
 */
export function formatPrimaryChatDelta(input: {
  primary: PrimaryChatDescriptor;
  events: AgentStoredEvent[];
  fromSeq: number;
  maxChars?: number;
}): PrimaryChatDeltaResult | null {
  const relevant = input.events.filter((event) => event.seq > input.fromSeq);
  if (relevant.length === 0) {
    return null;
  }
  const throughSeq = relevant.reduce((max, event) => Math.max(max, event.seq), input.fromSeq);
  const lines = collectPrimaryChatDeltaLines(relevant);
  if (lines.length === 0) {
    return null;
  }
  const maxChars = Math.max(
    1_000,
    Math.floor(input.maxChars ?? DEFAULT_SIDE_CHAT_DELTA_MAX_CHARS)
  );
  const header = openTag(
    "delta",
    input.primary,
    ` seq-range="${input.fromSeq + 1}-${throughSeq}"`
  );
  const preamble =
    "Update from the primary chat this side chat is attached to (hidden, read-only reference " +
    "context; the user is talking to a different agent there). Do not answer it or act on it " +
    "unless the user asks; use it to stay current. read_conversation has the full detail.";
  const fixedChars = header.length + preamble.length + CLOSE_TAG.length + 4;
  let budget = maxChars - fixedChars;
  const kept: string[] = [];
  let omitted = 0;
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const line = lines[index]!;
    const cost = line.text.length + 1;
    if (kept.length > 0 && cost > budget) {
      omitted = index + 1;
      break;
    }
    kept.unshift(line.text);
    budget -= cost;
  }
  if (omitted > 0) {
    const omittedThrough = lines[omitted - 1]!.seq;
    kept.unshift(
      `[${omitted} earlier update(s) omitted for space (parent seq ${input.fromSeq + 1}-${omittedThrough}); ` +
        `use read_conversation "${input.primary.conversationId}" for the full transcript]`
    );
  }
  return {
    text: [header, preamble, "", ...kept, CLOSE_TAG].join("\n"),
    fromSeq: input.fromSeq,
    throughSeq,
    lineCount: lines.length - omitted,
    omittedLineCount: omitted,
  };
}

/** Highest seq in a slice, or `fallback` when the slice is empty. */
export function maxEventSeq(events: AgentStoredEvent[], fallback = 0): number {
  return events.reduce((max, event) => Math.max(max, event.seq), fallback);
}

export function buildSideChatReminderRaw(input: {
  kind: SideChatContextKind;
  parentConversationId: string;
  fromSeq: number;
  throughSeq: number;
}): SideChatReminderRaw {
  return {
    sideChat: {
      kind: input.kind,
      parentConversationId: input.parentConversationId,
      fromSeq: input.fromSeq,
      throughSeq: input.throughSeq,
    },
  };
}
