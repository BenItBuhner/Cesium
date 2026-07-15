import { createHash } from "node:crypto";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { spawnSafeEnv } from "./spawn-env.js";
import { createInterface } from "node:readline";

type JsonRpcId = number | string;

export class AcpJsonRpcError extends Error {
  readonly code: number;
  readonly method: string;
  readonly params?: unknown;
  readonly data?: unknown;

  constructor(input: { code: number; message: string; method: string; params?: unknown; data?: unknown }) {
    super(input.message);
    this.name = "AcpJsonRpcError";
    this.code = input.code;
    this.method = input.method;
    this.params = input.params;
    this.data = input.data;
  }
}

type JsonRpcResponse = {
  jsonrpc: "2.0";
  id: JsonRpcId;
  result?: unknown;
  error?: {
    code: number;
    message: string;
    data?: unknown;
  };
};

type JsonRpcRequest = {
  jsonrpc: "2.0";
  id: JsonRpcId;
  method: string;
  params?: unknown;
};

type JsonRpcNotification = {
  jsonrpc: "2.0";
  method: string;
  params?: unknown;
};

type PendingRequest = {
  resolve: (value: unknown) => void;
  reject: (reason?: unknown) => void;
  method: string;
  params?: unknown;
};

export type AcpIncomingRequest = {
  id: JsonRpcId;
  method: string;
  params?: unknown;
};

export type AcpTransportOptions = {
  command: string;
  args: string[];
  cwd: string;
  env?: NodeJS.ProcessEnv;
  processName?: string;
};

export class AcpStdioClient {
  private readonly child: ChildProcessWithoutNullStreams;
  private nextId = 1;
  private readonly pending = new Map<string, PendingRequest>();
  private readonly notificationListeners = new Set<
    (notification: JsonRpcNotification) => void
  >();
  private readonly requestListeners = new Set<
    (request: AcpIncomingRequest) => void
  >();
  private readonly stderrListeners = new Set<(line: string) => void>();
  private readonly exitListeners = new Set<(code: number | null) => void>();

  private constructor(child: ChildProcessWithoutNullStreams) {
    this.child = child;
    this.bindStreams();
  }

  private summarizeParams(method: string, params: unknown): unknown {
    if (params == null) {
      return params;
    }
    if (typeof params !== "object" || Array.isArray(params)) {
      return { kind: Array.isArray(params) ? "array" : typeof params };
    }
    const r = params as Record<string, unknown>;
    if (method === "session/prompt" && "prompt" in r && Array.isArray(r.prompt)) {
      return {
        ...Object.fromEntries(
          Object.keys(r)
            .filter((k) => k !== "prompt")
            .map((k) => [k, r[k]])
        ),
        prompt: (r.prompt as unknown[]).map((item) => {
          if (!item || typeof item !== "object" || Array.isArray(item)) {
            return { kind: "unknown" };
          }
          const p = item as Record<string, unknown>;
          if (p.type === "image") {
            const data = p.data;
            return {
              type: "image",
              mimeType: p.mimeType,
              data: typeof data === "string" ? `[base64 ${data.length} chars]` : "non-string",
            };
          }
          if (p.type === "text" && typeof p.text === "string") {
            const t = p.text;
            return { type: "text", text: `${t.length} chars` };
          }
          return { type: String(p.type ?? "unknown") };
        }),
      };
    }
    if (method === "session/load" || method === "session/new") {
      const out: Record<string, unknown> = { ...r };
      if (typeof out.cwd === "string") {
        out.cwdSha256 = createHash("sha256").update(out.cwd).digest("hex").slice(0, 16);
        delete out.cwd;
      }
      if (typeof out.sessionId === "string") {
        out.sessionId = `${out.sessionId.slice(0, 6)}…${out.sessionId.slice(-4)} (len ${out.sessionId.length})`;
      }
      if (Array.isArray(out.mcpServers)) {
        out.mcpServers = `[${out.mcpServers.length} items]`;
      }
      return out;
    }
    if (typeof r.cwd === "string") {
      return {
        ...r,
        cwdSha256: createHash("sha256").update(r.cwd).digest("hex").slice(0, 16),
        cwd: undefined,
      };
    }
    return r;
  }

  static async spawn(options: AcpTransportOptions): Promise<AcpStdioClient> {
    const child = spawn(options.command, options.args, {
      cwd: options.cwd,
      env: spawnSafeEnv({
        ...options.env,
        ...(options.processName ? { OPENCURSOR_PROCESS_NAME: options.processName } : {}),
      }),
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
      argv0: options.processName ?? undefined,
    });

    await new Promise<void>((resolve, reject) => {
      const onError = (error: Error) => {
        cleanup();
        reject(error);
      };
      const onSpawn = () => {
        cleanup();
        resolve();
      };
      const cleanup = () => {
        child.off("error", onError);
        child.off("spawn", onSpawn);
      };
      child.once("error", onError);
      child.once("spawn", onSpawn);
    });

    return new AcpStdioClient(child);
  }

  onNotification(listener: (notification: JsonRpcNotification) => void): () => void {
    this.notificationListeners.add(listener);
    return () => this.notificationListeners.delete(listener);
  }

  onRequest(listener: (request: AcpIncomingRequest) => void): () => void {
    this.requestListeners.add(listener);
    return () => this.requestListeners.delete(listener);
  }

  onStderr(listener: (line: string) => void): () => void {
    this.stderrListeners.add(listener);
    return () => this.stderrListeners.delete(listener);
  }

  onExit(listener: (code: number | null) => void): () => void {
    this.exitListeners.add(listener);
    return () => this.exitListeners.delete(listener);
  }

  request(method: string, params?: unknown): Promise<unknown> {
    const id = this.nextId++;
    this.send({
      jsonrpc: "2.0",
      id,
      method,
      params,
    });
    return new Promise((resolve, reject) => {
      this.pending.set(String(id), { resolve, reject, method, params });
    });
  }

  notify(method: string, params?: unknown): void {
    this.send({
      jsonrpc: "2.0",
      method,
      params,
    });
  }

  respond(id: JsonRpcId, result: unknown): void {
    this.send({
      jsonrpc: "2.0",
      id,
      result,
    });
  }

  close(): Promise<void> {
    return new Promise((resolve) => {
      if (this.child.killed || this.child.exitCode !== null) {
        resolve();
        return;
      }
      this.child.once("exit", () => resolve());
      this.child.kill();
    });
  }

  private send(payload: Record<string, unknown>): void {
    this.child.stdin.write(`${JSON.stringify(payload)}\n`, "utf8");
  }

  private bindStreams(): void {
    const stdout = createInterface({ input: this.child.stdout });
    const stderr = createInterface({ input: this.child.stderr });

    stdout.on("line", (line) => {
      const trimmed = line.trim();
      if (!trimmed) return;
      let parsed: JsonRpcResponse | JsonRpcRequest | JsonRpcNotification;
      try {
        parsed = JSON.parse(trimmed) as
          | JsonRpcResponse
          | JsonRpcRequest
          | JsonRpcNotification;
      } catch {
        return;
      }
      if ("id" in parsed && "method" in parsed) {
        const request = parsed as JsonRpcRequest;
        for (const listener of this.requestListeners) {
          listener({
            id: request.id,
            method: request.method,
            params: request.params,
          });
        }
        return;
      }
      if ("id" in parsed) {
        const response = parsed as JsonRpcResponse;
        const pending = this.pending.get(String(response.id));
        if (!pending) {
          return;
        }
        this.pending.delete(String(response.id));
        if (response.error) {
          const messageBase = response.error.message || `JSON-RPC error ${response.error.code}`;
          const message = `${messageBase} (code ${response.error.code})`;
          pending.reject(
            new AcpJsonRpcError({
              code: response.error.code,
              message,
              method: pending.method,
              params: this.summarizeParams(pending.method, pending.params),
              data: response.error.data,
            })
          );
          return;
        }
        pending.resolve(response.result);
        return;
      }
      for (const listener of this.notificationListeners) {
        listener(parsed as JsonRpcNotification);
      }
    });

    stderr.on("line", (line) => {
      const trimmed = line.trim();
      if (!trimmed) return;
      for (const listener of this.stderrListeners) {
        listener(trimmed);
      }
    });

    this.child.on("exit", (code) => {
      for (const pending of this.pending.values()) {
        pending.reject(new Error("ACP process exited."));
      }
      this.pending.clear();
      for (const listener of this.exitListeners) {
        listener(code);
      }
    });
  }
}
