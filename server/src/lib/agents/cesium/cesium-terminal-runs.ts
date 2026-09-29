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
};

export const TERMINAL_KILL_GRACE_MS = 3_000;
/** Finished runs (and their logs) older than this are pruned when a new run starts. */
export const TERMINAL_RUN_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;

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
  cap: number
): Promise<TerminalLogSlice> {
  const handle = await fs.open(logFile, "r").catch(() => null);
  if (!handle) {
    return { text: "", start: 0, end: 0, omittedBytes: 0 };
  }
  try {
    const size = (await handle.stat()).size;
    const start = Math.max(0, Math.min(size, Math.floor(since)));
    const length = size - start;
    const read = async (position: number, bytes: number): Promise<string> => {
      const buffer = Buffer.alloc(bytes);
      const { bytesRead } = await handle.read(buffer, 0, bytes, position);
      return buffer.subarray(0, bytesRead).toString("utf8");
    };
    if (length <= cap) {
      return { text: await read(start, length), start, end: size, omittedBytes: 0 };
    }
    const headBytes = Math.ceil(cap / 2);
    const tailBytes = cap - headBytes;
    const omittedBytes = length - headBytes - tailBytes;
    const head = await read(start, headBytes);
    const tail = await read(size - tailBytes, tailBytes);
    return {
      text: `${head}${truncationMarker(omittedBytes)}${tail}`,
      start,
      end: size,
      omittedBytes,
    };
  } finally {
    await handle.close();
  }
}

/** Incremental reader over a growing log: each `drain()` returns bytes appended since the last one. */
export class TerminalLogFollower {
  private offset = 0;
  private draining: Promise<string> | null = null;
  private readonly decoder = new StringDecoder("utf8");

  constructor(private readonly logFile: string) {}

  get bytesRead(): number {
    return this.offset;
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
