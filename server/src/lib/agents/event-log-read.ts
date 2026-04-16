import type { AgentStoredEvent } from "./types.js";
import {
  getStoredConversationMinSeq,
  hasStoredConversationEventsBefore,
  readStoredConversationEventPrefixTail,
  readStoredConversationEventTail,
  readStoredConversationEvents,
  readStoredConversationEventsSince,
} from "../storage.js";

/** Default tail / history page sizing (websocket head, `request_history`, REST head). */
export const DEFAULT_PAGE_TURNS = 96;
export const DEFAULT_PAGE_EVENTS_CAP = 2000;
export const TAIL_INITIAL_CHUNK_BYTES = 256 * 1024;
export const TAIL_MAX_CHUNK_BYTES = 8 * 1024 * 1024;
/** Legacy constant retained for compatibility with callers/tests. */
export const EVENT_LOG_FULL_READ_MAX_BYTES = 4 * 1024 * 1024;

/** CLI / provider transcript context — bounded so multimillion-event logs cannot OOM the heap. */
export const PROMPT_CONTEXT_LIMIT_TURNS = 100;
export const PROMPT_CONTEXT_LIMIT_EVENTS = 8000;

/**
 * When `GET …?full=1` or `readConversationSnapshot` hits a log larger than
 * {@link EVENT_LOG_FULL_READ_MAX_BYTES}, return this tail window instead of loading JSONL wholesale.
 */
export const LARGE_LOG_SNAPSHOT_TURNS = 320;
export const LARGE_LOG_SNAPSHOT_EVENTS = 16_000;

export type ConversationEventPageMeta = {
  oldestSeq: number;
  newestSeq: number;
  hasOlder: boolean;
};

export function parseEventLine(line: string): AgentStoredEvent | null {
  const t = line.trim();
  if (!t) {
    return null;
  }
  try {
    return JSON.parse(t) as AgentStoredEvent;
  } catch {
    return null;
  }
}

function sortEventsBySeq(events: AgentStoredEvent[]): AgentStoredEvent[] {
  return [...events].sort((a, b) => a.seq - b.seq);
}

/** Drop leading events until the first user_message so projection fold starts on a turn boundary. */
export function trimToTurnStart(events: AgentStoredEvent[]): AgentStoredEvent[] {
  if (events.length === 0) {
    return events;
  }
  let i = 0;
  while (i < events.length && events[i]!.kind !== "user_message") {
    i += 1;
  }
  return i >= events.length ? events : events.slice(i);
}

/**
 * Keep a chronological suffix that contains at most `limitTurns` user turns and `limitEvents` events.
 */
export function takeLastTurnWindow(
  events: AgentStoredEvent[],
  limitTurns: number,
  limitEvents: number
): AgentStoredEvent[] {
  if (events.length === 0) {
    return events;
  }
  let userCount = 0;
  let start = 0;
  for (let i = events.length - 1; i >= 0; i -= 1) {
    if (events[i]!.kind === "user_message") {
      userCount += 1;
      start = i;
      if (userCount >= limitTurns) {
        break;
      }
    }
  }
  let slice = events.slice(start);
  if (slice.length > limitEvents) {
    slice = slice.slice(-limitEvents);
    slice = trimToTurnStart(slice);
  }
  return slice;
}

export type ReadTailPageResult = {
  events: AgentStoredEvent[];
} & ConversationEventPageMeta;

function parseStoragePath(filePath: string): { workspaceId: string; conversationId: string } | null {
  const normalized = filePath.replace(/\\/g, "/");
  const marker = "/workspaces/";
  const markerIndex = normalized.lastIndexOf(marker);
  if (markerIndex === -1) {
    return null;
  }
  const trailing = normalized.slice(markerIndex + marker.length);
  const segments = trailing.split("/").filter(Boolean);
  const workspacesIndex = segments.indexOf("conversations");
  if (workspacesIndex !== 1) {
    return null;
  }
  const workspaceId = segments[0];
  const conversationId = segments[2];
  if (!workspaceId || !conversationId) {
    return null;
  }
  return { workspaceId, conversationId };
}

async function readAllEventsFromStoreByPath(filePath: string): Promise<AgentStoredEvent[]> {
  const identity = parseStoragePath(filePath);
  if (!identity) {
    return [];
  }
  const rows = await readStoredConversationEvents(identity.workspaceId, identity.conversationId);
  return rows.map((row) => parseEventLine(row.payload)).filter((event): event is AgentStoredEvent => event != null);
}

/**
 * Read the newest region of the stored event log.
 */
export async function readConversationEventTailPage(
  filePath: string,
  options: {
    limitTurns: number;
    limitEvents: number;
    initialChunkBytes?: number;
    maxAccumulatedBytes?: number;
  }
): Promise<ReadTailPageResult & { scannedEntireFile: boolean }> {
  const limitTurns = Math.max(1, options.limitTurns);
  const limitEvents = Math.max(1, options.limitEvents);
  const identity = parseStoragePath(filePath);
  if (!identity) {
    return {
      events: [],
      oldestSeq: 0,
      newestSeq: 0,
      hasOlder: false,
      scannedEntireFile: true,
    };
  }
  const rows = await readStoredConversationEventTail(
    identity.workspaceId,
    identity.conversationId,
    Math.max(limitEvents * 4, limitTurns * 50, limitEvents)
  );
  const ordered = sortEventsBySeq(
    rows.map((row) => parseEventLine(row.payload)).filter((event): event is AgentStoredEvent => event != null)
  );
  const slice = takeLastTurnWindow(ordered, limitTurns, limitEvents);
  const oldestSeq = slice[0]?.seq ?? 0;
  const newestSeq = slice[slice.length - 1]?.seq ?? 0;
  const minSeq = await getStoredConversationMinSeq(identity.workspaceId, identity.conversationId);
  return {
    events: slice,
    oldestSeq,
    newestSeq,
    hasOlder: slice.length > 0 && minSeq != null && oldestSeq > minSeq,
    scannedEntireFile: true,
  };
}

/**
 * Events with seq < beforeSeq, turn-windowed from the end of that prefix.
 */
export async function readConversationEventHistoryPage(
  filePath: string,
  beforeSeq: number,
  options: { limitTurns: number; limitEvents: number; rollingCap?: number }
): Promise<ReadTailPageResult> {
  const limitTurns = Math.max(1, options.limitTurns);
  const limitEvents = Math.max(1, options.limitEvents);
  const identity = parseStoragePath(filePath);
  if (!identity || beforeSeq <= 1) {
    return { events: [], oldestSeq: 0, newestSeq: 0, hasOlder: false };
  }
  const rows = await readStoredConversationEventPrefixTail(
    identity.workspaceId,
    identity.conversationId,
    beforeSeq,
    Math.max(limitEvents * 4, limitTurns * 50, limitEvents)
  );
  const ordered = sortEventsBySeq(
    rows.map((row) => parseEventLine(row.payload)).filter((event): event is AgentStoredEvent => event != null)
  );
  const slice = takeLastTurnWindow(ordered, limitTurns, limitEvents);
  const oldestSeq = slice[0]?.seq ?? 0;
  const newestSeq = slice[slice.length - 1]?.seq ?? 0;
  const hasOlder =
    slice.length > 0 &&
    (await hasStoredConversationEventsBefore(identity.workspaceId, identity.conversationId, oldestSeq));
  return {
    events: slice,
    oldestSeq,
    newestSeq,
    hasOlder,
  };
}

/**
 * Events with seq > since.
 */
export async function readConversationEventsSinceEfficient(
  filePath: string,
  since: number
): Promise<AgentStoredEvent[]> {
  const identity = parseStoragePath(filePath);
  if (!identity) {
    return [];
  }
  const rows =
    since <= 0
      ? await readStoredConversationEvents(identity.workspaceId, identity.conversationId)
      : await readStoredConversationEventsSince(identity.workspaceId, identity.conversationId, since);
  return sortEventsBySeq(
    rows.map((row) => parseEventLine(row.payload)).filter((event): event is AgentStoredEvent => event != null)
  ).filter((event) => event.seq > since);
}

function formatToolCallForTranscript(event: Extract<AgentStoredEvent, { kind: "tool_call" }>): string {
  let result = `[Tool: ${event.title}]`;
  if (event.detail) {
    result += ` - ${event.detail}`;
  }
  return result;
}

function formatToolUpdateForTranscript(event: Extract<AgentStoredEvent, { kind: "tool_call_update" }>): string {
  let result = `[Tool Update: ${event.title ?? "tool"}]`;
  if (event.detail) {
    result += ` - ${event.detail}`;
  }
  result += ` (${event.status})`;
  return result;
}

function collectHiddenHandoffTranscriptMessageIds(
  events: AgentStoredEvent[]
): Set<string> {
  const hiddenMessageIds = new Set<string>();
  const ordered = [...events].sort((a, b) => a.seq - b.seq);
  for (let index = 0; index < ordered.length - 1; index += 1) {
    const current = ordered[index];
    const next = ordered[index + 1];
    if (
      current?.kind === "assistant_message_end" &&
      next?.kind === "agent_handoff"
    ) {
      hiddenMessageIds.add(current.messageId);
    }
  }
  return hiddenMessageIds;
}

export function generateTranscriptFromEvents(events: AgentStoredEvent[]): string {
  const lines: string[] = [];
  let currentUserMessage = "";
  let currentAssistantMessage: string[] = [];
  let inAssistantMessage = false;
  const hiddenHandoffTranscriptMessageIds = collectHiddenHandoffTranscriptMessageIds(events);

  const flushAssistant = () => {
    if (currentAssistantMessage.length > 0) {
      const text = currentAssistantMessage.join("");
      if (text.trim()) {
        lines.push(`Assistant: ${text.trim()}`);
      }
      currentAssistantMessage = [];
    }
    inAssistantMessage = false;
  };

  const flushUser = () => {
    if (currentUserMessage.trim()) {
      lines.push(`User: ${currentUserMessage.trim()}`);
      currentUserMessage = "";
    }
  };

  const ordered = [...events].sort((a, b) => a.seq - b.seq);

  for (const event of ordered) {
    switch (event.kind) {
      case "user_message":
        flushAssistant();
        flushUser();
        currentUserMessage = event.content;
        break;

      case "assistant_message_chunk":
        if (hiddenHandoffTranscriptMessageIds.has(event.messageId)) {
          break;
        }
        if (!inAssistantMessage) {
          flushUser();
          inAssistantMessage = true;
        }
        currentAssistantMessage.push(event.text);
        break;

      case "assistant_message_end":
        if (hiddenHandoffTranscriptMessageIds.has(event.messageId)) {
          break;
        }
        flushAssistant();
        break;

      case "reasoning":
        flushUser();
        if (event.text.trim()) {
          lines.push(`[Thinking: ${event.text.trim()}]`);
        }
        break;

      case "tool_call":
        flushUser();
        flushAssistant();
        lines.push(formatToolCallForTranscript(event));
        break;

      case "tool_call_update":
        flushUser();
        flushAssistant();
        lines.push(formatToolUpdateForTranscript(event));
        break;

      case "plan":
        flushUser();
        if (event.entries.length > 0) {
          lines.push("[Plan]");
          for (const entry of event.entries) {
            const status = entry.status === "completed" ? "[x]" : "[ ]";
            lines.push(`  ${status} ${entry.content}`);
          }
        }
        break;

      case "permission_request":
        flushUser();
        lines.push(`[Permission Required: ${event.title ?? "permission"}]`);
        if (event.detail) {
          lines.push(`  ${event.detail}`);
        }
        break;

      case "permission_resolved":
        flushUser();
        lines.push(`[Permission ${event.outcome}]`);
        break;

      case "system":
        flushUser();
        lines.push(`[System: ${event.text}]`);
        break;

      case "status":
        flushUser();
        if (event.status === "failed") {
          lines.push(`[Status: Failed]${event.detail ? ` - ${event.detail}` : ""}`);
        } else if (event.status === "cancelled") {
          lines.push("[Status: Cancelled]");
        }
        break;

      default:
        break;
    }
  }

  flushAssistant();
  flushUser();

  return lines.join("\n");
}
