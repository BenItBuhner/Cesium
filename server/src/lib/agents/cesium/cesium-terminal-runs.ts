import { spawn } from "node:child_process";
import { promises as fs, openSync, readFileSync } from "node:fs";
import path from "node:path";
import { StringDecoder } from "node:string_decoder";
import { DATA_DIR, readJsonFile, writeJsonFile } from "../../persistence.js";
import { truncationMarker } from "./cesium-coerce.js";

/**
 * Terminal runs outlive a single `terminal` call: the command writes straight
 * into a log file under the data dir and its pid, command and cwd are kept in
 * a JSON record, so `terminal_read` / `terminal_kill` still work on a run
 * after the call timed out, after it finished, and after a server restart.
 */
export type TerminalRunRecord = {
  schemaVersion: 1;
  id: string;
  conversationId: string;
  command: string;
  cwd: string;
  pid: number | null;
  /** Linux /proc starttime of `pid`, so a recycled pid is not mistaken for the run. */
  pidStartTime: string | null;
  startedAt: number;
  completedAt?: number;
  exitCode?: number | null;
  signal?: string | null;
  logFile: string;
  /** Set once the log has been compacted; maps output offsets onto the shorter file. */
  logLayout?: TerminalLogLayout;
};

/**
 * Where the elided middle of a compacted log sits. The file holds the first
 * `headBytes` of output, a `markerBytes` truncation marker, then the newest
 * output; `droppedBytes` of output were removed between them.
 */
export type TerminalLogLayout = {
  headBytes: number;
  markerBytes: number;
  droppedBytes: number;
};

export const TERMINAL_KILL_GRACE_MS = 3_000;
/** Finished runs (and their logs) older than this are pruned when a new run starts. */
export const TERMINAL_RUN_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;
/** A run's log is compacted to about this size, keeping its head and its newest output. */
export const TERMINAL_RUN_LOG_MAX_BYTES = 2 * 1024 * 1024;
/** How often a live run's log is checked against the cap. */
export const TERMINAL_RUN_LOG_COMPACT_INTERVAL_MS = 5_000;

export function terminalRunLogMaxBytes(): number {
  const configured = Number(process.env.CESIUM_TERMINAL_LOG_MAX_BYTES);
  return Number.isFinite(configured) && configured > 0 ? Math.floor(configured) : TERMINAL_RUN_LOG_MAX_BYTES;
}

/** Output offset -> file offset. Offsets inside the dropped middle land on the marker. */
export function terminalLogFileOffset(offset: number, layout: TerminalLogLayout | undefined): number {
  if (!layout || offset <= layout.headBytes) {
    return offset;
  }
  if (offset < layout.headBytes + layout.droppedBytes) {
    return layout.headBytes;
  }
  return offset - layout.droppedBytes + layout.markerBytes;
}

/** File offset -> output offset. Offsets inside the marker map to just past the dropped middle. */
export function terminalLogOutputOffset(fileOffset: number, layout: TerminalLogLayout | undefined): number {
  if (!layout || fileOffset <= layout.headBytes) {
    return fileOffset;
  }
  if (fileOffset < layout.headBytes + layout.markerBytes) {
    return layout.headBytes + layout.droppedBytes;
  }
  return fileOffset - layout.markerBytes + layout.droppedBytes;
}

/**
 * Shrinks a log past `maxBytes` in place to its head, a truncation marker and
 * its newest output, the same shape as the bounded terminal output. The
 * command keeps an append-mode descriptor, so its later writes still land at
 * the new end; bytes it writes between the final size check and the truncate
 * are lost, which in practice is a microsecond window. Returns the new layout
 * (the given one when nothing changed).
 */
export async function compactTerminalRunLog(
  logFile: string,
  layout: TerminalLogLayout | undefined,
  maxBytes: number = terminalRunLogMaxBytes()
): Promise<TerminalLogLayout | undefined> {
  const handle = await fs.open(logFile, "r+").catch(() => null);
  if (!handle) {
    return layout;
  }
  try {
    let size = (await handle.stat()).size;
    if (size <= maxBytes) {
      return layout;
    }
    const headBytes = layout?.headBytes ?? Math.floor(maxBytes / 2);
    const tailStart = headBytes + (layout?.markerBytes ?? 0);
    const tailKeep = Math.max(0, maxBytes - headBytes - 80);
    let cut = Math.max(tailStart, size - tailKeep);
    let tail = Buffer.alloc(size - cut);
    await handle.read(tail, 0, tail.length, cut);
    const newline = tail.indexOf(0x0a);
    if (newline >= 0 && newline < 1024 && newline < tail.length - 1) {
      tail = tail.subarray(newline + 1);
      cut += newline + 1;
    }
    const appendedSince = (await handle.stat()).size;
    if (appendedSince > size) {
      const extra = Buffer.alloc(appendedSince - size);
      await handle.read(extra, 0, extra.length, size);
      tail = Buffer.concat([tail, extra]);
      size = appendedSince;
    }
    const droppedBytes = (layout?.droppedBytes ?? 0) + (cut - tailStart);
    const marker = Buffer.from(truncationMarker(droppedBytes), "utf8");
    const body = Buffer.concat([marker, tail]);
    await handle.write(body, 0, body.length, headBytes);
    await handle.truncate(headBytes + body.length);
    return { headBytes, markerBytes: marker.length, droppedBytes };
  } finally {
    await handle.close();
  }
}

const RUN_ID_PATTERN = /^[A-Za-z0-9-]{1,64}$/;

export function isValidTerminalRunId(id: string): boolean {
  return RUN_ID_PATTERN.test(id);
}

export function terminalRunsDir(workspaceId: string): string {
  return path.join(DATA_DIR, "workspaces", workspaceId, "terminal-runs");
}

function recordPath(workspaceId: string, id: string): string {
  return path.join(terminalRunsDir(workspaceId), `${id}.json`);
}

/** Creates the run's log file and returns an append-mode fd for the child's stdout/stderr. */
export async function openTerminalRunLog(
  workspaceId: string,
  id: string
): Promise<{ logFile: string; fd: number }> {
  const dir = terminalRunsDir(workspaceId);
  await fs.mkdir(dir, { recursive: true });
  const logFile = path.join(dir, `${id}.log`);
  return { logFile, fd: openSync(logFile, "a") };
}

export async function writeTerminalRunRecord(
  workspaceId: string,
  record: TerminalRunRecord
): Promise<void> {
  await writeJsonFile(recordPath(workspaceId, record.id), record);
}

export async function readTerminalRunRecord(
  workspaceId: string,
  id: string
): Promise<TerminalRunRecord | null> {
  if (!isValidTerminalRunId(id)) {
    return null;
  }
  const raw = await readJsonFile<TerminalRunRecord | null>(recordPath(workspaceId, id), null);
  return raw && raw.id === id && typeof raw.logFile === "string" ? raw : null;
}

/** Best effort: drops finished (or dead) runs older than the retention window. */
export async function pruneTerminalRuns(workspaceId: string, now = Date.now()): Promise<void> {
  const dir = terminalRunsDir(workspaceId);
  const names = await fs.readdir(dir).catch(() => [] as string[]);
  for (const name of names) {
    if (!name.endsWith(".json")) continue;
    const id = name.slice(0, -".json".length);
    const record = await readTerminalRunRecord(workspaceId, id);
    if (!record) continue;
    const endedAt = record.completedAt ?? (isTerminalRunAlive(record) ? null : record.startedAt);
    if (endedAt == null || now - endedAt < TERMINAL_RUN_RETENTION_MS) continue;
    await fs.rm(record.logFile, { force: true }).catch(() => undefined);
    await fs.rm(path.join(dir, name), { force: true }).catch(() => undefined);
  }
}

/** Field 22 of /proc/<pid>/stat; null off Linux or when the pid is gone. */
export function readProcessStartTime(pid: number): string | null {
  if (process.platform !== "linux") {
    return null;
  }
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
    // The command name (field 2) may contain spaces and parentheses.
    const fields = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
    return fields[19] ?? null;
  } catch {
    return null;
  }
}

function signalAlive(target: number): boolean {
  try {
    process.kill(target, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException)?.code === "EPERM";
  }
}

/** True while the run's shell (or, on POSIX, anything left in its process group) is alive. */
export function isTerminalRunAlive(record: Pick<TerminalRunRecord, "pid" | "pidStartTime">): boolean {
  const pid = record.pid;
  if (!pid || pid <= 0) {
    return false;
  }
  if (process.platform !== "win32" && signalAlive(-pid)) {
    return true;
  }
  if (!signalAlive(pid)) {
    return false;
  }
  if (record.pidStartTime) {
    return readProcessStartTime(pid) === record.pidStartTime;
  }
  return true;
}

/**
 * Terminates the run's whole process tree: SIGTERM to the process group (the
 * run is spawned detached, so its pid is the group id), then SIGKILL once the
 * grace period passes. Killing only the pid would leave `sh -c` children such
 * as `npm run dev` running. Resolves once the group is gone or SIGKILL is sent.
 */
export async function killTerminalProcessTree(
  pid: number,
  graceMs: number = TERMINAL_KILL_GRACE_MS
): Promise<void> {
  if (process.platform === "win32") {
    await new Promise<void>((resolve) => {
      const killer = spawn("taskkill", ["/pid", String(pid), "/T", "/F"], {
        windowsHide: true,
        stdio: "ignore",
      });
      killer.on("exit", () => resolve());
      killer.on("error", () => {
        try {
          process.kill(pid);
        } catch {
          // Already gone.
        }
        resolve();
      });
    });
    return;
  }
  const send = (signal: NodeJS.Signals): boolean => {
    try {
      process.kill(-pid, signal);
      return true;
    } catch {
      try {
        process.kill(pid, signal);
        return true;
      } catch {
        return false;
      }
    }
  };
  if (!send("SIGTERM")) {
    return;
  }
  const deadline = Date.now() + Math.max(0, graceMs);
  while (Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 100));
    if (!signalAlive(-pid) && !signalAlive(pid)) {
      return;
    }
  }
  send("SIGKILL");
}

export type TerminalLogSlice = {
  text: string;
  /** Byte offset the slice starts at (the clamped `since`). */
  start: number;
  /** Byte length of the log when read; pass it as the next `since`. */
  end: number;
  omittedBytes: number;
};

/**
 * Reads log bytes from `since` to the current end. A range larger than `cap`
 * keeps its head and tail around the same marker `BoundedTerminalOutput` uses,
 * so the latest lines (errors, "ready" banners) are never cut.
 */
export async function readTerminalLogSlice(
  logFile: string,
  since: number,
  cap: number,
  layout?: TerminalLogLayout
): Promise<TerminalLogSlice> {
  const handle = await fs.open(logFile, "r").catch(() => null);
  if (!handle) {
    return { text: "", start: 0, end: 0, omittedBytes: 0 };
  }
  try {
    const size = (await handle.stat()).size;
    const start = Math.max(0, Math.min(size, terminalLogFileOffset(Math.floor(since), layout)));
    const length = size - start;
    const startOffset = terminalLogOutputOffset(start, layout);
    const endOffset = terminalLogOutputOffset(size, layout);
    const read = async (position: number, bytes: number): Promise<string> => {
      const buffer = Buffer.alloc(bytes);
      const { bytesRead } = await handle.read(buffer, 0, bytes, position);
      return buffer.subarray(0, bytesRead).toString("utf8");
    };
    if (length <= cap) {
      return { text: await read(start, length), start: startOffset, end: endOffset, omittedBytes: 0 };
    }
    const headBytes = Math.ceil(cap / 2);
    const tailBytes = cap - headBytes;
    const omittedBytes = length - headBytes - tailBytes;
    const head = await read(start, headBytes);
    const tail = await read(size - tailBytes, tailBytes);
    return {
      text: `${head}${truncationMarker(omittedBytes)}${tail}`,
      start: startOffset,
      end: endOffset,
      omittedBytes,
    };
  } finally {
    await handle.close();
  }
}

/** Incremental reader over a growing log: each `drain()` returns bytes appended since the last one. */
export class TerminalLogFollower {
  private offset = 0;
  private layout: TerminalLogLayout | undefined;
  private draining: Promise<string> | null = null;
  private decoder = new StringDecoder("utf8");

  constructor(private readonly logFile: string) {}

  /** Output offset read so far (what `terminal_read` takes as `since`). */
  get bytesRead(): number {
    return terminalLogOutputOffset(this.offset, this.layout);
  }

  /** Follows the log across a compaction; unread output that was dropped comes back as the marker. */
  relayout(layout: TerminalLogLayout | undefined): void {
    this.offset = terminalLogFileOffset(terminalLogOutputOffset(this.offset, this.layout), layout);
    this.layout = layout;
    this.decoder = new StringDecoder("utf8");
  }

  drain(): Promise<string> {
    this.draining ??= this.readNew().finally(() => {
      this.draining = null;
    });
    return this.draining;
  }

  private async readNew(): Promise<string> {
    const handle = await fs.open(this.logFile, "r").catch(() => null);
    if (!handle) {
      return "";
    }
    try {
      const size = (await handle.stat()).size;
      if (size <= this.offset) {
        return "";
      }
      const buffer = Buffer.alloc(size - this.offset);
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, this.offset);
      this.offset += bytesRead;
      return this.decoder.write(buffer.subarray(0, bytesRead));
    } finally {
      await handle.close();
    }
  }
}
