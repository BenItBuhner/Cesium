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
import { connectOpenCodeServer, type OpenCodeServerConnection } from "./opencode-server-process.js";
import {
  startOpenCodeServerEvents,
  type OpenCodeServerEventStream,
} from "./opencode-server-events.js";
import type { OpenCodeServerJson } from "./opencode-server-client.js";
import {
  normalizeOpenCodeServerEvent,
  normalizeOpenCodeServerMessage,
  openCodeServerPermissionResponse,
} from "./opencode-server-normalize.js";
import {
  attachOpenCodeGlobalSse,
  detachOpenCodeGlobalSse,
} from "./opencode-global-sse.js";
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
  providerAssistantMessageId?: string;
  emittedTextByPartId: Map<string, string>;
  emittedReasoningByPartId: Map<string, string>;
  completed: boolean;
  completionTimer?: ReturnType<typeof setTimeout>;
  promise: Promise<void>;
  resolve: () => void;
  reject: (error: Error) => void;
};

const OPENCODE_SERVER_FINISH_QUIET_MS = 750;

export function openCodeServerPartTextDelta(previous: string, next: string): string {
  if (next === previous) {
    return "";
  }
  return previous && next.startsWith(previous) ? next.slice(previous.length) : next;
}

class OpenCodeServerSessionHandle implements AgentSessionHandle {
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

  constructor(
    private readonly backend: AgentBackendInfo,
    private readonly callbacks: AgentRuntimeCallbacks,
    configOptions: AgentConfigOption[],
    providerSessionId?: string | null
  ) {
    this.globalSseRegistrationId = callbacks.conversation.id;
    this.capabilities = backend.capabilities;
    this.configOptions = callbacks.conversation.configOptions.length > 0
      ? callbacks.conversation.configOptions
      : configOptions;
    this.sessionId = providerSessionId ?? `opencode-server-pending-${callbacks.conversation.id}`;
  }

  async initialize(loadSessionId?: string | null): Promise<void> {
    this.connection = await connectOpenCodeServer({
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
    this.events = startOpenCodeServerEvents({
      client: this.connection.client,
      routes: ["/event"],
      onEvent: (event) => {
        void this.handleServerEvent(event.data);
      },
      onError: (error) => {
        void this.callbacks.appendEvents([
          {
            eventId: randomUUID(),
            conversationId: this.callbacks.conversation.id,
            kind: "system",
            level: "warning",
            text: `OpenCode Server event stream error: ${error.message}`,
          },
        ]);
      },
    });
    this.globalSsePoolKey = `${this.connection.client.baseUrl}::${this.callbacks.workspace.root}`;
    attachOpenCodeGlobalSse(this.globalSsePoolKey, this.globalSseRegistrationId, {
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
        status: "idle",
        pendingPermission: null,
        lastError: null,
        providerSessionId: this.sessionId,
      }));
    } catch (error) {
      this.acceptingPromptSse = false;
      this.clearActivePromptCompletion(activePrompt);
      this.activePrompt = null;
      await this.connection.client.abortSession(this.sessionId).catch(() => undefined);
      const message = error instanceof Error ? error.message : "OpenCode Server prompt failed.";
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
    if (this.activePrompt) {
      this.clearActivePromptCompletion(this.activePrompt);
    }
    this.activePrompt?.reject(new Error("OpenCode Server session aborted."));
    this.activePrompt = null;
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
      return;
    }
    await this.connection.client
      .answerPermission(this.sessionId, input.requestId, openCodeServerPermissionResponse(input.optionId, input.cancelled))
      .catch(() => undefined);
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
    await this.callbacks.updateConversation((current) => ({
      ...current,
      status: "running",
      pendingPermission: null,
    }));
  }

  async dispose(): Promise<void> {
    this.disposed = true;
    this.acceptingPromptSse = false;
    if (this.activePrompt) {
      this.clearActivePromptCompletion(this.activePrompt);
    }
    this.activePrompt?.reject(new Error("OpenCode Server session disposed."));
    this.activePrompt = null;
    this.events?.close();
    this.events = null;
    if (this.globalSsePoolKey) {
      detachOpenCodeGlobalSse(this.globalSsePoolKey, this.globalSseRegistrationId);
      this.globalSsePoolKey = null;
    }
    await this.connection?.dispose();
    this.connection = null;
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
      emittedTextByPartId: new Map(),
      emittedReasoningByPartId: new Map(),
      completed: false,
      promise,
      resolve,
      reject,
    };
  }

  private async waitForActivePrompt(active: ActiveOpenCodePrompt): Promise<void> {
    await active.promise;
  }

  private async completeActivePrompt(active: ActiveOpenCodePrompt, raw: unknown): Promise<void> {
    if (active.completed) {
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
    active.completionTimer = setTimeout(() => {
      if (this.disposed || this.activePrompt !== active || active.completed) {
        return;
      }
      void this.completeActivePrompt(active, raw);
    }, OPENCODE_SERVER_FINISH_QUIET_MS);
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
        active.reject(new Error(message));
      }
    }
  }

  private async handleServerEvent(
    data: unknown,
    options: { allowChildSessionEvents?: boolean } = {}
  ): Promise<void> {
    if (this.disposed || !this.acceptingPromptSse) {
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
    await this.handlePromptLifecycleEvent(record);
    const events = normalizeOpenCodeServerEvent({
      conversationId: this.callbacks.conversation.id,
      rootSessionId: this.sessionId,
      payload: record,
      allowChildSessionEvents: options.allowChildSessionEvents,
    });
    if (events.length === 0) {
      return;
    }
    if (this.disposed || !this.acceptingPromptSse) {
      return;
    }
    await this.callbacks.appendEvents(events);
    const permission = events.find((event) => event.kind === "permission_request");
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
}): AgentProvider {
  return {
    backend: input.backend,
    async startSession(callbacks) {
      const handle = new OpenCodeServerSessionHandle(input.backend, callbacks, input.configOptions);
      await handle.initialize();
      return handle;
    },
    async loadSession(callbacks, providerSessionId) {
      const handle = new OpenCodeServerSessionHandle(
        input.backend,
        callbacks,
        input.configOptions,
        providerSessionId
      );
      await handle.initialize(providerSessionId);
      return handle;
    },
  };
}
