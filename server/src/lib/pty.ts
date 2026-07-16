/**
 * Runtime-agnostic PTY spawn.
 *
 * Under Bun on POSIX we use Bun.Terminal (native PTY). node-pty's onData
 * callback does not fire under Bun because Bun's tty.ReadStream mishandles
 * non-blocking PTY master fds (EAGAIN destroys the stream).
 *
 * Under Node (and Bun on Windows, where Bun.Terminal is unavailable) we fall
 * back to node-pty.
 */

import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

export type PtySpawnOptions = {
  file: string;
  args?: string[];
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  cols?: number;
  rows?: number;
  name?: string;
};

export type PtyExitEvent = {
  exitCode: number;
  /**
   * Present on the node-pty backend when the process died from a signal.
   * Bun.Terminal only exposes a numeric exit code via `subprocess.exited`, so
   * this stays undefined on the bun-terminal backend today.
   */
  signal?: number;
};

export type PtyDisposable = {
  dispose(): void;
};

export type PtyProcess = {
  readonly pid: number;
  readonly backend: "bun-terminal" | "node-pty";
  write(data: string): void;
  resize(cols: number, rows: number): void;
  kill(signal?: string): void;
  onData(listener: (data: string) => void): PtyDisposable;
  onExit(listener: (event: PtyExitEvent) => void): PtyDisposable;
};

type BunTerminalLike = {
  write(data: string | ArrayBufferView): number | Promise<number> | void;
  resize(cols: number, rows: number): void;
  close(): void;
  readonly closed?: boolean;
};

type BunSubprocessLike = {
  readonly pid: number;
  readonly terminal: BunTerminalLike | undefined;
  readonly exited: Promise<number>;
  kill(signal?: number | string): void;
};

type BunRuntimeLike = {
  spawn: (
    cmd: string[],
    options: {
      cwd?: string;
      env?: NodeJS.ProcessEnv;
      terminal?: {
        cols?: number;
        rows?: number;
        data?: (terminal: BunTerminalLike, data: Uint8Array | Buffer | string) => void;
      };
    }
  ) => BunSubprocessLike;
};

type NodePtyProcess = {
  pid: number;
  write(data: string): void;
  resize(cols: number, rows: number): void;
  kill(signal?: string): void;
  onData(listener: (data: string) => void): { dispose(): void };
  onExit(listener: (event: PtyExitEvent) => void): { dispose(): void };
};

type NodePtyModule = {
  spawn(
    file: string,
    args: string[],
    options: {
      name?: string;
      cols?: number;
      rows?: number;
      cwd?: string;
      env?: NodeJS.ProcessEnv;
    }
  ): NodePtyProcess;
};

function getBunRuntime(): BunRuntimeLike | undefined {
  return (globalThis as typeof globalThis & { Bun?: BunRuntimeLike }).Bun;
}

export function canUseBunTerminal(): boolean {
  if (process.platform === "win32") {
    return false;
  }
  if (!process.versions.bun) {
    return false;
  }
  const bun = getBunRuntime();
  return Boolean(bun && typeof bun.spawn === "function");
}

export function getPtyBackendName(): "bun-terminal" | "node-pty" {
  return canUseBunTerminal() ? "bun-terminal" : "node-pty";
}

function toUtf8(data: Uint8Array | Buffer | string): string {
  if (typeof data === "string") {
    return data;
  }
  return Buffer.from(data).toString("utf8");
}

function addListener<T>(listeners: Set<T>, listener: T): PtyDisposable {
  listeners.add(listener);
  return {
    dispose() {
      listeners.delete(listener);
    },
  };
}

function spawnBunPty(options: PtySpawnOptions): PtyProcess {
  const bun = getBunRuntime();
  if (!bun) {
    throw new Error("Bun runtime is required for Bun.Terminal PTY.");
  }

  const dataListeners = new Set<(data: string) => void>();
  const exitListeners = new Set<(event: PtyExitEvent) => void>();
  let exited = false;
  let exitEvent: PtyExitEvent | null = null;
  let closed = false;

  const cols = options.cols ?? 80;
  const rows = options.rows ?? 24;
  const env = {
    ...(options.env ?? process.env),
    TERM: options.name ?? options.env?.TERM ?? process.env.TERM ?? "xterm-256color",
  };

  const proc = bun.spawn([options.file, ...(options.args ?? [])], {
    cwd: options.cwd,
    env,
    terminal: {
      cols,
      rows,
      data(_terminal, data) {
        const text = toUtf8(data);
        if (!text) return;
        for (const listener of dataListeners) {
          listener(text);
        }
      },
    },
  });

  const terminal = proc.terminal;
  if (!terminal) {
    try {
      proc.kill();
    } catch {
      // ignore
    }
    throw new Error("Bun.spawn did not attach a terminal PTY.");
  }

  void proc.exited.then((exitCode) => {
    exited = true;
    // Bun reports only the exit code here; signal is unavailable on this backend.
    exitEvent = { exitCode };
    for (const listener of exitListeners) {
      listener(exitEvent);
    }
    if (!closed) {
      closed = true;
      try {
        terminal.close();
      } catch {
        // ignore
      }
    }
  });

  return {
    pid: proc.pid,
    backend: "bun-terminal",
    write(data: string) {
      if (closed || terminal.closed) return;
      terminal.write(data);
    },
    resize(nextCols: number, nextRows: number) {
      if (closed || terminal.closed) return;
      terminal.resize(nextCols, nextRows);
    },
    kill(signal = "SIGTERM") {
      try {
        proc.kill(signal);
      } catch {
        // Process may already be gone.
      }
      if (!closed) {
        closed = true;
        try {
          terminal.close();
        } catch {
          // ignore
        }
      }
    },
    onData(listener) {
      return addListener(dataListeners, listener);
    },
    onExit(listener) {
      if (exited && exitEvent) {
        queueMicrotask(() => listener(exitEvent!));
        return { dispose() {} };
      }
      return addListener(exitListeners, listener);
    },
  };
}

function resolveNodePtyModule(): NodePtyModule {
  const requireFromHere = createRequire(fileURLToPath(import.meta.url));
  let mod: NodePtyModule & { default?: NodePtyModule };
  try {
    mod = requireFromHere("node-pty") as NodePtyModule & { default?: NodePtyModule };
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(
      "node-pty is unavailable. Integrated terminals need Bun.Terminal (Bun on POSIX) " +
        "or a working node-pty native build. On Termux/Android, node-pty cannot build " +
        `(missing Android NDK); the rest of the server still runs. (${detail})`
    );
  }
  const pty = mod.default ?? mod;
  if (!pty || typeof pty.spawn !== "function") {
    throw new Error("node-pty.spawn is unavailable");
  }
  return pty;
}

function spawnNodePty(options: PtySpawnOptions): PtyProcess {
  const pty = resolveNodePtyModule();
  const proc = pty.spawn(options.file, options.args ?? [], {
    name: options.name ?? "xterm-256color",
    cols: options.cols ?? 80,
    rows: options.rows ?? 24,
    cwd: options.cwd,
    env: options.env ?? process.env,
  });

  return {
    pid: proc.pid,
    backend: "node-pty",
    write: (data) => proc.write(data),
    resize: (cols, rows) => proc.resize(cols, rows),
    kill: (signal) => proc.kill(signal),
    onData: (listener) => proc.onData(listener),
    onExit: (listener) => proc.onExit(listener),
  };
}

export function spawnPty(options: PtySpawnOptions): PtyProcess {
  if (canUseBunTerminal()) {
    return spawnBunPty(options);
  }
  return spawnNodePty(options);
}
