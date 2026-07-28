import { promises as fs } from "node:fs";
import path from "node:path";
import { DATA_DIR } from "../persistence.js";

/**
 * Structured diagnostics for agent harness pipelines (OpenCode, Codex, Claude, ...).
 *
 * Every notable lifecycle step (spawn, SSE reconnect, permission round-trip,
 * watchdog reconcile, process exit, ...) is recorded as one entry that is kept
 * in an in-memory ring buffer for fast reads and appended to a size-rotated
 * JSONL file under `{DATA_DIR}/logs/harness/` for retention across restarts.
 */

export type HarnessDiagnosticLevel = "debug" | "info" | "warning" | "error";

export type HarnessDiagnosticEntry = {
  seq: number;
  at: number;
  level: HarnessDiagnosticLevel;
  event: string;
  backendId?: string;
  conversationId?: string;
  detail?: string;
  data?: Record<string, unknown>;
};

export type HarnessDiagnosticInput = {
  level?: HarnessDiagnosticLevel;
  event: string;
  backendId?: string;
  conversationId?: string;
  detail?: string;
  data?: Record<string, unknown>;
};

const LEVEL_ORDER: Record<HarnessDiagnosticLevel, number> = {
  debug: 0,
  info: 1,
  warning: 2,
  error: 3,
};

const RING_BUFFER_CAPACITY = 4_000;
const DEFAULT_READ_LIMIT = 200;
const MAX_READ_LIMIT = 2_000;
const FILE_TAIL_READ_BYTES = 2 * 1024 * 1024;
const FLUSH_DELAY_MS = 40;

function maxLogFileBytes(): number {
  const raw = Number.parseInt(process.env.OPENCURSOR_HARNESS_LOG_MAX_BYTES ?? "", 10);
  return Number.isFinite(raw) && raw > 4_096 ? raw : 4 * 1024 * 1024;
}

function fileLoggingEnabled(): boolean {
  return process.env.OPENCURSOR_HARNESS_DIAGNOSTICS !== "0";
}

export function harnessDiagnosticsDir(): string {
  return path.join(DATA_DIR, "logs", "harness");
}

export function harnessDiagnosticsFilePaths(): { current: string; rotated: string } {
  const dir = harnessDiagnosticsDir();
  return {
    current: path.join(dir, "harness.jsonl"),
    rotated: path.join(dir, "harness.1.jsonl"),
  };
}

let nextSeq = 1;
const ringBuffer: HarnessDiagnosticEntry[] = [];
const pendingWrites: HarnessDiagnosticEntry[] = [];
let flushTimer: ReturnType<typeof setTimeout> | null = null;
let flushChain: Promise<void> = Promise.resolve();

function truncateText(value: string, max: number): string {
  return value.length > max ? `${value.slice(0, max - 1)}…` : value;
}

function sanitizeData(data: Record<string, unknown> | undefined): Record<string, unknown> | undefined {
  if (!data) {
    return undefined;
  }
  try {
    const raw = JSON.stringify(data);
    if (raw.length <= 4_000) {
      return data;
    }
    return { truncated: truncateText(raw, 4_000) };
  } catch {
    return { unserializable: true };
  }
}

async function flushPendingToFile(): Promise<void> {
  if (!fileLoggingEnabled() || pendingWrites.length === 0) {
    pendingWrites.length = 0;
    return;
  }
  const batch = pendingWrites.splice(0, pendingWrites.length);
  const lines = `${batch.map((entry) => JSON.stringify(entry)).join("\n")}\n`;
  const { current, rotated } = harnessDiagnosticsFilePaths();
  try {
    await fs.mkdir(harnessDiagnosticsDir(), { recursive: true });
    const stat = await fs.stat(current).catch(() => null);
    if (stat && stat.size >= maxLogFileBytes()) {
      await fs.rm(rotated, { force: true }).catch(() => undefined);
      await fs.rename(current, rotated).catch(() => undefined);
    }
    await fs.appendFile(current, lines, "utf8");
  } catch (error) {
    console.warn(
      "[harness-diagnostics] failed to persist entries:",
      error instanceof Error ? error.message : error
    );
  }
}

function scheduleFlush(): void {
  if (flushTimer) {
    return;
  }
  flushTimer = setTimeout(() => {
    flushTimer = null;
    flushChain = flushChain.catch(() => undefined).then(flushPendingToFile);
  }, FLUSH_DELAY_MS);
  if (typeof flushTimer.unref === "function") {
    flushTimer.unref();
  }
}

/** Waits until every entry logged so far has been appended to the JSONL file. */
export async function flushHarnessDiagnostics(): Promise<void> {
  if (flushTimer) {
    clearTimeout(flushTimer);
    flushTimer = null;
  }
  flushChain = flushChain.catch(() => undefined).then(flushPendingToFile);
  await flushChain;
}

export function harnessLog(input: HarnessDiagnosticInput): HarnessDiagnosticEntry {
  const data = sanitizeData(input.data);
  const entry: HarnessDiagnosticEntry = {
    seq: nextSeq++,
    at: Date.now(),
    level: input.level ?? "info",
    event: input.event,
    ...(input.backendId ? { backendId: input.backendId } : {}),
    ...(input.conversationId ? { conversationId: input.conversationId } : {}),
    ...(input.detail ? { detail: truncateText(input.detail, 2_000) } : {}),
    ...(data ? { data } : {}),
  };
  ringBuffer.push(entry);
  if (ringBuffer.length > RING_BUFFER_CAPACITY) {
    ringBuffer.splice(0, ringBuffer.length - RING_BUFFER_CAPACITY);
  }
  pendingWrites.push(entry);
  scheduleFlush();
  if (entry.level === "error" || entry.level === "warning") {
    const scope = [entry.backendId, entry.conversationId].filter(Boolean).join(" ");
    const line = `[harness${scope ? ` ${scope}` : ""}] ${entry.event}${entry.detail ? `: ${entry.detail}` : ""}`;
    if (entry.level === "error") {
      console.error(line);
    } else {
      console.warn(line);
    }
  }
  return entry;
}

export type HarnessLogger = {
  debug: (event: string, detail?: string, data?: Record<string, unknown>) => void;
  info: (event: string, detail?: string, data?: Record<string, unknown>) => void;
  warning: (event: string, detail?: string, data?: Record<string, unknown>) => void;
  error: (event: string, detail?: string, data?: Record<string, unknown>) => void;
};

export function createHarnessLogger(context: {
  backendId?: string;
  conversationId?: string;
}): HarnessLogger {
  const emit =
    (level: HarnessDiagnosticLevel) =>
    (event: string, detail?: string, data?: Record<string, unknown>) => {
      harnessLog({ level, event, detail, data, ...context });
    };
  return {
    debug: emit("debug"),
    info: emit("info"),
    warning: emit("warning"),
    error: emit("error"),
  };
}

function parseJsonlEntries(raw: string): HarnessDiagnosticEntry[] {
  const entries: HarnessDiagnosticEntry[] = [];
  for (const line of raw.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) {
      continue;
    }
    try {
      const parsed = JSON.parse(trimmed) as HarnessDiagnosticEntry;
      if (parsed && typeof parsed === "object" && typeof parsed.event === "string") {
        entries.push(parsed);
      }
    } catch {
      // Partial line from a tail read or interrupted write.
    }
  }
  return entries;
}

async function readFileTail(filePath: string, maxBytes: number): Promise<string> {
  try {
    const stat = await fs.stat(filePath);
    if (stat.size <= maxBytes) {
      return await fs.readFile(filePath, "utf8");
    }
    const handle = await fs.open(filePath, "r");
    try {
      const buffer = Buffer.alloc(maxBytes);
      await handle.read(buffer, 0, maxBytes, stat.size - maxBytes);
      const text = buffer.toString("utf8");
      // Drop the (probably partial) first line of the tail window.
      const firstNewline = text.indexOf("\n");
      return firstNewline >= 0 ? text.slice(firstNewline + 1) : "";
    } finally {
      await handle.close();
    }
  } catch {
    return "";
  }
}

export type HarnessDiagnosticsReadOptions = {
  conversationId?: string;
  backendId?: string;
  /** Minimum level to include (defaults to `debug`, i.e. everything). */
  minLevel?: HarnessDiagnosticLevel;
  limit?: number;
  /** Only entries with `seq` strictly greater than this (for incremental polling). */
  afterSeq?: number;
};

export async function readHarnessDiagnostics(
  options: HarnessDiagnosticsReadOptions = {}
): Promise<HarnessDiagnosticEntry[]> {
  const limit = Math.max(1, Math.min(Math.floor(options.limit ?? DEFAULT_READ_LIMIT), MAX_READ_LIMIT));
  const minLevel = LEVEL_ORDER[options.minLevel ?? "debug"];

  const matches = (entry: HarnessDiagnosticEntry): boolean => {
    if (LEVEL_ORDER[entry.level] < minLevel) {
      return false;
    }
    if (options.conversationId && entry.conversationId !== options.conversationId) {
      return false;
    }
    if (options.backendId && entry.backendId !== options.backendId) {
      return false;
    }
    if (typeof options.afterSeq === "number" && entry.seq <= options.afterSeq) {
      return false;
    }
    return true;
  };

  const fromRing = ringBuffer.filter(matches);
  if (fromRing.length >= limit || !fileLoggingEnabled()) {
    return fromRing.slice(-limit);
  }

  // The ring buffer only covers the current process. Backfill older entries
  // from the persisted files (rotated first so ordering stays chronological).
  const { current, rotated } = harnessDiagnosticsFilePaths();
  const oldestRingSeq = ringBuffer[0]?.seq;
  const persisted: HarnessDiagnosticEntry[] = [];
  for (const filePath of [rotated, current]) {
    const raw = await readFileTail(filePath, FILE_TAIL_READ_BYTES);
    if (raw) {
      persisted.push(...parseJsonlEntries(raw));
    }
  }
  const backfill = persisted.filter(
    (entry) =>
      matches(entry) &&
      // Skip entries already covered by the ring buffer (same process run).
      !(typeof oldestRingSeq === "number" && entry.seq >= oldestRingSeq && entry.at >= (ringBuffer[0]?.at ?? 0))
  );
  const merged = [...backfill, ...fromRing];
  return merged.slice(-limit);
}

/** Test-only: reset in-memory state so suites can assert from a clean slate. */
export function resetHarnessDiagnosticsForTests(): void {
  ringBuffer.length = 0;
  pendingWrites.length = 0;
  nextSeq = 1;
  if (flushTimer) {
    clearTimeout(flushTimer);
    flushTimer = null;
  }
}
