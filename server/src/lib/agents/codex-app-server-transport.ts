import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createInterface } from "node:readline";
import { spawnSafeEnv } from "./spawn-env.js";

export type CodexAppServerJsonObject = Record<string, unknown>;

export type CodexAppServerRequestMessage = {
  id: number | string;
  method: string;
  params?: CodexAppServerJsonObject;
};

export type CodexAppServerTransportOptions = {
  command: string;
  args?: string[];
  cwd: string;
  env?: NodeJS.ProcessEnv;
  requestTimeoutMs?: number;
  onNotification?: (message: CodexAppServerJsonObject) => void;
  onServerRequest?: (message: CodexAppServerRequestMessage) => void;
  onStderrLine?: (line: string) => void;
  onExit?: (code: number | null, signal: NodeJS.Signals | null) => void;
};

type PendingRequest = {
  method: string;
  timer: NodeJS.Timeout;
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
};

const DEFAULT_REQUEST_TIMEOUT_MS = 30_000;

function asJsonObject(value: unknown): CodexAppServerJsonObject | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as CodexAppServerJsonObject)
    : null;
}

function formatRpcError(error: unknown, fallback: string): Error {
  const record = asJsonObject(error);
  if (!record) {
    return new Error(fallback);
  }
  const code =
    typeof record.code === "number" || typeof record.code === "string"
      ? ` ${record.code}`
      : "";
  const message = typeof record.message === "string" ? record.message : fallback;
  return new Error(`Codex App Server error${code}: ${message}`);
}

function isIgnorableNonJsonStdout(line: string): boolean {
  return (
    /^SUCCESS:\s+The process with PID \d+ \(child process of PID \d+\) has been terminated\.$/i.test(line) ||
    /^SUCCESS:\s+Sent termination signal to the process with PID \d+\.$/i.test(line)
  );
}

export class CodexAppServerTransport {
  private readonly child: ChildProcessWithoutNullStreams;
  private readonly pending = new Map<number, PendingRequest>();
  private readonly requestTimeoutMs: number;
  private readonly onNotification?: (message: CodexAppServerJsonObject) => void;
  private readonly onServerRequest?: (message: CodexAppServerRequestMessage) => void;
  private readonly onStderrLine?: (line: string) => void;
  private readonly onExit?: (code: number | null, signal: NodeJS.Signals | null) => void;
  private nextId = 1;
  private disposed = false;

  constructor(options: CodexAppServerTransportOptions) {
    this.requestTimeoutMs = options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
    this.onNotification = options.onNotification;
    this.onServerRequest = options.onServerRequest;
    this.onStderrLine = options.onStderrLine;
    this.onExit = options.onExit;
    this.child = spawn(options.command, options.args ?? ["app-server"], {
      cwd: options.cwd,
      env: spawnSafeEnv(options.env),
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
    });

    createInterface({ input: this.child.stdout }).on("line", (line) => {
      this.handleLine(line);
    });
    createInterface({ input: this.child.stderr }).on("line", (line) => {
      const trimmed = line.trim();
      if (trimmed) {
        this.onStderrLine?.(trimmed);
      }
    });
    this.child.once("error", (error) => {
      this.rejectAll(error);
    });
    this.child.once("exit", (code, signal) => {
      this.disposed = true;
      this.rejectAll(
        new Error(`Codex App Server exited with code ${code ?? "null"} signal ${signal ?? "null"}`)
      );
      this.onExit?.(code, signal);
    });
  }

  request<T = unknown>(
    method: string,
    params: CodexAppServerJsonObject = {},
    timeoutMs = this.requestTimeoutMs
  ): Promise<T> {
    if (this.disposed) {
      return Promise.reject(new Error("Codex App Server transport is closed."));
    }
    const id = this.nextId++;
    this.write({ id, method, params });
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`${method} timed out after ${timeoutMs}ms`));
      }, timeoutMs);
      this.pending.set(id, {
        method,
        timer,
        resolve: (value) => resolve(value as T),
        reject,
      });
    });
  }

  notify(method: string, params: CodexAppServerJsonObject = {}): void {
    this.write({ method, params });
  }

  respond(id: number | string, result: unknown): void {
    this.write({ id, result });
  }

  respondError(id: number | string, code: number, message: string): void {
    this.write({ id, error: { code, message } });
  }

  dispose(): void {
    if (this.disposed) {
      return;
    }
    this.disposed = true;
    this.rejectAll(new Error("Codex App Server transport disposed."));
    if (!this.child.killed) {
      this.child.kill();
    }
  }

  private write(message: CodexAppServerJsonObject): void {
    if (this.disposed) {
      throw new Error("Codex App Server transport is closed.");
    }
    this.child.stdin.write(`${JSON.stringify(message)}\n`);
  }

  private handleLine(line: string): void {
    const trimmed = line.trim();
    if (!trimmed) {
      return;
    }
    let message: unknown;
    try {
      message = JSON.parse(trimmed) as unknown;
    } catch {
      if (isIgnorableNonJsonStdout(trimmed)) {
        return;
      }
      this.onStderrLine?.(`[codex-app-server] Non-JSON stdout: ${trimmed}`);
      return;
    }
    const record = asJsonObject(message);
    if (!record) {
      return;
    }
    const id = typeof record.id === "number" ? record.id : null;
    if (id !== null && this.pending.has(id)) {
      const pending = this.pending.get(id)!;
      this.pending.delete(id);
      clearTimeout(pending.timer);
      if (record.error != null) {
        pending.reject(formatRpcError(record.error, `${pending.method} failed`));
      } else {
        pending.resolve(record.result);
      }
      return;
    }
    if (
      (typeof record.id === "number" || typeof record.id === "string") &&
      typeof record.method === "string"
    ) {
      this.onServerRequest?.({
        id: record.id,
        method: record.method,
        params: asJsonObject(record.params) ?? undefined,
      });
      return;
    }
    this.onNotification?.(record);
  }

  private rejectAll(error: Error): void {
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.pending.clear();
  }
}
