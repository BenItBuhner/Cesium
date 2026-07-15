import { createReadStream } from "node:fs";
import { open } from "node:fs/promises";
import { createInterface } from "node:readline";
import type { AgentStoredEvent } from "./types.js";

/** Default tail / history page sizing (websocket head, `request_history`, REST head). */
export const DEFAULT_PAGE_TURNS = 96;
export const DEFAULT_PAGE_EVENTS_CAP = 2000;
/**
 * If the log has **fewer** than this many `user_message` events, the server returns the
 * full visible window in one response and never advertises "older" history. Avoids
 * useless pagination, scroll dead-zones, and janky prepend/anchor on very short threads.
 */
/** Below this many user messages in a visible prefix, return the full prefix and disable older pagination. */
export const PAGINATION_MIN_USER_TURNS = 5;

/** When paginating a long log, widen the newest window backward until it includes at least this many user turns (if available). */
export const MIN_USER_TURNS_IN_INITIAL_HEAD = 5;
export const TAIL_INITIAL_CHUNK_BYTES = 256 * 1024;
export const TAIL_MAX_CHUNK_BYTES = 8 * 1024 * 1024;
/** Beyond this, full read is avoided; tail uses expanding chunks and history uses streaming + trim. */
export const EVENT_LOG_FULL_READ_MAX_BYTES = 4 * 1024 * 1024;

/** CLI / provider transcript context — bounded so multimillion-event logs cannot OOM the heap. */
export const PROMPT_CONTEXT_LIMIT_TURNS = 250;
export const PROMPT_CONTEXT_LIMIT_EVENTS = 20_000;

/**
 * When `GET …?full=1` or `readConversationSnapshot` hits a log larger than
 * {@link EVENT_LOG_FULL_READ_MAX_BYTES}, return this tail window instead of loading JSONL wholesale.
 */
export const LARGE_LOG_SNAPSHOT_TURNS = 320;
export const LARGE_LOG_SNAPSHOT_EVENTS = 16_000;

/** Yield to the event loop while streaming very long history scans (reduces GC pause + starvation). */
const HISTORY_STREAM_YIELD_EVERY_LINES = 2500;

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

export function countUserMessageEvents(events: AgentStoredEvent[]): number {
  let n = 0;
  for (const e of events) {
    if (e.kind === "user_message") {
      n += 1;
    }
  }
  return n;
}

/**
 * If `slice` was truncated (e.g. by `limitEvents`) so it contains fewer than `minUserTurns`
 * user messages, extend it earlier within `allChronological` while events exist.
 */
export function expandSliceToMinUserTurns(
  allChronological: AgentStoredEvent[],
  slice: AgentStoredEvent[],
  minUserTurns: number
): AgentStoredEvent[] {
  if (slice.length === 0 || allChronological.length === 0 || minUserTurns <= 0) {
    return slice;
  }
  if (countUserMessageEvents(slice) >= minUserTurns) {
    return slice;
  }
  const firstSeq = slice[0]!.seq;
  let startIdx = allChronological.findIndex((e) => e.seq === firstSeq);
  if (startIdx < 0) {
    return slice;
  }
  const lastSeq = slice[slice.length - 1]!.seq;
  const endIdx = allChronological.findIndex((e) => e.seq === lastSeq);
  if (endIdx < 0) {
    return slice;
  }
  while (startIdx > 0 && countUserMessageEvents(allChronological.slice(startIdx, endIdx + 1)) < minUserTurns) {
    startIdx -= 1;
  }
  return allChronological.slice(startIdx, endIdx + 1);
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

/**
 * Read the newest region of the JSONL log without loading the whole file (for large logs).
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
  const initialChunk = options.initialChunkBytes ?? TAIL_INITIAL_CHUNK_BYTES;
  const maxAccumulated = options.maxAccumulatedBytes ?? TAIL_MAX_CHUNK_BYTES;

  let fh;
  try {
    fh = await open(filePath, "r");
  } catch {
    return {
      events: [],
      oldestSeq: 0,
      newestSeq: 0,
      hasOlder: false,
      scannedEntireFile: true,
    };
  }

  try {
    const stat = await fh.stat();
    const fileSize = stat.size;
    if (fileSize === 0) {
      return {
        events: [],
        oldestSeq: 0,
        newestSeq: 0,
        hasOlder: false,
        scannedEntireFile: true,
      };
    }

    if (fileSize <= EVENT_LOG_FULL_READ_MAX_BYTES) {
      const raw = Buffer.alloc(fileSize);
      await fh.read(raw, 0, fileSize, 0);
      const lines = raw
        .toString("utf8")
        .split(/\r?\n/)
        .map((l) => l.trim())
        .filter(Boolean);
      const parsed = lines
        .map(parseEventLine)
        .filter((e): e is AgentStoredEvent => e != null);
      const ordered = sortEventsBySeq(parsed);
      const userTurns = countUserMessageEvents(ordered);
      if (userTurns < PAGINATION_MIN_USER_TURNS) {
        const full = trimToTurnStart(ordered);
        return {
          events: full,
          oldestSeq: full[0]?.seq ?? 0,
          newestSeq: full[full.length - 1]?.seq ?? 0,
          hasOlder: false,
          scannedEntireFile: true,
        };
      }
      const slice = takeLastTurnWindow(ordered, limitTurns, limitEvents);
      const oldestSeq = slice[0]?.seq ?? 0;
      const newestSeq = slice[slice.length - 1]?.seq ?? 0;
      const fileMinSeq = ordered[0]?.seq ?? oldestSeq;
      return {
        events: slice,
        oldestSeq,
        newestSeq,
        hasOlder: ordered.length > 0 && oldestSeq > fileMinSeq,
        scannedEntireFile: true,
      };
    }

    let bytesFromEnd = 0;
    let chunkSize = initialChunk;
    const lineBuf: string[] = [];
    let scannedEntireFile = false;

    while (bytesFromEnd < fileSize) {
      const readLen = Math.min(chunkSize, fileSize - bytesFromEnd);
      const start = fileSize - bytesFromEnd - readLen;
      const buf = Buffer.alloc(readLen);
      await fh.read(buf, 0, readLen, start);
      let text = buf.toString("utf8");
      if (start > 0) {
        const nl = text.indexOf("\n");
        if (nl === -1) {
          bytesFromEnd += readLen;
          chunkSize = Math.min(chunkSize * 2, maxAccumulated);
          continue;
        }
        text = text.slice(nl + 1);
      }
      const newLines = text
        .split(/\r?\n/)
        .map((l) => l.trim())
        .filter(Boolean);
      lineBuf.splice(0, 0, ...newLines);
      bytesFromEnd += readLen;

      const parsed = lineBuf
        .map(parseEventLine)
        .filter((e): e is AgentStoredEvent => e != null);
      const ordered = sortEventsBySeq(parsed);
      const haveWholeFile = bytesFromEnd >= fileSize;
      if (haveWholeFile) {
        scannedEntireFile = true;
      }
      if (haveWholeFile && countUserMessageEvents(ordered) < PAGINATION_MIN_USER_TURNS) {
        const full = trimToTurnStart(ordered);
        return {
          events: full,
          oldestSeq: full[0]?.seq ?? 0,
          newestSeq: full[full.length - 1]?.seq ?? 0,
          hasOlder: false,
          scannedEntireFile: true,
        };
      }
      const slice = takeLastTurnWindow(ordered, limitTurns, limitEvents);
      const minSeqInBuffer = ordered[0]?.seq ?? 0;
      const oldestInSlice = slice[0]?.seq ?? 0;
      const usersInSlice = slice.filter((e) => e.kind === "user_message").length;

      if (slice.length > 0 && (haveWholeFile || usersInSlice >= limitTurns)) {
        const newestSeq = slice[slice.length - 1]?.seq ?? 0;
        return {
          events: slice,
          oldestSeq: oldestInSlice,
          newestSeq,
          hasOlder: !haveWholeFile || oldestInSlice > minSeqInBuffer,
          scannedEntireFile: haveWholeFile,
        };
      }

      if (haveWholeFile) {
        const newestSeq = slice[slice.length - 1]?.seq ?? 0;
        return {
          events: slice,
          oldestSeq: oldestInSlice,
          newestSeq,
          hasOlder: oldestInSlice > minSeqInBuffer,
          scannedEntireFile: true,
        };
      }

      chunkSize = Math.min(chunkSize * 2, maxAccumulated);
    }

    scannedEntireFile = bytesFromEnd >= fileSize;
    return {
      events: [],
      oldestSeq: 0,
      newestSeq: 0,
      hasOlder: false,
      scannedEntireFile,
    };
  } finally {
    await fh.close();
  }
}

/**
 * Events with seq < beforeSeq, turn-windowed from the end of that prefix (chronological order).
 * Streams the file for correctness on arbitrarily large logs (bounded memory via trim during scan).
 */
export async function readConversationEventHistoryPage(
  filePath: string,
  beforeSeq: number,
  options: { limitTurns: number; limitEvents: number; rollingCap?: number }
): Promise<ReadTailPageResult> {
  const limitTurns = Math.max(1, options.limitTurns);
  const limitEvents = Math.max(1, options.limitEvents);
  const rollingCap =
    options.rollingCap ??
    Math.min(
      96_000,
      Math.max(limitEvents * 40, limitTurns * 1600, 12_000)
    );

  let statSize = 0;
  try {
    const fh = await open(filePath, "r");
    const st = await fh.stat();
    statSize = st.size;
    await fh.close();
  } catch {
    return { events: [], oldestSeq: 0, newestSeq: 0, hasOlder: false };
  }

  if (statSize === 0 || beforeSeq <= 1) {
    return { events: [], oldestSeq: 0, newestSeq: 0, hasOlder: false };
  }

  if (statSize <= EVENT_LOG_FULL_READ_MAX_BYTES) {
    const fh = await open(filePath, "r");
    const raw = Buffer.alloc(statSize);
    await fh.read(raw, 0, statSize, 0);
    await fh.close();
    const lines = raw
      .toString("utf8")
      .split(/\r?\n/)
      .map((l) => l.trim())
      .filter(Boolean);
    const ordered = sortEventsBySeq(
      lines.map(parseEventLine).filter((e): e is AgentStoredEvent => e != null)
    );
    const prefix = ordered.filter((e) => e.seq < beforeSeq);
    if (countUserMessageEvents(prefix) < PAGINATION_MIN_USER_TURNS) {
      const full = trimToTurnStart(prefix);
      return {
        events: full,
        oldestSeq: full[0]?.seq ?? 0,
        newestSeq: full[full.length - 1]?.seq ?? 0,
        hasOlder: false,
      };
    }
    const slice = takeLastTurnWindow(prefix, limitTurns, limitEvents);
    const oldestSeq = slice[0]?.seq ?? 0;
    const newestSeq = slice[slice.length - 1]?.seq ?? 0;
    const minSeq = prefix[0]?.seq ?? 0;
    return {
      events: slice,
      oldestSeq,
      newestSeq,
      hasOlder: prefix.length > 0 && oldestSeq > minSeq,
    };
  }

  const stream = createReadStream(filePath, { encoding: "utf8" });
  const rl = createInterface({ input: stream, crlfDelay: Infinity });

  const acc: AgentStoredEvent[] = [];
  let globalMin = Number.MAX_SAFE_INTEGER;
  let trimmedRolling = false;
  let linesSinceYield = 0;

  for await (const line of rl) {
    linesSinceYield += 1;
    if (linesSinceYield >= HISTORY_STREAM_YIELD_EVERY_LINES) {
      linesSinceYield = 0;
      await new Promise<void>((resolve) => setImmediate(resolve));
    }
    const ev = parseEventLine(line);
    if (!ev) {
      continue;
    }
    if (ev.seq >= beforeSeq) {
      continue;
    }
    globalMin = Math.min(globalMin, ev.seq);
    acc.push(ev);
    while (acc.length > rollingCap) {
      acc.shift();
      trimmedRolling = true;
    }
  }

  if (!trimmedRolling && countUserMessageEvents(acc) < PAGINATION_MIN_USER_TURNS) {
    const full = trimToTurnStart(sortEventsBySeq(acc));
    return {
      events: full,
      oldestSeq: full[0]?.seq ?? 0,
      newestSeq: full[full.length - 1]?.seq ?? 0,
      hasOlder: false,
    };
  }

  const slice = takeLastTurnWindow(acc, limitTurns, limitEvents);
  const oldestSeq = slice[0]?.seq ?? 0;
  const newestSeq = slice[slice.length - 1]?.seq ?? 0;
  const hasOlder =
    slice.length > 0 && (trimmedRolling || oldestSeq > globalMin);
  return {
    events: slice,
    oldestSeq,
    newestSeq,
    hasOlder,
  };
}

/**
 * Events with seq > since — optimized tail read when `since` is near the end of the log.
 */
export async function readConversationEventsSinceEfficient(
  filePath: string,
  since: number
): Promise<AgentStoredEvent[]> {
  if (since <= 0) {
    return readAllEventsFromFile(filePath);
  }

  let fh;
  try {
    fh = await open(filePath, "r");
  } catch {
    return [];
  }

  try {
    const stat = await fh.stat();
    const fileSize = stat.size;
    if (fileSize === 0) {
      return [];
    }

    if (fileSize <= EVENT_LOG_FULL_READ_MAX_BYTES) {
      const raw = Buffer.alloc(fileSize);
      await fh.read(raw, 0, fileSize, 0);
      return sortEventsBySeq(
        raw
          .toString("utf8")
          .split(/\r?\n/)
          .map((l) => l.trim())
          .filter(Boolean)
          .map(parseEventLine)
          .filter((e): e is AgentStoredEvent => e != null)
      ).filter((e) => e.seq > since);
    }

    let bytesFromEnd = 0;
    let chunkSize = TAIL_INITIAL_CHUNK_BYTES;
    const lineBuf: string[] = [];

    while (bytesFromEnd < fileSize) {
      const readLen = Math.min(chunkSize, fileSize - bytesFromEnd);
      const start = fileSize - bytesFromEnd - readLen;
      const buf = Buffer.alloc(readLen);
      await fh.read(buf, 0, readLen, start);
      let text = buf.toString("utf8");
      if (start > 0) {
        const nl = text.indexOf("\n");
        if (nl === -1) {
          bytesFromEnd += readLen;
          chunkSize = Math.min(chunkSize * 2, TAIL_MAX_CHUNK_BYTES);
          continue;
        }
        text = text.slice(nl + 1);
      }
      const newLines = text
        .split(/\r?\n/)
        .map((l) => l.trim())
        .filter(Boolean);
      lineBuf.splice(0, 0, ...newLines);
      bytesFromEnd += readLen;

      const ordered = sortEventsBySeq(
        lineBuf.map(parseEventLine).filter((e): e is AgentStoredEvent => e != null)
      );
      if (ordered.length === 0) {
        if (bytesFromEnd >= fileSize) {
          break;
        }
        chunkSize = Math.min(chunkSize * 2, TAIL_MAX_CHUNK_BYTES);
        continue;
      }
      if (ordered[0]!.seq <= since) {
        return ordered.filter((e) => e.seq > since);
      }
      if (bytesFromEnd >= fileSize) {
        return ordered.filter((e) => e.seq > since);
      }
      chunkSize = Math.min(chunkSize * 2, TAIL_MAX_CHUNK_BYTES);
    }

    return sortEventsBySeq(
      lineBuf.map(parseEventLine).filter((e): e is AgentStoredEvent => e != null)
    ).filter((e) => e.seq > since);
  } finally {
    await fh.close();
  }
}

async function readAllEventsFromFile(filePath: string): Promise<AgentStoredEvent[]> {
  let fh;
  try {
    fh = await open(filePath, "r");
  } catch {
    return [];
  }
  try {
    const stat = await fh.stat();
    if (stat.size === 0) {
      return [];
    }
    const raw = Buffer.alloc(stat.size);
    await fh.read(raw, 0, stat.size, 0);
    return sortEventsBySeq(
      raw
        .toString("utf8")
        .split(/\r?\n/)
        .map((l) => l.trim())
        .filter(Boolean)
        .map(parseEventLine)
        .filter((e): e is AgentStoredEvent => e != null)
    );
  } finally {
    await fh.close();
  }
}

function formatToolCallForTranscript(event: Extract<AgentStoredEvent, { kind: "tool_call" }>): string {
  let result = `[Tool: ${event.title}]`;
  if (event.detail) {
    result += ` - ${event.detail.trim()}`;
  }
  return result;
}

function formatToolUpdateForTranscript(event: Extract<AgentStoredEvent, { kind: "tool_call_update" }>): string {
  let result = `[Tool Update: ${(event.title ?? "tool").trim()}]`;
  if (event.detail) {
    result += ` - ${event.detail.trim()}`;
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

      case "system_reminder":
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
            const status =
              entry.status === "completed"
                ? "[x]"
                : entry.status === "blocked"
                  ? "[!]"
                  : "[ ]";
            lines.push(` ${status} ${entry.content.trim()}`);
          }
        }
        break;

      case "plan_file":
        flushUser();
        lines.push(`[Plan file: ${event.path}]`);
        break;

      case "subagent":
        flushUser();
        flushAssistant();
        lines.push(
          `[Subagent ${event.status}: ${event.title}]${event.recentActivity ? ` ${event.recentActivity}` : ""}`
        );
        break;

      case "question":
        flushUser();
        flushAssistant();
        lines.push(`[Question ${event.status}: ${event.prompt.trim()}]`);
        break;

      case "compression_summary":
        flushUser();
        flushAssistant();
        lines.push(`[Compressed conversation summary]\n${event.summary.trim()}`);
        break;

  case "permission_request":
      flushUser();
      lines.push(`[Permission Required: ${(event.title ?? "permission").trim()}]`);
      if (event.detail) {
        lines.push(` ${event.detail.trim()}`);
      }
      break;

    case "permission_resolved":
      flushUser();
      lines.push(`[Permission ${event.outcome}]`);
      break;

    case "system":
      flushUser();
      lines.push(`[System: ${event.text.trim()}]`);
      break;

    case "status":
      flushUser();
      if (event.status === "failed") {
        lines.push(`[Status: Failed]${event.detail ? ` - ${event.detail.trim()}` : ""}`);
      } else if (event.status === "cancelled") {
        lines.push("[Status: Cancelled]");
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
