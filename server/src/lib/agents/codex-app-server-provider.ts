import { randomUUID } from "node:crypto";
import type {
  AgentBackendInfo,
  AgentConfigOption,
  AgentEventInput,
  AgentProvider,
  AgentProviderCapabilities,
  AgentRuntimeCallbacks,
  AgentSessionHandle,
} from "./types.js";
import type { CliRuntimeSpec } from "./cli-adapter.js";
import {
  CodexAppServerTransport,
  type CodexAppServerJsonObject,
  type CodexAppServerRequestMessage,
} from "./codex-app-server-transport.js";
import {
  codexAppServerAssistantTextFromItem,
  codexAppServerDecisionForOption,
  codexAppServerPermissionRequestFromServerRequest,
  codexAppServerPlanEntriesFromTurnPlan,
  codexAppServerReasoningDelta,
  codexAppServerStatusFromTurn,
  codexAppServerTextDelta,
  codexAppServerToolEventFromItem,
} from "./codex-app-server-normalize.js";

type PendingTurn = {
  turnId: string | null;
  resolve: () => void;
  reject: (error: Error) => void;
};

type PendingServerRequest = {
  rpcId: number | string;
  method: string;
};

function asRecord(value: unknown): CodexAppServerJsonObject | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as CodexAppServerJsonObject)
    : undefined;
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value : undefined;
}

function currentValueFor(options: AgentConfigOption[], id: string): string | undefined {
  return options.find((option) => option.id === id)?.currentValue;
}

function updateConfigOption(
  options: AgentConfigOption[],
  configId: string,
  value: string
): AgentConfigOption[] {
  return options.map((option) =>
    option.id === configId ? { ...option, currentValue: value } : option
  );
}

function optionName(options: AgentConfigOption[], configId: string, value: string): string {
  const option = options.find((candidate) => candidate.id === configId);
  return option?.options.find((candidate) => candidate.value === value)?.name ?? value;
}

function optionHasValue(option: AgentConfigOption | undefined, value: string | undefined): value is string {
  return Boolean(value && option?.options.some((candidate) => candidate.value === value));
}

function hydrateConfigOptions(
  backendOptions: AgentConfigOption[],
  conversation: AgentRuntimeCallbacks["conversation"]
): AgentConfigOption[] {
  const persistedById = new Map(conversation.configOptions.map((option) => [option.id, option]));
  const optionIds = new Set([
    ...backendOptions.map((option) => option.id),
    ...conversation.configOptions.map((option) => option.id),
  ]);

  return Array.from(optionIds).flatMap((id) => {
    const backendOption = backendOptions.find((option) => option.id === id);
    const persistedOption = persistedById.get(id);
    const base = backendOption ?? persistedOption;
    if (!base) {
      return [];
    }
    const optionByValue = new Map<string, AgentConfigOption["options"][number]>();
    for (const value of [...(backendOption?.options ?? []), ...(persistedOption?.options ?? [])]) {
      optionByValue.set(value.value, value);
    }
    const options = Array.from(optionByValue.values());
    const merged: AgentConfigOption = {
      ...base,
      options,
      currentValue: persistedOption?.currentValue || backendOption?.currentValue || base.currentValue,
    };
    if (id === "model" && optionHasValue(merged, conversation.config.modelId)) {
      return [{ ...merged, currentValue: conversation.config.modelId }];
    }
    if (id === "mode" && optionHasValue(merged, conversation.config.mode)) {
      return [{ ...merged, currentValue: conversation.config.mode }];
    }
    if (!optionHasValue(merged, merged.currentValue)) {
      return [{ ...merged, currentValue: backendOption?.currentValue ?? options[0]?.value ?? merged.currentValue }];
    }
    return [merged];
  });
}

function sandboxPolicyForPermission(permission: string, workspaceRoot: string): CodexAppServerJsonObject {
  if (
    permission === "bypassPermissions" &&
    process.env.OPENCURSOR_CODEX_APP_SERVER_ALLOW_BYPASS === "1"
  ) {
    return { type: "dangerFullAccess", mode: "dangerFullAccess" };
  }
  if (permission === "read-only" || permission === "readonly" || permission === "ask") {
    return { type: "readOnly", mode: "readOnly" };
  }
  return {
    type: "workspaceWrite",
    mode: "workspaceWrite",
    writableRoots: [workspaceRoot],
    networkAccess: true,
    writable_roots: [workspaceRoot],
    network_access: true,
    exclude_tmpdir_env_var: false,
    exclude_slash_tmp: false,
  };
}

function approvalPolicyForPermission(permission: string): string {
  if (
    permission === "bypassPermissions" &&
    process.env.OPENCURSOR_CODEX_APP_SERVER_ALLOW_BYPASS === "1"
  ) {
    return "never";
  }
  if (permission === "on-request") {
    return "on-request";
  }
  if (permission === "read-only" || permission === "readonly" || permission === "ask") {
    return "on-request";
  }
  return "on-failure";
}

function turnStatusFromConversationStatus(status: string): "idle" | "failed" | "interrupted" {
  if (status === "failed") {
    return "failed";
  }
  if (status === "interrupted" || status === "cancelled") {
    return "interrupted";
  }
  return "idle";
}

class CodexAppServerSessionHandle implements AgentSessionHandle {
  readonly capabilities: AgentProviderCapabilities;
  sessionId: string;
  configOptions: AgentConfigOption[];

  private readonly backend: AgentBackendInfo;
  private readonly runtime: CliRuntimeSpec;
  private readonly callbacks: AgentRuntimeCallbacks;
  private transport: CodexAppServerTransport | null = null;
  private threadId: string | null;
  private pendingTurn: PendingTurn | null = null;
  private readonly assistantTextByItemId = new Map<string, string>();
  private readonly assistantItemsForTurn = new Set<string>();
  private readonly pendingServerRequests = new Map<string, PendingServerRequest>();
  private lastCodexEventError: string | null = null;
  private disposed = false;

  constructor(input: {
    backend: AgentBackendInfo;
    runtime: CliRuntimeSpec;
    callbacks: AgentRuntimeCallbacks;
    configOptions: AgentConfigOption[];
    providerSessionId?: string;
  }) {
    this.backend = input.backend;
    this.capabilities = input.backend.capabilities;
    this.runtime = input.runtime;
    this.callbacks = input.callbacks;
    this.configOptions = hydrateConfigOptions(input.configOptions, input.callbacks.conversation);
    this.threadId = input.providerSessionId ?? null;
    this.sessionId =
      input.providerSessionId ?? `codex-app-server-pending-${input.callbacks.conversation.id}`;
  }

  async initialize(): Promise<void> {
    const transport = this.createTransport();
    this.transport = transport;
    await transport.request("initialize", {
      clientInfo: {
        name: process.env.CODEX_APP_SERVER_CLIENT_NAME?.trim() || "cesium_codex_app_server",
        title: "Cesium Codex App Server",
        version: "0.1.0",
      },
      capabilities: { experimentalApi: true },
    });
    transport.notify("initialized");

    if (this.threadId) {
      await this.resumeThread();
    } else {
      await this.startThread();
    }
  }

  async prompt(input: {
    text: string;
    userMessageId: string;
    attachments?: Array<{ mimeType: string; data: string; name?: string }>;
  }): Promise<void> {
    if (!this.transport || !this.threadId) {
      throw new Error("Codex App Server session is not initialized.");
    }
    this.assistantItemsForTurn.clear();
    this.assistantTextByItemId.clear();
    this.lastCodexEventError = null;
    const model = this.callbacks.conversation.config.modelId || currentValueFor(this.configOptions, "model");
    const effort =
      currentValueFor(this.configOptions, "model_reasoning_effort") ||
      currentValueFor(this.configOptions, "effort");
    const permission = currentValueFor(this.configOptions, "permission") || "workspace-write";
    const mode = currentValueFor(this.configOptions, "mode") || this.callbacks.conversation.config.mode || "agent";
    const turnParams: CodexAppServerJsonObject = {
      threadId: this.threadId,
      mode,
      input: [
        { type: "text", text: input.text },
        ...(input.attachments ?? []).flatMap((attachment) =>
          attachment.mimeType.startsWith("image/") && attachment.name
            ? [{ type: "localImage", path: attachment.name }]
            : []
        ),
      ],
      cwd: this.callbacks.workspace.root,
      approvalPolicy: approvalPolicyForPermission(permission),
      sandboxPolicy: sandboxPolicyForPermission(permission, this.callbacks.workspace.root),
    };
    if (model && model !== "__default__" && model !== "auto") {
      turnParams.model = model;
    }
    if (effort) {
      turnParams.effort = effort;
    }

    await this.callbacks.updateConversation((current) => ({
      ...current,
      status: "running",
      pendingPermission: null,
      lastError: null,
      providerSessionId: this.sessionId,
      capabilities: this.capabilities,
      configOptions: this.configOptions,
    }));

    const turnPromise = new Promise<void>((resolve, reject) => {
      this.pendingTurn = { turnId: null, resolve, reject };
    });
    const result = (await this.transport.request("turn/start", turnParams)) as CodexAppServerJsonObject;
    const turn = asRecord(result.turn);
    const turnId = asString(turn?.id) ?? null;
    if (this.pendingTurn) {
      this.pendingTurn.turnId = turnId;
    }
    await turnPromise;
  }

  async cancel(): Promise<void> {
    if (this.transport && this.threadId && this.pendingTurn?.turnId) {
      await this.transport
        .request("turn/interrupt", {
          threadId: this.threadId,
          turnId: this.pendingTurn.turnId,
        })
        .catch(() => undefined);
    }
    await this.callbacks.appendEvents([
      {
        eventId: randomUUID(),
        conversationId: this.callbacks.conversation.id,
        kind: "status",
        status: "cancelled",
        detail: "Codex App Server turn cancelled.",
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
      } else if (configId === "mode") {
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
    const pending = this.pendingServerRequests.get(input.requestId);
    if (!pending || !this.transport) {
      return;
    }
    this.pendingServerRequests.delete(input.requestId);
    const decision = codexAppServerDecisionForOption(input.optionId, input.cancelled);
    this.transport.respond(pending.rpcId, decision);
    await this.callbacks.appendEvents([
      {
        eventId: randomUUID(),
        conversationId: this.callbacks.conversation.id,
        kind: "permission_resolved",
        requestId: input.requestId,
        outcome: input.cancelled ? "cancelled" : "selected",
        optionId: input.optionId,
      },
      {
        eventId: randomUUID(),
        conversationId: this.callbacks.conversation.id,
        kind: "status",
        status: "running",
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
    if (this.transport && this.threadId) {
      await this.transport
        .request("thread/unsubscribe", { threadId: this.threadId })
        .catch(() => undefined);
    }
    this.transport?.dispose();
    this.transport = null;
  }

  private createTransport(): CodexAppServerTransport {
    return new CodexAppServerTransport({
      command: this.runtime.command,
      args: [...this.runtime.args, "app-server"],
      cwd: this.callbacks.workspace.root,
      env: this.runtime.env,
      onNotification: (message) => {
        void this.handleNotification(message);
      },
      onServerRequest: (message) => {
        void this.handleServerRequest(message);
      },
      onStderrLine: (line) => {
        if (/codex_core::(?:exec|tools::router):/i.test(line)) {
          return;
        }
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
      onExit: () => {
        if (!this.disposed) {
          this.callbacks.markRuntimeStale?.();
        }
      },
    });
  }

  private async startThread(): Promise<void> {
    if (!this.transport) {
      throw new Error("Codex App Server transport is not initialized.");
    }
    const model = this.callbacks.conversation.config.modelId || currentValueFor(this.configOptions, "model");
    const result = (await this.transport.request("thread/start", {
      cwd: this.callbacks.workspace.root,
      ...(model && model !== "__default__" && model !== "auto" ? { model } : {}),
      serviceName: "cesium_codex_app_server",
    })) as CodexAppServerJsonObject;
    this.applyThreadResult(result);
  }

  private async resumeThread(): Promise<void> {
    if (!this.transport || !this.threadId) {
      throw new Error("Codex App Server transport is not initialized.");
    }
    const result = (await this.transport.request("thread/resume", {
      threadId: this.threadId,
    })) as CodexAppServerJsonObject;
    this.applyThreadResult(result);
  }

  private applyThreadResult(result: CodexAppServerJsonObject): void {
    const thread = asRecord(result.thread);
    const id = asString(thread?.id);
    if (!id) {
      throw new Error("Codex App Server did not return a thread id.");
    }
    this.threadId = id;
    this.sessionId = id;
    void this.callbacks.updateConversation((current) => ({
      ...current,
      providerSessionId: id,
      capabilities: this.capabilities,
      configOptions: this.configOptions,
      status: current.status === "running" ? current.status : "idle",
      pendingPermission: null,
      lastError: null,
    }));
  }

  private async handleNotification(message: CodexAppServerJsonObject): Promise<void> {
    const method = asString(message.method);
    const params = asRecord(message.params) ?? {};
    if (!method) {
      return;
    }
    switch (method) {
      case "item/agentMessage/delta":
        await this.handleAssistantDelta(params, message);
        return;
      case "item/reasoning/summaryTextDelta":
      case "item/reasoning/textDelta": {
        const text = codexAppServerReasoningDelta(params);
        if (text) {
          await this.callbacks.appendEvents([
            {
              eventId: randomUUID(),
              conversationId: this.callbacks.conversation.id,
              kind: "reasoning",
              messageId: `codex-app-server-reasoning-${params.itemId ?? "turn"}`,
              text,
              raw: message,
            },
          ]);
        }
        return;
      }
      case "turn/plan/updated": {
        const entries = codexAppServerPlanEntriesFromTurnPlan(params);
        if (entries.length > 0) {
          await this.callbacks.appendEvents([
            {
              eventId: randomUUID(),
              conversationId: this.callbacks.conversation.id,
              kind: "plan",
              planId: `${this.callbacks.conversation.id}-codex-app-server-plan`,
              entries,
              raw: message,
            },
          ]);
        }
        return;
      }
      case "item/started":
      case "item/updated":
      case "item/completed":
        await this.handleItemLifecycle(method, params, message);
        return;
      case "item/commandExecution/outputDelta":
      case "item/fileChange/outputDelta":
        await this.handleOutputDelta(method, params, message);
        return;
      case "turn/completed":
        await this.handleTurnCompleted(params, message);
        return;
      case "serverRequest/resolved":
        await this.handleServerRequestResolved(params, message);
        return;
      case "error":
        await this.handleError(params, message);
        return;
      default:
        if (method.startsWith("codex/event/")) {
          await this.handleLegacyCodexEvent(method, params, message);
          return;
        }
        if (method.endsWith("/updated") && (method.startsWith("account/") || method.startsWith("mcpServer/"))) {
          return;
        }
        return;
    }
  }

  private async handleAssistantDelta(
    params: CodexAppServerJsonObject,
    raw: CodexAppServerJsonObject
  ): Promise<void> {
    const delta = codexAppServerTextDelta(params);
    if (!delta) {
      return;
    }
    const messageId = `codex-app-server-${delta.itemId}`;
    this.assistantItemsForTurn.add(delta.itemId);
    this.assistantTextByItemId.set(
      delta.itemId,
      `${this.assistantTextByItemId.get(delta.itemId) ?? ""}${delta.text}`
    );
    await this.callbacks.appendEvents([
      {
        eventId: randomUUID(),
        conversationId: this.callbacks.conversation.id,
        kind: "assistant_message_chunk",
        messageId,
        text: delta.text,
        raw,
      },
    ]);
  }

  private async handleItemLifecycle(
    method: string,
    params: CodexAppServerJsonObject,
    raw: CodexAppServerJsonObject
  ): Promise<void> {
    const item = asRecord(params.item);
    if (!item) {
      return;
    }
    const itemId = asString(item.id);
    const finalAssistantText = codexAppServerAssistantTextFromItem(item);
    if (itemId && finalAssistantText && method === "item/completed") {
      const emitted = this.assistantTextByItemId.get(itemId) ?? "";
      const remainder =
        emitted && finalAssistantText.startsWith(emitted)
          ? finalAssistantText.slice(emitted.length)
          : emitted
            ? ""
            : finalAssistantText;
      if (remainder) {
        await this.handleAssistantDelta({ itemId, delta: remainder }, raw);
      }
      return;
    }
    const event = codexAppServerToolEventFromItem({
      item,
      conversationId: this.callbacks.conversation.id,
      eventId: randomUUID(),
      emitAsUpdate: method !== "item/started",
      status:
        method === "item/completed"
          ? undefined
          : method === "item/updated"
            ? "in_progress"
            : undefined,
    });
    if (event) {
      await this.callbacks.appendEvents([event]);
    }
  }

  private async handleOutputDelta(
    method: string,
    params: CodexAppServerJsonObject,
    raw: CodexAppServerJsonObject
  ): Promise<void> {
    const itemId = asString(params.itemId);
    const text = asString(params.delta) ?? asString(params.text);
    if (!itemId || !text) {
      return;
    }
    await this.callbacks.appendEvents([
      {
        eventId: randomUUID(),
        conversationId: this.callbacks.conversation.id,
        kind: "tool_call_update",
        toolCallId: itemId,
        toolKind: method.includes("commandExecution") ? "terminal" : "edit",
        status: "in_progress",
        detail: text,
        raw,
      },
    ]);
  }

  private async handleTurnCompleted(
    params: CodexAppServerJsonObject,
    raw: CodexAppServerJsonObject
  ): Promise<void> {
    const status = codexAppServerStatusFromTurn(params) ?? { status: "idle" as const };
    const events: AgentEventInput[] = [];
    for (const itemId of this.assistantItemsForTurn) {
      events.push({
        eventId: randomUUID(),
        conversationId: this.callbacks.conversation.id,
        kind: "assistant_message_end",
        messageId: `codex-app-server-${itemId}`,
        stopReason: status.status,
        raw,
      });
    }
    events.push({
      eventId: randomUUID(),
      conversationId: this.callbacks.conversation.id,
      kind: "status",
      status: status.status,
      detail: status.detail,
      raw,
    });
    if (status.status === "failed" && status.detail) {
      events.unshift({
        eventId: randomUUID(),
        conversationId: this.callbacks.conversation.id,
        kind: "system",
        level: "error",
        text: status.detail,
        raw,
      });
    }
    await this.callbacks.appendEvents(events);
    await this.callbacks.updateConversation((current) => ({
      ...current,
      status: turnStatusFromConversationStatus(status.status),
      pendingPermission: null,
      lastError: status.status === "failed" ? status.detail ?? "Codex App Server turn failed." : null,
      providerSessionId: this.sessionId,
    }));
    this.pendingTurn?.resolve();
    this.pendingTurn = null;
  }

  private async handleServerRequestResolved(
    params: CodexAppServerJsonObject,
    raw: CodexAppServerJsonObject
  ): Promise<void> {
    const requestId = asString(params.requestId);
    if (requestId) {
      this.pendingServerRequests.delete(requestId);
      await this.callbacks.appendEvents([
        {
          eventId: randomUUID(),
          conversationId: this.callbacks.conversation.id,
          kind: "permission_resolved",
          requestId,
          outcome: "selected",
          raw,
        },
      ]);
    }
    await this.callbacks.updateConversation((current) => ({
      ...current,
      pendingPermission:
        requestId && current.pendingPermission?.requestId === requestId
          ? null
          : current.pendingPermission,
    }));
  }

  private async handleError(
    params: CodexAppServerJsonObject,
    raw: CodexAppServerJsonObject
  ): Promise<void> {
    const error = asRecord(params.error) ?? params;
    const message = asString(error.message) ?? "Codex App Server emitted an error.";
    await this.callbacks.appendEvents([
      {
        eventId: randomUUID(),
        conversationId: this.callbacks.conversation.id,
        kind: "system",
        level: "error",
        text: message,
        raw,
      },
    ]);
  }

  private async handleLegacyCodexEvent(
    method: string,
    params: CodexAppServerJsonObject,
    raw: CodexAppServerJsonObject
  ): Promise<void> {
    const msg = asRecord(params.msg);
    const type = asString(msg?.type) ?? method.replace(/^codex\/event\//, "");
    const legacyMessageId = `codex-app-server-legacy-${this.pendingTurn?.turnId ?? "turn"}`;
    if (type === "agent_message_delta" || type === "agent_message_content_delta") {
      const text = asString(msg?.delta);
      if (text) {
        this.assistantItemsForTurn.add(legacyMessageId);
        await this.callbacks.appendEvents([
          {
            eventId: randomUUID(),
            conversationId: this.callbacks.conversation.id,
            kind: "assistant_message_chunk",
            messageId: legacyMessageId,
            text,
            raw,
          },
        ]);
      }
      return;
    }
    if (type === "agent_message") {
      const text = asString(msg?.message);
      if (text) {
        this.assistantItemsForTurn.add(legacyMessageId);
        await this.callbacks.appendEvents([
          {
            eventId: randomUUID(),
            conversationId: this.callbacks.conversation.id,
            kind: "assistant_message_chunk",
            messageId: legacyMessageId,
            text,
            raw,
          },
        ]);
      }
      return;
    }
    if (type === "agent_reasoning_delta" || type === "agent_reasoning_raw_content_delta") {
      const text = asString(msg?.delta);
      if (text) {
        await this.callbacks.appendEvents([
          {
            eventId: randomUUID(),
            conversationId: this.callbacks.conversation.id,
            kind: "reasoning",
            messageId: `${legacyMessageId}-reasoning`,
            text,
            raw,
          },
        ]);
      }
      return;
    }
    if (type === "error") {
      const text = asString(msg?.message) ?? "Codex App Server emitted an error.";
      this.lastCodexEventError = text;
      await this.callbacks.appendEvents([
        {
          eventId: randomUUID(),
          conversationId: this.callbacks.conversation.id,
          kind: "system",
          level: "error",
          text,
          raw,
        },
      ]);
      return;
    }
    if (type === "stream_error" || type === "background_event" || type === "warning") {
      const text = asString(msg?.message);
      if (text) {
        await this.callbacks.appendEvents([
          {
            eventId: randomUUID(),
            conversationId: this.callbacks.conversation.id,
            kind: "system",
            level: type === "warning" ? "warning" : "info",
            text,
            raw,
          },
        ]);
      }
      return;
    }
    if (type === "task_complete") {
      const finalText = asString(msg?.last_agent_message);
      if (finalText) {
        this.assistantItemsForTurn.add(legacyMessageId);
        await this.callbacks.appendEvents([
          {
            eventId: randomUUID(),
            conversationId: this.callbacks.conversation.id,
            kind: "assistant_message_chunk",
            messageId: legacyMessageId,
            text: finalText,
            raw,
          },
        ]);
      }
      const failed = Boolean(this.lastCodexEventError);
      const events: AgentEventInput[] = [];
      if (this.assistantItemsForTurn.has(legacyMessageId)) {
        events.push({
          eventId: randomUUID(),
          conversationId: this.callbacks.conversation.id,
          kind: "assistant_message_end",
          messageId: legacyMessageId,
          stopReason: failed ? "failed" : "completed",
          raw,
        });
      }
      events.push({
        eventId: randomUUID(),
        conversationId: this.callbacks.conversation.id,
        kind: "status",
        status: failed ? "failed" : "idle",
        detail: this.lastCodexEventError ?? undefined,
        raw,
      });
      await this.callbacks.appendEvents(events);
      await this.callbacks.updateConversation((current) => ({
        ...current,
        status: failed ? "failed" : "idle",
        pendingPermission: null,
        lastError: this.lastCodexEventError,
        providerSessionId: this.sessionId,
      }));
      this.pendingTurn?.resolve();
      this.pendingTurn = null;
    }
  }

  private async handleServerRequest(message: CodexAppServerRequestMessage): Promise<void> {
    const requestId = String(message.id);
    const event = codexAppServerPermissionRequestFromServerRequest({
      requestId,
      method: message.method,
      params: message.params,
      conversationId: this.callbacks.conversation.id,
      eventId: randomUUID(),
    });
    if (!event) {
      this.transport?.respondError(message.id, -32601, `Unsupported Codex App Server request: ${message.method}`);
      await this.callbacks.appendEvents([
        {
          eventId: randomUUID(),
          conversationId: this.callbacks.conversation.id,
          kind: "system",
          level: "warning",
          text: `Codex App Server requested unsupported client method: ${message.method}`,
          raw: message,
        },
      ]);
      return;
    }
    this.pendingServerRequests.set(requestId, { rpcId: message.id, method: message.method });
    await this.callbacks.appendEvents([
      event,
      {
        eventId: randomUUID(),
        conversationId: this.callbacks.conversation.id,
        kind: "status",
        status: "awaiting_permission",
        detail: event.title,
      },
    ]);
    await this.callbacks.updateConversation((current) => ({
      ...current,
      status: "awaiting_permission",
      pendingPermission: {
        requestId,
        requestedAt: Date.now(),
        toolCallId: event.toolCallId,
        title: event.title,
        detail: event.detail,
        options: event.options,
      },
    }));
  }
}

export function createCodexAppServerProvider(input: {
  backend: AgentBackendInfo;
  runtime: CliRuntimeSpec;
  configOptions: AgentConfigOption[];
}): AgentProvider {
  return {
    backend: input.backend,
    async startSession(callbacks) {
      const handle = new CodexAppServerSessionHandle({
        backend: input.backend,
        runtime: input.runtime,
        callbacks,
        configOptions: input.configOptions,
      });
      await handle.initialize();
      return handle;
    },
    async loadSession(callbacks, providerSessionId) {
      const handle = new CodexAppServerSessionHandle({
        backend: input.backend,
        runtime: input.runtime,
        callbacks,
        configOptions: input.configOptions,
        providerSessionId,
      });
      await handle.initialize();
      return handle;
    },
  };
}
