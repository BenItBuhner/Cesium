import { createReadStream } from "node:fs";
import { open } from "node:fs/promises";
import { createInterface } from "node:readline";
import type { AgentStoredEvent } from "./types.js";

export const DEFAULT_PAGE_TURNS = 25;
export const DEFAULT_PAGE_EVENTS_CAP = 400;
export const TAIL_INITIAL_CHUNK_BYTES = 256 * 1024;
export const TAIL_MAX_CHUNK_BYTES = 8 * 1024 * 1024;
/** Beyond this, full read is avoided; tail uses expanding chunks and history uses streaming + trim. */
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
      const slice = takeLastTurnWindow(ordered, limitTurns, limitEvents);
      const minSeqInBuffer = ordered[0]?.seq ?? 0;
      const oldestInSlice = slice[0]?.seq ?? 0;
      const usersInSlice = slice.filter((e) => e.kind === "user_message").length;
      const haveWholeFile = bytesFromEnd >= fileSize;
      if (haveWholeFile) {
        scannedEntireFile = true;
      }

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

  let acc: AgentStoredEvent[] = [];
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
