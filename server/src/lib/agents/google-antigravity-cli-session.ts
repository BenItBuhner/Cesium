import { randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";
import { spawn } from "node:child_process";
import type { ChildProcess } from "node:child_process";
import { spawnSafeEnv } from "./spawn-env.js";
import {
  GoogleAntigravityHookBridge,
  type GoogleAntigravityHookRecord,
} from "./google-antigravity-cli-hooks.js";
import { GoogleAntigravityTranscriptTailer } from "./google-antigravity-cli-transcript.js";

export type GoogleAntigravityPermissionMode =
  | "request-review"
  | "proceed-in-sandbox"
  | "always-proceed"
  | "strict";

export type GoogleAntigravityCreateSessionOptions = {
  prompt?: string;
  addDirs?: string[];
  conversationId?: string;
  continueLast?: boolean;
  sandbox?: boolean;
  permissionMode?: GoogleAntigravityPermissionMode;
  dangerouslySkipPermissions?: boolean;
  printTimeoutMs?: number;
  logFile?: string;
  hookBridge?: { mergeExistingHooks?: boolean; eventSinkPath?: string } | false;
};

export type GoogleAntigravityEvent =
  | { type: "session.started"; sessionId: string; command: string[]; at: string }
  | { type: "session.ready"; sessionId: string; conversationId?: string; at: string }
  | { type: "auth.required"; sessionId?: string; message: string; at: string }
  | { type: "prompt.submitted"; sessionId: string; prompt: string; at: string }
  | { type: "text.delta"; sessionId: string; text: string; at: string }
  | { type: "text.final"; sessionId: string; text: string; at: string }
  | { type: "thought.delta"; sessionId: string; text: string; at: string }
  | {
      type: "tool.proposed";
      sessionId?: string;
      toolName: string;
      args: Record<string, unknown>;
      stepIdx: number;
      conversationId?: string;
      at: string;
    }
  | { type: "tool.finished"; sessionId?: string; stepIdx: number; conversationId?: string; at: string }
  | {
      type: "tool.failed";
      sessionId?: string;
      stepIdx: number;
      error: string;
      conversationId?: string;
      at: string;
    }
  | {
      type: "permission.requested";
      sessionId?: string;
      action?: string;
      target?: string;
      reason?: string;
      conversationId?: string;
      at: string;
    }
  | { type: "subagent.spawned"; sessionId?: string; conversationId?: string; payload: Record<string, unknown>; at: string }
  | { type: "subagent.updated"; sessionId?: string; conversationId?: string; payload: Record<string, unknown>; at: string }
  | { type: "subagent.completed"; sessionId?: string; conversationId?: string; payload: Record<string, unknown>; at: string }
  | { type: "artifact.created"; sessionId?: string; path: string; conversationId?: string; at: string }
  | { type: "conversation.renamed"; sessionId?: string; conversationId?: string; title: string; at: string }
  | { type: "conversation.resumable"; sessionId?: string; conversationId: string; command?: string; at: string }
  | {
      type: "session.stopped";
      sessionId?: string;
      conversationId?: string;
      reason: string;
      fullyIdle?: boolean;
      at: string;
    }
  | { type: "error"; sessionId?: string; error: Error; at: string };

type TransportStartOptions = {
  command: string;
  args: string[];
  cwd: string;
  env: NodeJS.ProcessEnv;
  signal?: AbortSignal;
};

interface TransportProcess {
  readonly pid: number | undefined;
  readonly output: AsyncIterable<string>;
  write(input: string): void;
  resize?(cols: number, rows: number): void;
  kill(signal?: NodeJS.Signals): void;
  wait(): Promise<number | null>;
}

interface Transport {
  readonly kind: "pty" | "stdio";
  start(options: TransportStartOptions): Promise<TransportProcess>;
}

type NodePtyModule = {
  spawn(
    command: string,
    args: string[],
    options: {
      name?: string;
      cols?: number;
      rows?: number;
      cwd?: string;
      env?: NodeJS.ProcessEnv;
    }
  ): {
    pid: number;
    write(input: string): void;
    resize(cols: number, rows: number): void;
    kill(signal?: string): void;
    onData(handler: (data: string) => void): { dispose(): void };
    onExit(handler: (event: { exitCode: number; signal?: number }) => void): { dispose(): void };
  };
};

function nowIso(): string {
  return new Date().toISOString();
}

export class GoogleAntigravityEventBus {
  private readonly emitter = new EventEmitter();
  private closed = false;

  emit(event: GoogleAntigravityEvent): void {
    if (this.closed) {
      return;
    }
    this.emitter.emit("event", event);
  }

  close(): void {
    this.closed = true;
    this.emitter.emit("close");
    this.emitter.removeAllListeners();
  }

  async *events(signal?: AbortSignal): AsyncIterable<GoogleAntigravityEvent> {
    const queue: GoogleAntigravityEvent[] = [];
    let wake: (() => void) | undefined;
    let done = false;

    const onEvent = (event: GoogleAntigravityEvent): void => {
      queue.push(event);
      wake?.();
      wake = undefined;
    };
    const onClose = (): void => {
      done = true;
      wake?.();
      wake = undefined;
    };
    const onAbort = (): void => onClose();

    this.emitter.on("event", onEvent);
    this.emitter.once("close", onClose);
    signal?.addEventListener("abort", onAbort, { once: true });

    try {
      while (!done || queue.length > 0) {
        const next = queue.shift();
        if (next) {
          yield next;
          continue;
        }
        await new Promise<void>((resolve) => {
          wake = resolve;
        });
      }
    } finally {
      this.emitter.off("event", onEvent);
      this.emitter.off("close", onClose);
      signal?.removeEventListener("abort", onAbort);
    }
  }
}

class StdioProcess implements TransportProcess {
  private readonly chunks: string[] = [];
  private readonly waiters: Array<() => void> = [];
  private done = false;
  private exitCode: number | null = null;

  constructor(private readonly child: ChildProcess) {
    child.stdout?.setEncoding("utf8");
    child.stderr?.setEncoding("utf8");
    child.stdout?.on("data", (chunk: string) => this.push(chunk));
    child.stderr?.on("data", (chunk: string) => this.push(chunk));
    child.on("exit", (code) => {
      this.exitCode = code;
      this.done = true;
      this.wake();
    });
    child.on("error", (error) => {
      this.push(String(error));
      this.done = true;
      this.wake();
    });
  }

  get pid(): number | undefined {
    return this.child.pid;
  }

  get output(): AsyncIterable<string> {
    return this.read();
  }

  write(input: string): void {
    this.child.stdin?.write(input);
  }

  kill(signal: NodeJS.Signals = "SIGTERM"): void {
    this.child.kill(signal);
  }

  async wait(): Promise<number | null> {
    if (this.done) {
      return this.exitCode;
    }
    await new Promise<void>((resolve) => this.waiters.push(resolve));
    return this.exitCode;
  }

  private push(chunk: string): void {
    this.chunks.push(chunk);
    this.wake();
  }

  private wake(): void {
    for (const waiter of this.waiters.splice(0)) {
      waiter();
    }
  }

  private async *read(): AsyncIterable<string> {
    while (!this.done || this.chunks.length > 0) {
      const chunk = this.chunks.shift();
      if (chunk !== undefined) {
        yield chunk;
        continue;
      }
      await new Promise<void>((resolve) => this.waiters.push(resolve));
    }
  }
}

class StdioTransport implements Transport {
  readonly kind = "stdio" as const;

  async start(options: TransportStartOptions): Promise<TransportProcess> {
    const child = spawn(options.command, options.args, {
      cwd: options.cwd,
      env: spawnSafeEnv(options.env),
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
    });
    options.signal?.addEventListener("abort", () => child.kill("SIGTERM"), { once: true });
    return new StdioProcess(child);
  }
}

class PtyProcess implements TransportProcess {
  private readonly subscriptions: Array<{ dispose(): void }> = [];
  private readonly chunks: string[] = [];
  private readonly waiters: Array<() => void> = [];
  private done = false;
  private released = false;
  private exitCode: number | null = null;

  constructor(private readonly ptyProcess: ReturnType<NodePtyModule["spawn"]>) {
    this.subscriptions.push(
      ptyProcess.onData((data) => {
        this.chunks.push(data);
        this.wake();
      })
    );
    this.subscriptions.push(
      ptyProcess.onExit((event) => {
        this.exitCode = event.exitCode;
        this.done = true;
        this.disposeSubscriptions();
        this.releaseNativeHandle();
        this.wake();
      })
    );
  }

  get pid(): number {
    return this.ptyProcess.pid;
  }

  get output(): AsyncIterable<string> {
    return this.read();
  }

  write(input: string): void {
    this.ptyProcess.write(input);
  }

  resize(cols: number, rows: number): void {
    this.ptyProcess.resize(cols, rows);
  }

  kill(signal: NodeJS.Signals = "SIGTERM"): void {
    this.ptyProcess.kill(signal);
    this.released = true;
    this.disposeSubscriptions();
  }

  async wait(): Promise<number | null> {
    if (this.done) {
      this.releaseNativeHandle();
      return this.exitCode;
    }
    await new Promise<void>((resolve) => this.waiters.push(resolve));
    this.releaseNativeHandle();
    return this.exitCode;
  }

  private wake(): void {
    for (const waiter of this.waiters.splice(0)) {
      waiter();
    }
  }

  private disposeSubscriptions(): void {
    for (const subscription of this.subscriptions.splice(0)) {
      subscription.dispose();
    }
  }

  private releaseNativeHandle(): void {
    if (this.released) {
      return;
    }
    this.released = true;
    try {
      this.ptyProcess.kill("SIGTERM");
    } catch {
      // node-pty may throw if the child has already exited.
    }
  }

  private async *read(): AsyncIterable<string> {
    while (!this.done || this.chunks.length > 0) {
      const chunk = this.chunks.shift();
      if (chunk !== undefined) {
        yield chunk;
        continue;
      }
      await new Promise<void>((resolve) => this.waiters.push(resolve));
    }
  }
}

class PtyTransport implements Transport {
  readonly kind = "pty" as const;

  async start(options: TransportStartOptions): Promise<TransportProcess> {
    const nodePty = (await import("node-pty")) as NodePtyModule;
    const pty = nodePty.spawn(options.command, options.args, {
      name: "xterm-256color",
      cols: 120,
      rows: 40,
      cwd: options.cwd,
      env: spawnSafeEnv(options.env),
    });
    options.signal?.addEventListener("abort", () => pty.kill("SIGTERM"), { once: true });
    return new PtyProcess(pty);
  }
}

export class GoogleAntigravitySession {
  readonly id: string;
  private conversationIdValue: string | undefined;
  private transcriptTailer: GoogleAntigravityTranscriptTailer | undefined;
  private closed = false;

  constructor(
    private readonly options: {
      id?: string;
      process: TransportProcess;
      bus: GoogleAntigravityEventBus;
      command: string[];
      hookBridge?: GoogleAntigravityHookBridge;
    }
  ) {
    this.id = options.id ?? randomUUID();
    this.options.bus.emit({
      type: "session.started",
      sessionId: this.id,
      command: options.command,
      at: nowIso(),
    });
    void this.consumeOutput();
    void this.consumeHooks();
  }

  get conversationId(): string | undefined {
    return this.conversationIdValue;
  }

  events(signal?: AbortSignal): AsyncIterable<GoogleAntigravityEvent> {
    return this.options.bus.events(signal);
  }

  prompt(prompt: string): void {
    this.options.bus.emit({ type: "prompt.submitted", sessionId: this.id, prompt, at: nowIso() });
    this.options.process.write(`${prompt}\r`);
  }

  sendSlashCommand(command: string): void {
    this.options.process.write(`${command.startsWith("/") ? command : `/${command}`}\r`);
  }

  async close(): Promise<void> {
    if (this.closed) {
      return;
    }
    this.closed = true;
    this.transcriptTailer?.close();
    this.options.process.write("/exit\r");
    setTimeout(() => this.options.process.kill(), 1_000).unref();
    await this.options.process.wait().catch(() => null);
    this.options.bus.close();
  }

  private async consumeOutput(): Promise<void> {
    let accumulated = "";
    try {
      for await (const chunk of this.options.process.output) {
        accumulated += chunk;
        this.classifyTerminalChunk(chunk, accumulated);
      }
      this.options.bus.emit({
        type: "text.final",
        sessionId: this.id,
        text: stripAnsi(accumulated).trim(),
        at: nowIso(),
      });
    } catch (error) {
      this.options.bus.emit({
        type: "error",
        sessionId: this.id,
        error: asError(error),
        at: nowIso(),
      });
    }
  }

  private async consumeHooks(): Promise<void> {
    const bridge = this.options.hookBridge;
    if (!bridge) {
      return;
    }
    let offset = 0;
    while (!this.closed) {
      try {
        const result = await bridge.readNewRecords(offset);
        offset = result.offset;
        for (const record of result.records) {
          for (const event of hookRecordToGoogleAntigravityEvents(record, this.id)) {
            if ("conversationId" in event && event.conversationId) {
              this.conversationIdValue = event.conversationId;
            }
            this.options.bus.emit(event);
          }
          const transcriptPath =
            typeof record.input.transcriptPath === "string"
              ? record.input.transcriptPath
              : undefined;
          if (transcriptPath && !this.transcriptTailer) {
            this.transcriptTailer = new GoogleAntigravityTranscriptTailer(transcriptPath);
          }
        }
        for (const event of (await this.transcriptTailer?.poll()) ?? []) {
          this.options.bus.emit(event);
        }
      } catch (error) {
        this.options.bus.emit({
          type: "error",
          sessionId: this.id,
          error: asError(error),
          at: nowIso(),
        });
      }
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
  }

  private classifyTerminalChunk(chunk: string, accumulated: string): void {
    const clean = stripAnsi(chunk);
    if (clean.trim()) {
      this.options.bus.emit({ type: "text.delta", sessionId: this.id, text: clean, at: nowIso() });
    }
    if (/sign in|not signed in|google oauth|authorization url|login required|authenticate/i.test(clean)) {
      this.options.bus.emit({ type: "auth.required", sessionId: this.id, message: clean, at: nowIso() });
    }
    const resume = accumulated.match(/agy\s+--conversation[=\s]([0-9a-fA-F-]{16,})/);
    if (resume?.[1] && this.conversationIdValue !== resume[1]) {
      this.conversationIdValue = resume[1];
      this.options.bus.emit({
        type: "conversation.resumable",
        sessionId: this.id,
        conversationId: resume[1],
        command: resume[0],
        at: nowIso(),
      });
    }
  }
}

export async function startGoogleAntigravitySession(options: {
  command: string;
  args?: string[];
  workspace: string;
  env?: NodeJS.ProcessEnv;
  createOptions?: GoogleAntigravityCreateSessionOptions;
  bus?: GoogleAntigravityEventBus;
}): Promise<GoogleAntigravitySession> {
  const bus = options.bus ?? new GoogleAntigravityEventBus();
  const createOptions = options.createOptions ?? {};
  const args = [...(options.args ?? []), ...buildAgyArgs(createOptions)];
  let hookBridge: GoogleAntigravityHookBridge | undefined;
  if (createOptions.hookBridge !== false) {
    hookBridge = new GoogleAntigravityHookBridge({
      workspace: options.workspace,
      sinkPath: createOptions.hookBridge?.eventSinkPath,
    });
    try {
      await hookBridge.install({
        mergeExistingHooks: createOptions.hookBridge?.mergeExistingHooks,
      });
    } catch (error) {
      bus.emit({
        type: "error",
        error: asError(error),
        at: nowIso(),
      });
      hookBridge = undefined;
    }
  }

  const transportInput = {
    command: options.command,
    args,
    cwd: options.workspace,
    env: options.env ?? process.env,
  };
  const childProcess = await startPreferredTransport(transportInput, bus);
  return new GoogleAntigravitySession({
    process: childProcess,
    bus,
    command: [options.command, ...args],
    ...(hookBridge ? { hookBridge } : {}),
  });
}

export function buildAgyArgs(options: GoogleAntigravityCreateSessionOptions): string[] {
  const args: string[] = [];
  for (const addDir of options.addDirs ?? []) {
    args.push("--add-dir", addDir);
  }
  if (options.continueLast) {
    args.push("--continue");
  }
  if (options.conversationId) {
    args.push(`--conversation=${options.conversationId}`);
  }
  if (options.sandbox) {
    args.push("--sandbox");
  }
  if (options.dangerouslySkipPermissions) {
    args.push("--dangerously-skip-permissions");
  }
  if (options.printTimeoutMs) {
    args.push("--print-timeout", `${Math.ceil(options.printTimeoutMs / 1000)}s`);
  }
  if (options.logFile) {
    args.push("--log-file", options.logFile);
  }
  if (options.prompt) {
    args.push("--prompt-interactive", options.prompt);
  }
  return args;
}

async function startPreferredTransport(
  input: TransportStartOptions,
  bus: GoogleAntigravityEventBus
): Promise<TransportProcess> {
  const ptyTransport = new PtyTransport();
  try {
    return await ptyTransport.start(input);
  } catch (error) {
    bus.emit({
      type: "error",
      error: new Error(`Antigravity PTY unavailable; using stdio fallback. ${asError(error).message}`),
      at: nowIso(),
    });
    return new StdioTransport().start(input);
  }
}

function hookRecordToGoogleAntigravityEvents(
  record: GoogleAntigravityHookRecord,
  sessionId: string
): GoogleAntigravityEvent[] {
  const input = record.input;
  const conversationId =
    typeof input.conversationId === "string" ? input.conversationId : undefined;
  const at = record.receivedAt;

  if (record.event === "PreToolUse") {
    const toolCall = isRecord(input.toolCall) ? input.toolCall : undefined;
    const args = isRecord(toolCall?.args) ? toolCall.args : {};
    const name = typeof toolCall?.name === "string" ? toolCall.name : "unknown";
    const stepIdx = typeof input.stepIdx === "number" ? input.stepIdx : -1;
    const events: GoogleAntigravityEvent[] = [
      {
        type: "tool.proposed",
        sessionId,
        toolName: name,
        args,
        stepIdx,
        conversationId,
        at,
      },
    ];
    if (name === "ask_permission") {
      events.push({
        type: "permission.requested",
        sessionId,
        action: stringValue(args.Action ?? args.action),
        target: stringValue(args.Target ?? args.target),
        reason: stringValue(args.Reason ?? args.reason),
        conversationId,
        at,
      });
    }
    if (name === "invoke_subagent") {
      events.push({
        type: "subagent.spawned",
        sessionId,
        conversationId,
        payload: args,
        at,
      });
    }
    return events;
  }

  if (record.event === "PostToolUse") {
    const stepIdx = typeof input.stepIdx === "number" ? input.stepIdx : -1;
    const error = typeof input.error === "string" ? input.error : "";
    return [
      error
        ? { type: "tool.failed", sessionId, stepIdx, error, conversationId, at }
        : { type: "tool.finished", sessionId, stepIdx, conversationId, at },
    ];
  }

  if (record.event === "Stop") {
    return [
      {
        type: "session.stopped",
        sessionId,
        conversationId,
        reason: stringValue(input.terminationReason) ?? "unknown",
        fullyIdle: Boolean(input.fullyIdle),
        at,
      },
    ];
  }

  return [];
}

function stripAnsi(input: string): string {
  return input.replace(/\u001b\[[0-9;?]*[ -/]*[@-~]/g, "");
}

function asError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}
