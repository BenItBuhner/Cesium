import { randomUUID } from "node:crypto";
import { asString } from "./json-coerce.js";
import type {
  AgentBackendInfo,
  AgentConfigOption,
  AgentConversationSnapshot,
  AgentProvider,
  AgentProviderCapabilities,
  AgentRuntimeCallbacks,
  AgentSessionHandle,
} from "./types.js";
import {
  connectOpenCodeServer,
  type OpenCodeServerConnection,
  type OpenCodeServerProcessExit,
} from "./opencode-server-process.js";
import {
  startOpenCodeServerEvents,
  type OpenCodeServerEventStream,
} from "./opencode-server-events.js";
import { OpenCodeServerError, type OpenCodeServerJson } from "./opencode-server-client.js";
import {
  normalizeOpenCodeServerEvent,
  normalizeOpenCodeServerMessage,
  openCodeServerPermissionResponse,
} from "./opencode-server-normalize.js";
import {
  attachOpenCodeGlobalSse,
  detachOpenCodeGlobalSse,
} from "./opencode-global-sse.js";
import { createHarnessLogger, type HarnessLogger } from "./harness-diagnostics.js";
import { materializeImageAttachments } from "./prompt-attachments.js";
import {
  appendAgentPluginPrompt,
  resolveAgentPluginAttachments,
} from "../plugins/attachments.js";

function optionValue(options: AgentConfigOption[], id: string, fallback = ""): string {
  return options.find((option) => option.id === id)?.currentValue || fallback;
}

function updateConfigOption(options: AgentConfigOption[], id: string, value: string): AgentConfigOption[] {
  return options.map((option) => (option.id === id ? { ...option, currentValue: value } : option));
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function optionName(options: AgentConfigOption[], id: string, value: string): string {
  const option = options.find((candidate) => candidate.id === id);
  return option?.options.find((candidate) => candidate.value === value)?.name ?? value;
}

function modelBody(value: string): OpenCodeServerJson | undefined {
  if (!value || value === "auto" || value === "__default__") {
    return undefined;
  }
  const [providerID, modelID] = value.includes("/") ? value.split("/", 2) : ["", value];
  return providerID ? { providerID, modelID } : { modelID };
}

function transcriptText(snapshot: AgentConversationSnapshot | null, excludeUserMessageId?: string): string {
  if (!snapshot) {
    return "";
  }
  const lines: string[] = [];
  const assistantChunks = new Map<string, string>();
  for (const event of snapshot.events) {
    if (event.kind === "user_message") {
      if (event.messageId === excludeUserMessageId) {
        continue;
      }
      lines.push(`User: ${event.content}`);
    } else if (event.kind === "assistant_message_chunk") {
      assistantChunks.set(event.messageId, `${assistantChunks.get(event.messageId) ?? ""}${event.text}`);
    } else if (event.kind === "assistant_message_end") {
      const text = assistantChunks.get(event.messageId)?.trim();
      if (text) {
        lines.push(`Assistant: ${text}`);
      }
      assistantChunks.delete(event.messageId);
    }
  }
  for (const text of assistantChunks.values()) {
    if (text.trim()) {
      lines.push(`Assistant: ${text.trim()}`);
    }
  }
  return lines.join("\n\n").trim();
}

function splitSessionRecoveryPrompt(text: string): { transcript: string; userText: string } | null {
  const recovered = text.match(/<recovered_conversation>\s*([\s\S]*?)\s*<\/recovered_conversation>/i);
  const current = text.match(/<current_user_message>\s*([\s\S]*?)\s*<\/current_user_message>/i);
  const transcript = recovered?.[1]?.trim();
  const userText = current?.[1]?.trim();
  if (!transcript || !userText) {
    return null;
  }
  return { transcript, userText };
}

type ActiveOpenCodePrompt = {
  messageId: string;
  startedAt: number;
  providerAssistantMessageId?: string;
  emittedTextByPartId: Map<string, string>;
  emittedReasoningByPartId: Map<string, string>;
  completed: boolean;
  completionTimer?: ReturnType<typeof setTimeout>;
  promise: Promise<void>;
  resolve: () => void;
  reject: (error: Error) => void;
};

const PERMISSION_ANSWER_RETRY_DELAYS_MS = [0, 400, 1_200];
const SSE_ERROR_CONVERSATION_EVENT_INTERVAL_MS = 60_000;
const WATCHDOG_MAX_RECONCILE_FAILURES = 3;

function finishQuietMs(): number {
  const raw = Number.parseInt(process.env.OPENCODE_SERVER_FINISH_QUIET_MS ?? "", 10);
  return Number.isFinite(raw) && raw >= 0 ? raw : 750;
}

function watchdogIntervalMs(): number {
  const raw = Number.parseInt(process.env.OPENCODE_SERVER_WATCHDOG_INTERVAL_MS ?? "", 10);
  return Number.isFinite(raw) && raw >= 25 ? raw : 15_000;
}

function watchdogStallThresholdMs(): number {
  const raw = Number.parseInt(process.env.OPENCODE_SERVER_STALL_THRESHOLD_MS ?? "", 10);
  return Number.isFinite(raw) && raw >= 50 ? raw : 45_000;
}

export function openCodeServerPartTextDelta(previous: string, next: string): string {
  if (next === previous) {
    return "";
  }
  return previous && next.startsWith(previous) ? next.slice(previous.length) : next;
}

/** Injectable transports so reliability behavior is unit-testable without a real OpenCode binary. */
export type OpenCodeServerProviderDeps = {
  connect: typeof connectOpenCodeServer;
  startEvents: typeof startOpenCodeServerEvents;
  attachGlobalSse: typeof attachOpenCodeGlobalSse;
  detachGlobalSse: typeof detachOpenCodeGlobalSse;
};

const defaultDeps: OpenCodeServerProviderDeps = {
  connect: connectOpenCodeServer,
  startEvents: startOpenCodeServerEvents,
  attachGlobalSse: attachOpenCodeGlobalSse,
  detachGlobalSse: detachOpenCodeGlobalSse,
};

export class OpenCodeServerSessionHandle implements AgentSessionHandle {
  readonly capabilities: AgentProviderCapabilities;
  sessionId: string;
  configOptions: AgentConfigOption[];

  private connection: OpenCodeServerConnection | null = null;
  private events: OpenCodeServerEventStream | null = null;
  private seededContext = false;
  private disposed = false;
  private acceptingPromptSse = false;
  private activePrompt: ActiveOpenCodePrompt | null = null;
  private globalSsePoolKey: string | null = null;
  private readonly globalSseRegistrationId: string;
  private readonly deps: OpenCodeServerProviderDeps;
  private readonly log: HarnessLogger;
  /** requestId → session that raised it (root or subagent child session). */
  private readonly pendingPermissions = new Map<string, string>();
  /** Every permission requestId surfaced this session, to dedupe re-emits across SSE routes. */
  private readonly seenPermissionRequestIds = new Set<string>();
  private lastSseActivityAt = 0;
  private watchdogTimer: ReturnType<typeof setInterval> | null = null;
  private watchdogBusy = false;
  private watchdogReconcileFailures = 0;
  private sseConsecutiveErrors = 0;
  private lastSseErrorConversationEventAt = 0;
  private processExited: OpenCodeServerProcessExit | null = null;
  private unsubscribeProcessExit: (() => void) | null = null;

  constructor(
    private readonly backend: AgentBackendInfo,
    private readonly callbacks: AgentRuntimeCallbacks,
    configOptions: AgentConfigOption[],
    providerSessionId?: string | null,
    deps?: Partial<OpenCodeServerProviderDeps>
  ) {
    this.globalSseRegistrationId = callbacks.conversation.id;
    this.capabilities = backend.capabilities;
    this.configOptions = callbacks.conversation.configOptions.length > 0
      ? callbacks.conversation.configOptions
      : configOptions;
    this.sessionId = providerSessionId ?? `opencode-server-pending-${callbacks.conversation.id}`;
    this.deps = { ...defaultDeps, ...deps };
    this.log = createHarnessLogger({
      backendId: backend.id,
      conversationId: callbacks.conversation.id,
    });
  }

  async initialize(loadSessionId?: string | null): Promise<void> {
    this.log.info(
      "session.initialize",
      loadSessionId ? `Resuming OpenCode session ${loadSessionId}.` : "Starting new OpenCode session."
    );
    this.connection = await this.deps.connect({
      workspaceRoot: this.callbacks.workspace.root,
      onStderrLine: (line) => {
        void this.callbacks.appendEvents([
          {
            eventId: randomUUID(),
            conversationId: this.callbacks.conversation.id,
            kind: "system",
            level: "warning",
            text: `[${this.backend.label}] ${line}`,
          },
        ]);
      },
    });
    this.unsubscribeProcessExit = this.connection.onProcessExit((exit) => {
      this.handleProcessExit(exit);
    });
    const session = loadSessionId
      ? await this.connection.client.getSession(loadSessionId)
      : await this.connection.client.createSession({
          title: this.callbacks.conversation.title,
        });
    const id = typeof session.id === "string" ? session.id : loadSessionId;
    if (!id) {
      throw new Error("OpenCode Server did not return a session id.");
    }
    this.sessionId = id;
    this.log.info("session.ready", `OpenCode session ${id} ready at ${this.connection.client.baseUrl}.`);
    this.events = this.deps.startEvents({
      client: this.connection.client,
      routes: ["/event"],
      onEvent: (event) => {
        void this.handleServerEvent(event.data);
      },
      onError: (error) => {
        void this.handleSseStreamError(error);
      },
    });
    this.globalSsePoolKey = `${this.connection.client.baseUrl}::${this.callbacks.workspace.root}`;
    this.deps.attachGlobalSse(this.globalSsePoolKey, this.globalSseRegistrationId, {
      workspaceRoot: this.callbacks.workspace.root,
      rootSessionId: this.sessionId,
      baseUrl: this.connection.client.baseUrl,
      onEvent: async (_directory, payload) => {
        await this.handleServerEvent(payload, { allowChildSessionEvents: true });
      },
    });
    await this.callbacks.updateConversation((current) => ({
      ...current,
      providerSessionId: id,
      configOptions: this.configOptions,
      capabilities: this.capabilities,
      status: "idle",
      pendingPermission: null,
      lastError: null,
    }));
  }

  async prompt(input: {
    text: string;
    userMessageId: string;
    attachments?: Array<{ mimeType: string; data: string; name?: string }>;
  }): Promise<void> {
    if (!this.connection) {
      throw new Error("OpenCode Server session is not initialized.");
    }
    if (this.processExited) {
      throw new Error(
        "OpenCode Server process exited; the session must be restarted before prompting."
      );
    }
    const recovery = splitSessionRecoveryPrompt(input.text);
    if (recovery) {
      await this.seedContextText(recovery.transcript);
    } else {
      await this.seedContextIfNeeded(input.userMessageId);
    }
    const pluginAttachments = await resolveAgentPluginAttachments({
      workspaceId: this.callbacks.workspace.id,
      workspaceRoot: this.callbacks.workspace.root,
      backendId: "opencode-server",
    });
    const promptText = appendAgentPluginPrompt(
      recovery?.userText ?? input.text,
      pluginAttachments
    );
    const imageAttachments = await materializeImageAttachments(
      input.attachments,
      "opencode-server"
    );
    const messageId = `opencode-server-${input.userMessageId}`;
    await this.callbacks.updateConversation((current) => ({
      ...current,
      status: "running",
      pendingPermission: null,
      lastError: null,
    }));
    const activePrompt = this.createActivePrompt(messageId);
    this.activePrompt = activePrompt;
    try {
      const model = modelBody(optionValue(this.configOptions, "model", this.callbacks.conversation.config.modelId));
      const agent =
        optionValue(this.configOptions, "agent") ||
        optionValue(this.configOptions, "mode", this.callbacks.conversation.config.mode);
      this.acceptingPromptSse = true;
      this.log.info("prompt.start", `Prompting OpenCode session ${this.sessionId}.`, {
        messageId,
        model: model ?? null,
        agent: agent || null,
      });
      try {
        await this.connection.client.sendPromptAsync(this.sessionId, {
          ...(model ? { model } : {}),
          ...(agent && agent !== "auto" && agent !== "__default__" ? { agent } : {}),
          parts: [
            { type: "text", text: promptText },
            ...imageAttachments.paths.map((path) => ({ type: "image", path })),
          ],
        });
        await this.waitForActivePrompt(activePrompt);
      } finally {
        await imageAttachments.cleanup();
      }
      this.acceptingPromptSse = false;
      this.activePrompt = null;
      this.log.info(
        "prompt.complete",
        `Turn finished in ${Math.round((Date.now() - activePrompt.startedAt) / 1000)}s.`,
        { messageId }
      );
      await this.callbacks.appendEvents([
        {
          eventId: randomUUID(),
          conversationId: this.callbacks.conversation.id,
          kind: "status",
          status: "idle",
          detail: "OpenCode Server turn complete.",
        },
      ]);
      await this.callbacks.updateConversation((current) => ({
        ...current,
        // A permission raised at the very end of the turn (e.g. a background
        // continuation) must not be clobbered by turn-complete bookkeeping.
        status: this.pendingPermissions.size > 0 ? "awaiting_permission" : "idle",
        pendingPermission:
          this.pendingPermissions.size > 0 ? current.pendingPermission : null,
        lastError: null,
        providerSessionId: this.sessionId,
      }));
    } catch (error) {
      this.acceptingPromptSse = false;
      this.clearActivePromptCompletion(activePrompt);
      this.activePrompt = null;
      await this.connection.client.abortSession(this.sessionId).catch(() => undefined);
      const message = error instanceof Error ? error.message : "OpenCode Server prompt failed.";
      this.log.error("prompt.failed", message, { messageId });
      await this.callbacks.appendEvents([
        {
          eventId: randomUUID(),
          conversationId: this.callbacks.conversation.id,
          kind: "system",
          level: "error",
          text: message,
        },
        {
          eventId: randomUUID(),
          conversationId: this.callbacks.conversation.id,
          kind: "status",
          status: "failed",
          detail: message,
        },
      ]);
      await this.callbacks.updateConversation((current) => ({
        ...current,
        status: "failed",
        pendingPermission: null,
        lastError: message,
      }));
      throw error;
    }
  }

  async cancel(): Promise<void> {
    this.acceptingPromptSse = false;
    this.pendingPermissions.clear();
    if (this.activePrompt) {
      this.clearActivePromptCompletion(this.activePrompt);
    }
    this.activePrompt?.reject(new Error("OpenCode Server session aborted."));
    this.activePrompt = null;
    this.log.info("session.cancel", `Aborting OpenCode session ${this.sessionId}.`);
    await this.connection?.client.abortSession(this.sessionId).catch(() => undefined);
    await this.callbacks.appendEvents([
      {
        eventId: randomUUID(),
        conversationId: this.callbacks.conversation.id,
        kind: "status",
        status: "cancelled",
        detail: "OpenCode Server session aborted.",
      },
    ]);
    await this.callbacks.updateConversation((current) => ({
      ...current,
      status: "cancelled",
      pendingPermission: null,
    }));
  }

  async setConfigOption(configId: string, value: string): Promise<void> {
    this.configOptions = updateConfigOption(this.configOptions, configId, value);
    await this.callbacks.updateConversation((current) => {
      const next = { ...current, configOptions: this.configOptions };
      if (configId === "model") {
        next.config = {
          ...next.config,
          modelId: value,
          modelName: optionName(this.configOptions, configId, value),
        };
      } else if (configId === "mode" || configId === "agent") {
        next.config = { ...next.config, mode: value };
      }
      return next;
    });
  }

  async answerPermission(input: {
    requestId: string;
    optionId?: string;
    cancelled?: boolean;
  }): Promise<void> {
    if (!this.connection) {
      throw new Error("OpenCode Server session is not initialized.");
    }
    const targetSessionId = this.pendingPermissions.get(input.requestId) ?? this.sessionId;
    const response = openCodeServerPermissionResponse(input.optionId, input.cancelled);
    this.log.info(
      "permission.answer",
      `Answering permission ${input.requestId} on session ${targetSessionId}.`,
      { optionId: input.optionId ?? null, cancelled: Boolean(input.cancelled) }
    );
    let delivered = false;
    let lastError: unknown = null;
    for (let attempt = 0; attempt < PERMISSION_ANSWER_RETRY_DELAYS_MS.length; attempt += 1) {
      const delay = PERMISSION_ANSWER_RETRY_DELAYS_MS[attempt]!;
      if (delay > 0) {
        await new Promise((resolve) => setTimeout(resolve, delay));
      }
      try {
        await this.connection.client.answerPermission(targetSessionId, input.requestId, response);
        delivered = true;
        break;
      } catch (error) {
        if (
          error instanceof OpenCodeServerError &&
          (error.status === 400 || error.status === 404 || error.status === 410)
        ) {
          // The request is no longer pending on the OpenCode side (already
          // answered elsewhere, expired, or the tool moved on). Resolving
          // locally is correct; retrying can never succeed.
          this.log.warning(
            "permission.answer_gone",
            `Permission ${input.requestId} was no longer pending on OpenCode (${error.status}); resolving locally.`
          );
          delivered = true;
          break;
        }
        lastError = error;
        this.log.warning(
          "permission.answer_retry",
          `Attempt ${attempt + 1}/${PERMISSION_ANSWER_RETRY_DELAYS_MS.length} failed: ${
            error instanceof Error ? error.message : String(error)
          }`
        );
      }
    }
    if (!delivered) {
      const message = `Failed to deliver the permission response to OpenCode Server after ${
        PERMISSION_ANSWER_RETRY_DELAYS_MS.length
      } attempts: ${lastError instanceof Error ? lastError.message : String(lastError)}`;
      this.log.error("permission.answer_failed", message, { requestId: input.requestId });
      await this.callbacks.appendEvents([
        {
          eventId: randomUUID(),
          conversationId: this.callbacks.conversation.id,
          kind: "system",
          level: "error",
          text: message,
        },
      ]);
      // Leave status/pendingPermission untouched so the prompt card stays
      // actionable and the user can retry instead of freezing on "running".
      throw new Error(message);
    }
    this.pendingPermissions.delete(input.requestId);
    this.log.info("permission.answered", `Permission ${input.requestId} resolved.`);
    await this.callbacks.appendEvents([
      {
        eventId: randomUUID(),
        conversationId: this.callbacks.conversation.id,
        kind: "permission_resolved",
        requestId: input.requestId,
        outcome: input.cancelled ? "cancelled" : "selected",
        optionId: input.optionId,
      },
    ]);
    const turnActive = Boolean(this.activePrompt && !this.activePrompt.completed);
    await this.callbacks.updateConversation((current) => ({
      ...current,
      status:
        this.pendingPermissions.size > 0
          ? "awaiting_permission"
          : turnActive
            ? "running"
            : "idle",
      pendingPermission: null,
    }));
  }

  async dispose(): Promise<void> {
    this.disposed = true;
    this.acceptingPromptSse = false;
    this.stopWatchdog();
    this.pendingPermissions.clear();
    if (this.unsubscribeProcessExit) {
      this.unsubscribeProcessExit();
      this.unsubscribeProcessExit = null;
    }
    if (this.activePrompt) {
      this.clearActivePromptCompletion(this.activePrompt);
    }
    this.activePrompt?.reject(new Error("OpenCode Server session disposed."));
    this.activePrompt = null;
    this.events?.close();
    this.events = null;
    if (this.globalSsePoolKey) {
      this.deps.detachGlobalSse(this.globalSsePoolKey, this.globalSseRegistrationId);
      this.globalSsePoolKey = null;
    }
    this.log.info("session.dispose", `Disposed OpenCode session ${this.sessionId}.`);
    await this.connection?.dispose();
    this.connection = null;
  }

  private handleProcessExit(exit: OpenCodeServerProcessExit): void {
    if (this.disposed) {
      return;
    }
    this.processExited = exit;
    const detail = `OpenCode Server process exited unexpectedly (code ${exit.code ?? "null"}${
      exit.signal ? `, signal ${exit.signal}` : ""
    }).`;
    this.log.error("process.exit_unexpected", detail);
    const active = this.activePrompt;
    if (active && !active.completed) {
      // prompt() owns the failure bookkeeping (events + failed status).
      active.reject(new Error(detail));
      return;
    }
    if (this.pendingPermissions.size > 0) {
      this.pendingPermissions.clear();
      void this.callbacks.appendEvents([
        {
          eventId: randomUUID(),
          conversationId: this.callbacks.conversation.id,
          kind: "system",
          level: "error",
          text: `${detail} The pending permission request can no longer be answered.`,
        },
      ]);
      void this.callbacks.updateConversation((current) => ({
        ...current,
        status: "failed",
        pendingPermission: null,
        lastError: detail,
      }));
    }
  }

  private async handleSseStreamError(error: Error): Promise<void> {
    if (this.disposed) {
      return;
    }
    this.sseConsecutiveErrors += 1;
    this.log.warning("sse.error", error.message, {
      consecutive: this.sseConsecutiveErrors,
    });
    const now = Date.now();
    // The SSE consumer retries forever; without this gate a dead server would
    // append a warning event to the conversation every 750ms indefinitely.
    if (
      this.sseConsecutiveErrors === 1 ||
      now - this.lastSseErrorConversationEventAt >= SSE_ERROR_CONVERSATION_EVENT_INTERVAL_MS
    ) {
      this.lastSseErrorConversationEventAt = now;
      const suffix =
        this.sseConsecutiveErrors > 1 ? ` (${this.sseConsecutiveErrors} consecutive failures)` : "";
      await this.callbacks.appendEvents([
        {
          eventId: randomUUID(),
          conversationId: this.callbacks.conversation.id,
          kind: "system",
          level: "warning",
          text: `OpenCode Server event stream error, reconnecting${suffix}: ${error.message}`,
        },
      ]);
    }
  }

  private async seedContextIfNeeded(userMessageId: string): Promise<void> {
    if (this.seededContext || !this.connection) {
      return;
    }
    const snapshot = await this.callbacks.readSnapshot();
    const transcript = transcriptText(snapshot, userMessageId);
    if (!transcript) {
      this.seededContext = true;
      return;
    }
    await this.seedContextText(transcript);
  }

  private async seedContextText(transcript: string): Promise<void> {
    if (!this.connection) {
      return;
    }
    if (this.seededContext) {
      return;
    }
    this.seededContext = true;
    await this.connection.client.sendMessage(this.sessionId, {
      noReply: true,
      parts: [
        {
          type: "text",
          text: `Prior Cesium conversation context:\n\n${transcript}`,
        },
      ],
    }).catch((error) => {
      this.log.warning(
        "session.seed_failed",
        error instanceof Error ? error.message : String(error)
      );
      void this.callbacks.appendEvents([
        {
          eventId: randomUUID(),
          conversationId: this.callbacks.conversation.id,
          kind: "system",
          level: "warning",
          text: `OpenCode Server context seeding failed: ${error instanceof Error ? error.message : String(error)}`,
        },
      ]);
    });
  }

  private createActivePrompt(messageId: string): ActiveOpenCodePrompt {
    let resolve: () => void = () => undefined;
    let reject: (error: Error) => void = () => undefined;
    const promise = new Promise<void>((res, rej) => {
      resolve = res;
      reject = rej;
    });
    return {
      messageId,
      startedAt: Date.now(),
      emittedTextByPartId: new Map(),
      emittedReasoningByPartId: new Map(),
      completed: false,
      promise,
      resolve,
      reject,
    };
  }

  private async waitForActivePrompt(active: ActiveOpenCodePrompt): Promise<void> {
    this.startWatchdog(active);
    try {
      await active.promise;
    } finally {
      this.stopWatchdog();
    }
  }

  private startWatchdog(active: ActiveOpenCodePrompt): void {
    this.stopWatchdog();
    this.watchdogReconcileFailures = 0;
    this.lastSseActivityAt = Date.now();
    // Deliberately NOT unref'ed: the watchdog must stay alive to settle the
    // active prompt (reconcile or reject), and it is always cleared when the
    // prompt resolves, so it cannot outlive a turn.
    this.watchdogTimer = setInterval(() => {
      void this.watchdogTick(active);
    }, watchdogIntervalMs());
  }

  private stopWatchdog(): void {
    if (this.watchdogTimer) {
      clearInterval(this.watchdogTimer);
      this.watchdogTimer = null;
    }
    this.watchdogBusy = false;
  }

  /**
   * SSE reconnects have no replay, so a `finish` event lost in a disconnect
   * gap used to hang the turn forever. When no session activity arrives for
   * the stall threshold, reconcile against the HTTP message log; when the
   * server itself is unreachable repeatedly, fail the turn instead of hanging.
   */
  private async watchdogTick(active: ActiveOpenCodePrompt): Promise<void> {
    if (this.disposed || active.completed || this.activePrompt !== active) {
      this.stopWatchdog();
      return;
    }
    if (this.watchdogBusy) {
      return;
    }
    if (this.pendingPermissions.size > 0) {
      // Waiting on the user is not a stall; keep the clock fresh.
      this.lastSseActivityAt = Date.now();
      return;
    }
    if (this.processExited || !this.connection) {
      return;
    }
    const idleFor = Date.now() - this.lastSseActivityAt;
    if (idleFor < watchdogStallThresholdMs()) {
      return;
    }
    this.watchdogBusy = true;
    try {
      this.log.warning(
        "watchdog.stall_detected",
        `No OpenCode SSE activity for ${Math.round(idleFor / 1000)}s; reconciling turn state over HTTP.`
      );
      let messages: Array<{ info?: OpenCodeServerJson; parts?: OpenCodeServerJson[] }>;
      try {
        messages = await this.connection.client.listMessages(this.sessionId);
      } catch (error) {
        this.watchdogReconcileFailures += 1;
        const message = error instanceof Error ? error.message : String(error);
        this.log.error("watchdog.reconcile_failed", message, {
          failures: this.watchdogReconcileFailures,
        });
        if (this.watchdogReconcileFailures >= WATCHDOG_MAX_RECONCILE_FAILURES) {
          active.reject(
            new Error(
              `OpenCode Server became unreachable while waiting for the turn to finish: ${message}`
            )
          );
        }
        return;
      }
      this.watchdogReconcileFailures = 0;
      const latestAssistant = [...messages].reverse().find((message) => {
        const info = asRecord(message.info);
        return info?.role === "assistant";
      });
      const info = asRecord(latestAssistant?.info ?? null);
      const finished = Boolean(
        info && (asString(info.finish) || asRecord(info.time)?.completed != null)
      );
      if (finished) {
        this.log.warning(
          "watchdog.reconciled_completion",
          "Latest assistant message already finished server-side; completing the stalled turn from the HTTP message log."
        );
        await this.completeActivePrompt(active, { reason: "watchdog-reconcile" });
      } else {
        // The turn is genuinely still running server-side; reset the clock so
        // the next poll happens one full threshold from now.
        this.lastSseActivityAt = Date.now();
        this.log.info(
          "watchdog.turn_still_running",
          "OpenCode reports the turn is still in progress; continuing to wait."
        );
      }
    } finally {
      this.watchdogBusy = false;
    }
  }

  private async completeActivePrompt(active: ActiveOpenCodePrompt, raw: unknown): Promise<void> {
    if (active.completed) {
      return;
    }
    if (this.pendingPermissions.size > 0) {
      // OpenCode is blocked on the user; completing now would wipe the
      // permission prompt while the provider still waits for an answer.
      this.clearActivePromptCompletion(active);
      this.log.info(
        "prompt.completion_deferred",
        "Deferred turn completion because a permission request is pending."
      );
      return;
    }
    this.clearActivePromptCompletion(active);
    active.completed = true;
    if (this.connection) {
      const messages = await this.connection.client.listMessages(this.sessionId).catch(() => []);
      const latestAssistant = [...messages].reverse().find((message) => {
        const info = asRecord(message.info);
        return info?.role === "assistant";
      });
      if (latestAssistant) {
        const fallbackEvents = normalizeOpenCodeServerMessage({
          conversationId: this.callbacks.conversation.id,
          messageId: active.messageId,
          response: latestAssistant,
        });
        if (active.emittedTextByPartId.size === 0 && fallbackEvents.length > 0) {
          await this.callbacks.appendEvents(fallbackEvents);
        } else {
          const fallbackText = fallbackEvents
            .filter((event) => event.kind === "assistant_message_chunk")
            .map((event) => event.text)
            .join("");
          const emittedText = [...active.emittedTextByPartId.values()].join("");
          const missingTail =
            emittedText && fallbackText.startsWith(emittedText)
              ? fallbackText.slice(emittedText.length)
              : "";
          if (missingTail) {
            await this.callbacks.appendEvents([
              {
                eventId: randomUUID(),
                conversationId: this.callbacks.conversation.id,
                kind: "assistant_message_chunk",
                messageId: active.messageId,
                text: missingTail,
                raw: latestAssistant,
              },
            ]);
          }
        }
      }
    }
    await this.callbacks.appendEvents([
      {
        eventId: randomUUID(),
        conversationId: this.callbacks.conversation.id,
        kind: "assistant_message_end",
        messageId: active.messageId,
        stopReason: "completed",
        raw,
      },
    ]);
    active.resolve();
  }

  private clearActivePromptCompletion(active: ActiveOpenCodePrompt): void {
    if (!active.completionTimer) {
      return;
    }
    clearTimeout(active.completionTimer);
    active.completionTimer = undefined;
  }

  private scheduleActivePromptCompletion(active: ActiveOpenCodePrompt, raw: unknown): void {
    this.clearActivePromptCompletion(active);
    if (this.pendingPermissions.size > 0) {
      this.log.debug(
        "prompt.completion_not_scheduled",
        "Skipped scheduling turn completion while a permission request is pending."
      );
      return;
    }
    active.completionTimer = setTimeout(() => {
      if (this.disposed || this.activePrompt !== active || active.completed) {
        return;
      }
      void this.completeActivePrompt(active, raw);
    }, finishQuietMs());
  }

  private async appendPartTextDelta(input: {
    active: ActiveOpenCodePrompt;
    partId: string;
    text: string;
    kind: "text" | "reasoning";
    raw: unknown;
  }): Promise<void> {
    const emittedByPart =
      input.kind === "text"
        ? input.active.emittedTextByPartId
        : input.active.emittedReasoningByPartId;
    const previous = emittedByPart.get(input.partId) ?? "";
    if (input.text === previous) {
      return;
    }
    const delta = openCodeServerPartTextDelta(previous, input.text);
    if (!delta) {
      return;
    }
    emittedByPart.set(input.partId, input.text);
    if (input.kind === "text") {
      await this.callbacks.appendEvents([
        {
          eventId: randomUUID(),
          conversationId: this.callbacks.conversation.id,
          kind: "assistant_message_chunk",
          messageId: input.active.messageId,
          text: delta,
          raw: input.raw,
        },
      ]);
      return;
    }
    await this.callbacks.appendEvents([
      {
        eventId: randomUUID(),
        conversationId: this.callbacks.conversation.id,
        kind: "reasoning",
        messageId: `${input.active.messageId}-reasoning`,
        text: delta,
        raw: input.raw,
      },
    ]);
  }

  private async handlePromptLifecycleEvent(payload: Record<string, unknown>): Promise<void> {
    const active = this.activePrompt;
    if (!active || active.completed) {
      return;
    }
    const type = asString(payload.type);
    const properties = asRecord(payload.properties);
    if (!type || !properties) {
      return;
    }
    const sessionId = asString(properties.sessionID) ?? asString(asRecord(properties.part)?.sessionID);
    if (sessionId && sessionId !== this.sessionId) {
      return;
    }
    if (type === "message.updated") {
      const info = asRecord(properties.info);
      const providerMessageId = asString(info?.id);
      if (info?.role === "assistant" && providerMessageId) {
        active.providerAssistantMessageId ??= providerMessageId;
      }
      if (
        info?.role === "assistant" &&
        providerMessageId &&
        providerMessageId === active.providerAssistantMessageId &&
        asString(info.finish)
      ) {
        this.scheduleActivePromptCompletion(active, payload);
      }
      return;
    }
    if (type === "message.part.updated") {
      const part = asRecord(properties.part);
      const providerMessageId = asString(part?.messageID);
      if (!part || !providerMessageId || providerMessageId !== active.providerAssistantMessageId) {
        return;
      }
      const partId = asString(part.id) ?? `${providerMessageId}-${active.emittedTextByPartId.size}`;
      if (part.type === "text" && asString(part.text)) {
        await this.appendPartTextDelta({
          active,
          partId,
          text: asString(part.text)!,
          kind: "text",
          raw: payload,
        });
        if (active.completionTimer) {
          this.scheduleActivePromptCompletion(active, payload);
        }
        return;
      }
      if (part.type === "reasoning" && asString(part.text)) {
        await this.appendPartTextDelta({
          active,
          partId,
          text: asString(part.text)!,
          kind: "reasoning",
          raw: payload,
        });
        if (active.completionTimer) {
          this.scheduleActivePromptCompletion(active, payload);
        }
      }
      return;
    }
    if (type === "session.idle") {
      this.scheduleActivePromptCompletion(active, payload);
      return;
    }
    if (type === "session.status") {
      const status = asRecord(properties.status);
      const statusType = asString(status?.type);
      if (statusType === "retry" || statusType === "error" || statusType === "failed") {
        const message =
          asString(status?.message) ?? `OpenCode Server session entered ${statusType} status.`;
        this.log.error("session.status_failure", message, { statusType });
        active.reject(new Error(message));
      }
    }
  }

  private eventSessionId(record: Record<string, unknown>): string | undefined {
    const properties = asRecord(record.properties);
    if (!properties) {
      return undefined;
    }
    return (
      asString(properties.sessionID) ??
      asString(asRecord(properties.part)?.sessionID) ??
      asString(asRecord(properties.permission)?.sessionID) ??
      asString(asRecord(properties.info)?.sessionID)
    );
  }

  private noteSseActivity(
    record: Record<string, unknown>,
    options: { allowChildSessionEvents?: boolean }
  ): void {
    const sessionId = this.eventSessionId(record);
    // Only events attributable to this session tree count as progress; other
    // conversations sharing the server (or heartbeats) must not mask a stall.
    const belongsToUs =
      sessionId === this.sessionId || (Boolean(sessionId) && options.allowChildSessionEvents === true);
    if (!belongsToUs) {
      return;
    }
    this.lastSseActivityAt = Date.now();
    if (this.sseConsecutiveErrors > 0) {
      this.log.info(
        "sse.recovered",
        `Event stream recovered after ${this.sseConsecutiveErrors} failed attempt(s).`
      );
      this.sseConsecutiveErrors = 0;
      this.lastSseErrorConversationEventAt = 0;
    }
  }

  private async handleExternalPermissionReply(record: Record<string, unknown>): Promise<void> {
    const properties = asRecord(record.properties);
    if (!properties) {
      return;
    }
    const requestId =
      asString(properties.permissionID) ??
      asString(asRecord(properties.permission)?.id) ??
      asString(properties.id);
    if (!requestId || !this.pendingPermissions.has(requestId)) {
      return;
    }
    this.pendingPermissions.delete(requestId);
    const response = asString(properties.response);
    this.log.info(
      "permission.replied_externally",
      `Permission ${requestId} was resolved outside Cesium (response: ${response ?? "unknown"}).`
    );
    await this.callbacks.appendEvents([
      {
        eventId: randomUUID(),
        conversationId: this.callbacks.conversation.id,
        kind: "permission_resolved",
        requestId,
        outcome: "selected",
        ...(response ? { optionId: response } : {}),
        raw: record,
      },
    ]);
    const turnActive = Boolean(this.activePrompt && !this.activePrompt.completed);
    await this.callbacks.updateConversation((current) => {
      if (current.pendingPermission && current.pendingPermission.requestId !== requestId) {
        return current;
      }
      return {
        ...current,
        status:
          this.pendingPermissions.size > 0
            ? "awaiting_permission"
            : turnActive
              ? "running"
              : "idle",
        pendingPermission: null,
      };
    });
  }

  private async handleServerEvent(
    data: unknown,
    options: { allowChildSessionEvents?: boolean } = {}
  ): Promise<void> {
    if (this.disposed) {
      return;
    }
    const envelope = data && typeof data === "object" && !Array.isArray(data)
      ? (data as Record<string, unknown>)
      : null;
    if (!envelope) {
      return;
    }
    const record =
      envelope.payload && typeof envelope.payload === "object" && !Array.isArray(envelope.payload)
        ? (envelope.payload as Record<string, unknown>)
        : envelope;
    const type = asString(record.type);
    // Permission lifecycle events must be handled even between turns: a
    // request raised at a turn boundary (or answered elsewhere) that gets
    // dropped leaves OpenCode blocked with no prompt shown to the user.
    const isPermissionLifecycle = type === "permission.updated" || type === "permission.replied";
    if (!this.acceptingPromptSse && !isPermissionLifecycle) {
      return;
    }
    this.noteSseActivity(record, options);
    if (type === "permission.replied") {
      await this.handleExternalPermissionReply(record);
      return;
    }
    await this.handlePromptLifecycleEvent(record);
    const events = normalizeOpenCodeServerEvent({
      conversationId: this.callbacks.conversation.id,
      rootSessionId: this.sessionId,
      payload: record,
      allowChildSessionEvents: options.allowChildSessionEvents,
    }).filter(
      (event) =>
        event.kind !== "permission_request" ||
        !this.seenPermissionRequestIds.has(event.requestId)
    );
    if (events.length === 0) {
      return;
    }
    const permission = events.find((event) => event.kind === "permission_request");
    if (permission?.kind === "permission_request") {
      // Track synchronously (before any await): the same event can arrive on
      // both the session SSE route and the global SSE pool near-simultaneously.
      const raisedBySessionId = this.eventSessionId(record) ?? this.sessionId;
      this.seenPermissionRequestIds.add(permission.requestId);
      this.pendingPermissions.set(permission.requestId, raisedBySessionId);
      this.log.info(
        "permission.requested",
        `OpenCode requested permission ${permission.requestId} (${permission.title ?? "untitled"}).`,
        { sessionId: raisedBySessionId, duringActiveTurn: Boolean(this.activePrompt) }
      );
      if (this.activePrompt?.completionTimer) {
        // A permission arriving inside the finish quiet window means the turn
        // is NOT done; completing would wipe the prompt and freeze the agent.
        this.clearActivePromptCompletion(this.activePrompt);
        this.log.info(
          "permission.cancelled_finish_window",
          "Cancelled the scheduled turn completion because a permission request arrived."
        );
      }
    }
    if (this.disposed || (!this.acceptingPromptSse && !isPermissionLifecycle)) {
      return;
    }
    await this.callbacks.appendEvents(events);
    if (permission?.kind === "permission_request") {
      await this.callbacks.updateConversation((current) => ({
        ...current,
        status: "awaiting_permission",
        pendingPermission: {
          requestId: permission.requestId,
          requestedAt: Date.now(),
          title: permission.title,
          detail: permission.detail,
          toolCallId: permission.toolCallId,
          options: permission.options,
        },
      }));
    }
  }
}

export function createOpenCodeServerProvider(input: {
  backend: AgentBackendInfo;
  configOptions: AgentConfigOption[];
  deps?: Partial<OpenCodeServerProviderDeps>;
}): AgentProvider {
  return {
    backend: input.backend,
    async startSession(callbacks) {
      const handle = new OpenCodeServerSessionHandle(
        input.backend,
        callbacks,
        input.configOptions,
        undefined,
        input.deps
      );
      await handle.initialize();
      return handle;
    },
    async loadSession(callbacks, providerSessionId) {
      const handle = new OpenCodeServerSessionHandle(
        input.backend,
        callbacks,
        input.configOptions,
        providerSessionId,
        input.deps
      );
      await handle.initialize(providerSessionId);
      return handle;
    },
  };
}
