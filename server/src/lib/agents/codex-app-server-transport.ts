import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createInterface } from "node:readline";
import { spawnSafeEnv } from "./spawn-env.js";

export type CodexAppServerJsonObject = Record<string, unknown>;

export type CodexAppServerRpcId = number | string;

export type CodexAppServerRequestMessage = {
  id: CodexAppServerRpcId;
  method: string;
  params?: CodexAppServerJsonObject;
};

export type CodexAppServerTransportOptions = {
  command: string;
  args?: string[];
  cwd: string;
  env?: NodeJS.ProcessEnv;
  processName?: string;
  /**
   * Default timeout for outgoing requests. `turn/start` and friends resolve as
   * soon as the server acknowledges them (the work itself streams as
   * notifications), so a bounded wait only guards against a wedged process.
   */
  requestTimeoutMs?: number;
  onNotification?: (message: CodexAppServerJsonObject) => void;
  onServerRequest?: (message: CodexAppServerRequestMessage) => void;
  onStderrLine?: (line: string) => void;
  onExit?: (code: number | null, signal: NodeJS.Signals | null) => void;
};

type PendingRequest = {
  method: string;
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout | null;
};

export class CodexAppServerRpcError extends Error {
  readonly code: number | string | null;
  readonly method: string;
  readonly data: unknown;

  constructor(input: { method: string; code: number | string | null; message: string; data?: unknown }) {
    super(`Codex App Server error${input.code != null ? ` ${input.code}` : ""}: ${input.message}`);
    this.name = "CodexAppServerRpcError";
    this.method = input.method;
    this.code = input.code;
    this.data = input.data;
  }
}

const DEFAULT_REQUEST_TIMEOUT_MS = 120_000;

function asJsonObject(value: unknown): CodexAppServerJsonObject | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as CodexAppServerJsonObject)
    : null;
}

function formatRpcError(method: string, error: unknown): Error {
  const record = asJsonObject(error);
  if (!record) {
    return new CodexAppServerRpcError({
      method,
      code: null,
      message: typeof error === "string" && error.trim() ? error : `${method} failed`,
    });
  }
  return new CodexAppServerRpcError({
    method,
    code: typeof record.code === "number" || typeof record.code === "string" ? record.code : null,
    message: typeof record.message === "string" && record.message.trim() ? record.message : `${method} failed`,
    data: record.data,
  });
}

function isIgnorableNonJsonStdout(line: string): boolean {
  return (
    /^SUCCESS:\s+The process with PID \d+ \(child process of PID \d+\) has been terminated\.$/i.test(line) ||
    /^SUCCESS:\s+Sent termination signal to the process with PID \d+\.$/i.test(line)
  );
}

function isRpcId(value: unknown): value is CodexAppServerRpcId {
  return typeof value === "number" || typeof value === "string";
}

/**
 * Line-delimited JSON-RPC 2.0 transport over the `codex app-server` stdio
 * pipe. Client requests carry monotonically increasing numeric ids; server
 * requests (approvals, user-input prompts, ...) are surfaced through
 * `onServerRequest` and answered with `respond`/`respondError`.
 */
export class CodexAppServerTransport {
  private readonly child: ChildProcessWithoutNullStreams;
  private readonly pending = new Map<number, PendingRequest>();
  private readonly onNotification?: (message: CodexAppServerJsonObject) => void;
  private readonly onServerRequest?: (message: CodexAppServerRequestMessage) => void;
  private readonly onStderrLine?: (line: string) => void;
  private readonly onExit?: (code: number | null, signal: NodeJS.Signals | null) => void;
  private readonly requestTimeoutMs: number;
  private nextId = 1;
  private disposed = false;
  private exitInfo: { code: number | null; signal: NodeJS.Signals | null } | null = null;
  private spawnError: Error | null = null;

  constructor(options: CodexAppServerTransportOptions) {
    this.onNotification = options.onNotification;
    this.onServerRequest = options.onServerRequest;
    this.onStderrLine = options.onStderrLine;
    this.onExit = options.onExit;
    this.requestTimeoutMs = options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
    this.child = spawn(options.command, options.args ?? ["app-server"], {
      cwd: options.cwd,
      env: spawnSafeEnv({
        ...options.env,
        OPENCURSOR_PROCESS_NAME: options.processName ?? "Cesium Agent - Codex App Server",
      }),
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
      argv0: options.processName ?? "Cesium Agent - Codex App Server",
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
    // A closed stdin (server exited mid-write) must not crash the host process.
    this.child.stdin.on("error", (error: NodeJS.ErrnoException) => {
      if (error.code !== "EPIPE" && error.code !== "ERR_STREAM_DESTROYED") {
        this.onStderrLine?.(`[codex-app-server] stdin error: ${error.message}`);
      }
    });
    this.child.once("error", (error) => {
      this.spawnError = error;
      this.disposed = true;
      this.rejectAll(
        new Error(
          `Failed to start Codex App Server (${options.command}): ${error.message}`
        )
      );
      // `exit` never fires for spawn failures (ENOENT/EACCES), so surface the
      // lifecycle end here.
      this.onExit?.(null, null);
    });
    this.child.once("exit", (code, signal) => {
      this.exitInfo = { code, signal };
      this.disposed = true;
      this.rejectAll(
        new Error(`Codex App Server exited with code ${code ?? "null"} signal ${signal ?? "null"}`)
      );
      this.onExit?.(code, signal);
    });
  }

  get isDisposed(): boolean {
    return this.disposed;
  }

  get pid(): number | undefined {
    return this.child.pid;
  }

  request<T = unknown>(
    method: string,
    params: CodexAppServerJsonObject = {},
    options: { timeoutMs?: number } = {}
  ): Promise<T> {
    if (this.disposed) {
      return Promise.reject(this.closedError());
    }
    const id = this.nextId++;
    const timeoutMs = options.timeoutMs ?? this.requestTimeoutMs;
    return new Promise<T>((resolve, reject) => {
      const timer =
        timeoutMs > 0
          ? setTimeout(() => {
              if (this.pending.delete(id)) {
                reject(
                  new Error(
                    `Codex App Server request ${method} timed out after ${Math.round(timeoutMs / 1000)}s.`
                  )
                );
              }
            }, timeoutMs)
          : null;
      this.pending.set(id, {
        method,
        resolve: (value) => resolve(value as T),
        reject,
        timer,
      });
      try {
        this.write({ id, method, params });
      } catch (error) {
        const pending = this.pending.get(id);
        if (pending) {
          this.pending.delete(id);
          if (pending.timer) {
            clearTimeout(pending.timer);
          }
        }
        reject(error instanceof Error ? error : new Error(String(error)));
      }
    });
  }

  notify(method: string, params: CodexAppServerJsonObject = {}): void {
    this.write({ method, params });
  }

  /** Answers a server-initiated request. Silently no-ops once the process is gone. */
  respond(id: CodexAppServerRpcId, result: unknown): boolean {
    return this.tryWrite({ id, result });
  }

  respondError(id: CodexAppServerRpcId, code: number, message: string): boolean {
    return this.tryWrite({ id, error: { code, message } });
  }

  dispose(): void {
    if (this.disposed) {
      return;
    }
    this.disposed = true;
    this.rejectAll(new Error("Codex App Server transport disposed."));
    try {
      this.child.stdin.end();
    } catch {
      // ignore
    }
    if (!this.child.killed) {
      this.child.kill();
    }
  }

  private closedError(): Error {
    if (this.spawnError) {
      return new Error(`Codex App Server could not be started: ${this.spawnError.message}`);
    }
    if (this.exitInfo) {
      return new Error(
        `Codex App Server exited with code ${this.exitInfo.code ?? "null"} signal ${this.exitInfo.signal ?? "null"}`
      );
    }
    return new Error("Codex App Server transport is closed.");
  }

  private tryWrite(message: CodexAppServerJsonObject): boolean {
    if (this.disposed) {
      return false;
    }
    try {
      this.write(message);
      return true;
    } catch {
      return false;
    }
  }

  private write(message: CodexAppServerJsonObject): void {
    if (this.disposed) {
      throw this.closedError();
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
    const hasMethod = typeof record.method === "string";
    // Responses to our requests: numeric id we issued and no method field.
    if (!hasMethod && typeof record.id === "number" && this.pending.has(record.id)) {
      const pending = this.pending.get(record.id)!;
      this.pending.delete(record.id);
      if (pending.timer) {
        clearTimeout(pending.timer);
      }
      if (record.error != null) {
        pending.reject(formatRpcError(pending.method, record.error));
      } else {
        pending.resolve(record.result);
      }
      return;
    }
    if (hasMethod && isRpcId(record.id)) {
      this.onServerRequest?.({
        id: record.id,
        method: record.method as string,
        params: asJsonObject(record.params) ?? undefined,
      });
      return;
    }
    if (hasMethod) {
      this.onNotification?.(record);
      return;
    }
    // Stray response for a request we no longer track (timed out) - ignore.
  }

  private rejectAll(error: Error): void {
    for (const pending of this.pending.values()) {
      if (pending.timer) {
        clearTimeout(pending.timer);
      }
      pending.reject(error);
    }
    this.pending.clear();
  }
}
