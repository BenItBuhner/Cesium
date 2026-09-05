import { randomUUID } from "node:crypto";
import { asRecord, asString } from "./json-coerce.js";
import type {
  AgentBackendInfo,
  AgentConfigOption,
  AgentContextUsageSnapshot,
  AgentEventInput,
  AgentProvider,
  AgentProviderCapabilities,
  AgentRuntimeCallbacks,
  AgentSessionHandle,
  AgentStoredEvent,
} from "./types.js";
import type { CliRuntimeSpec } from "./cli-adapter.js";
import {
  CodexAppServerRpcError,
  CodexAppServerTransport,
  type CodexAppServerJsonObject,
  type CodexAppServerRequestMessage,
  type CodexAppServerRpcId,
} from "./codex-app-server-transport.js";
import {
  CODEX_APPROVAL_REQUEST_METHODS,
  CODEX_USER_INPUT_REQUEST_METHODS,
  codexAppServerApprovalResponse,
  codexAppServerAssistantTextFromItem,
  codexAppServerAsyncQuestionsFromItem,
  codexAppServerElicitationFormResponse,
  codexAppServerElicitationQuestion,
  codexAppServerErrorSummary,
  codexAppServerPermissionRequestFromServerRequest,
  codexAppServerPlanEntriesFromTurnPlan,
  codexAppServerPlanTextFromItem,
  codexAppServerReasoningDelta,
  codexAppServerReasoningTextFromItem,
  codexAppServerStatusFromTurn,
  codexAppServerTextDelta,
  codexAppServerTokenUsage,
  codexAppServerToolEventFromItem,
  codexAppServerUserInputRequest,
  codexAppServerUserInputResponse,
  type CodexAppServerElicitationField,
  type CodexAppServerQuestionStep,
  type CodexAppServerUserInputRequest,
} from "./codex-app-server-normalize.js";
import {
  providerPlanEvents,
  writeProviderPlanArtifact,
} from "./plan-artifacts.js";
import { materializeImageAttachments } from "./prompt-attachments.js";
import {
  appendAgentPluginPrompt,
  resolveAgentPluginAttachments,
} from "../plugins/attachments.js";
import type { SdkMcpServerConfig } from "./mcp-export-adapter.js";
import {
  buildRememberedPermissionToolKey,
  persistRememberedPermissionChoice,
  resolveRememberedPermissionDecision,
} from "./remembered-permissions.js";
import { withPersistentPermissionOptions } from "./permission-options.js";

type PendingTurn = {
  turnId: string | null;
  resolve: () => void;
  reject: (error: Error) => void;
};

type PendingServerRequest =
  | {
      kind: "approval";
      rpcId: CodexAppServerRpcId;
      method: string;
      params: CodexAppServerJsonObject | undefined;
      toolKey: string;
      toolLabel: string;
      optionIds: Set<string>;
    }
  | {
      kind: "user_input";
      rpcId: CodexAppServerRpcId;
      method: string;
      params: CodexAppServerJsonObject | undefined;
      questionId: string;
      request: CodexAppServerUserInputRequest;
    }
  | {
      kind: "elicitation_form";
      rpcId: CodexAppServerRpcId;
      method: string;
      params: CodexAppServerJsonObject | undefined;
      questionId: string;
      prompt: string;
      steps: CodexAppServerQuestionStep[];
      fields: CodexAppServerElicitationField[];
    };

type AsyncQuestion = {
  questionId: string;
  prompt: string;
  steps: CodexAppServerQuestionStep[];
};

/**
 * A Codex sub-agent (collab `spawn_agent` / Multi-Agent V2 child). The app
 * server streams child-thread items over the parent's connection; they are
 * folded into a `subagent` card instead of the parent transcript.
 */
type ChildThread = {
  threadId: string;
  title: string;
  /** Codex agent nickname/role, shown as card metadata. */
  meta: string | undefined;
  status: "running" | "completed" | "failed";
  transcript: AgentStoredEvent[];
  seq: number;
  assistantTextByItemId: Map<string, string>;
  reasoningTextByItemId: Map<string, string>;
  lastActivity: string | undefined;
  flushTimer: NodeJS.Timeout | null;
  dirty: boolean;
};

const CHILD_THREAD_FLUSH_MS = 600;

/** How long to wait for `turn/completed` after a terminal signal before settling anyway. */
const TURN_SETTLE_GRACE_MS = (() => {
  const raw = Number.parseInt(process.env.OPENCURSOR_CODEX_APP_SERVER_SETTLE_GRACE_MS ?? "", 10);
  return Number.isFinite(raw) && raw > 0 ? raw : 8_000;
})();
/** How long `cancel()` waits for the interrupted `turn/completed` before moving on. */
const CANCEL_WAIT_MS = 4_000;
/** Bounded wait for the initial handshake so a wedged binary fails fast. */
const HANDSHAKE_TIMEOUT_MS = 45_000;

export const CODEX_APP_SERVER_DEFAULT_MODEL_ID = "__default__";

/**
 * Config-level Codex warnings (missing bubblewrap, unknown model metadata, ...)
 * are re-emitted by every `codex app-server` process. Cesium restarts the
 * process whenever a conversation's runtime is rehydrated, so dedupe per
 * conversation for the lifetime of this server rather than per session.
 */
const MAX_REMEMBERED_WARNING_CONVERSATIONS = 500;
const rememberedWarningsByConversation = new Map<string, Set<string>>();

function rememberedWarningsFor(conversationId: string): Set<string> {
  const existing = rememberedWarningsByConversation.get(conversationId);
  if (existing) {
    return existing;
  }
  if (rememberedWarningsByConversation.size >= MAX_REMEMBERED_WARNING_CONVERSATIONS) {
    const oldest = rememberedWarningsByConversation.keys().next().value;
    if (oldest) {
      rememberedWarningsByConversation.delete(oldest);
    }
  }
  const created = new Set<string>();
  rememberedWarningsByConversation.set(conversationId, created);
  return created;
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

function isExplicitModel(model: string | undefined): model is string {
  return Boolean(model && model !== CODEX_APP_SERVER_DEFAULT_MODEL_ID && model !== "auto");
}

/**
 * Picks the reasoning effort to send for a turn. Efforts are validated against
 * the catalog entry for the model so an unsupported value never reaches a
 * provider; unknown (custom-provider) models fall back to the server default.
 */
export function resolveCodexModelEffort(
  options: AgentConfigOption[],
  model: string | undefined,
  requestedEffort: string | undefined
): string | undefined {
  const modelOption = options.find((option) => option.id === "model");
  const modelValue = modelOption?.options.find((option) => option.value === model);
  const supported = modelValue?.metadata?.reasoningLevels;
  if (!Array.isArray(supported) || supported.length === 0) {
    return undefined;
  }
  if (requestedEffort && supported.includes(requestedEffort)) {
    return requestedEffort;
  }
  const defaultEffort = modelValue?.metadata?.defaultReasoningEffort;
  if (typeof defaultEffort === "string" && supported.includes(defaultEffort)) {
    return defaultEffort;
  }
  return undefined;
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

function bypassAllowed(): boolean {
  return process.env.OPENCURSOR_CODEX_APP_SERVER_ALLOW_BYPASS === "1";
}

/**
 * Cesium "Execution Mode" → Codex `SandboxPolicy` (v2 wire shape). Plan/ask
 * modes are read-only regardless of the selected execution mode so planning
 * never mutates the workspace.
 */
export function sandboxPolicyForPermission(
  permission: string,
  workspaceRoot: string,
  mode?: string
): CodexAppServerJsonObject {
  if (permission === "bypassPermissions" && bypassAllowed()) {
    return { type: "dangerFullAccess" };
  }
  if (
    mode === "plan" ||
    mode === "ask" ||
    permission === "read-only" ||
    permission === "readonly" ||
    permission === "ask"
  ) {
    return { type: "readOnly", networkAccess: true };
  }
  return {
    type: "workspaceWrite",
    writableRoots: [workspaceRoot],
    networkAccess: true,
    excludeTmpdirEnvVar: false,
    excludeSlashTmp: false,
  };
}

/** `thread/start.sandbox` takes the coarse `SandboxMode` string instead. */
export function sandboxModeForPermission(permission: string, mode?: string): string {
  const policy = sandboxPolicyForPermission(permission, "/", mode);
  switch (policy.type) {
    case "dangerFullAccess":
      return "danger-full-access";
    case "readOnly":
      return "read-only";
    default:
      return "workspace-write";
  }
}

/**
 * Cesium "Execution Mode" → Codex `AskForApproval`. Codex 0.150+ accepts
 * `untrusted | on-request | never | { granular }` (`on-failure` was removed).
 */
export function approvalPolicyForPermission(permission: string): string {
  if (permission === "bypassPermissions" && bypassAllowed()) {
    return "never";
  }
  if (permission === "on-request" || permission === "ask") {
    // "Ask Every Time": prompt for anything that is not a trusted read-only command.
    return "untrusted";
  }
  return "on-request";
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

/** Cesium plugin/builtin MCP servers → Codex `mcp_servers` config overrides. */
export function codexMcpServerConfigFromSdk(
  servers: Record<string, SdkMcpServerConfig>
): { config: Record<string, CodexAppServerJsonObject>; skipped: string[] } {
  const config: Record<string, CodexAppServerJsonObject> = {};
  const skipped: string[] = [];
  for (const [rawName, server] of Object.entries(servers)) {
    const name = rawName.replace(/[^A-Za-z0-9_-]/g, "_").slice(0, 64);
    if (!name) {
      skipped.push(rawName);
      continue;
    }
    if (server.type === "stdio") {
      config[name] = {
        command: server.command,
        args: server.args ?? [],
        ...(server.env && Object.keys(server.env).length > 0 ? { env: server.env } : {}),
        ...(server.cwd ? { cwd: server.cwd } : {}),
      };
      continue;
    }
    if (server.type === "http" || server.type === "sse") {
      config[name] = {
        url: server.url,
        ...(server.headers && Object.keys(server.headers).length > 0 ? { http_headers: server.headers } : {}),
      };
      continue;
    }
    skipped.push(rawName);
  }
  return { config, skipped };
}

/**
 * Codex reports cumulative (`total`) and most-recent-turn (`last`) usage. The
 * context window fill is the last turn's prompt + completion minus reasoning
 * tokens (which are not carried forward), mirroring Codex's own
 * `tokens_in_context_window` accounting.
 */
export function contextUsageFromTokenUsage(params: CodexAppServerJsonObject): AgentContextUsageSnapshot | null {
  const usage = codexAppServerTokenUsage(params);
  if (!usage) {
    return null;
  }
  const window = usage.last ?? usage.total;
  const limitTokens = usage.modelContextWindow ?? 0;
  const usedTokens = Math.max(0, window.totalTokens - window.reasoningOutputTokens);
  const percentFull = limitTokens > 0 ? Math.min(100, Math.round((usedTokens / limitTokens) * 1000) / 10) : 0;
  const cached = Math.min(window.cachedInputTokens, usedTokens);
  return {
    supported: true,
    limitTokens,
    usedTokens,
    percentFull,
    approximate: limitTokens === 0,
    categories: [
      {
        id: "conversation",
        label: "Conversation",
        tokens: Math.max(0, usedTokens - cached),
        colorKey: "conversation",
      },
      ...(cached > 0
        ? [
            {
              id: "summarized_conversation" as const,
              label: "Cached input",
              tokens: cached,
              colorKey: "summarized",
            },
          ]
        : []),
    ],
  };
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
  private threadModel: string | null = null;
  private threadModelProvider: string | null = null;
  private threadReasoningEffort: string | null = null;
  /** Collaboration mode the thread is currently in (sticky across turns server-side). */
  private activeCollaborationMode: "plan" | "default" = "default";
  private pendingTurn: PendingTurn | null = null;
  private cancelRequested = false;
  private turnSettleTimer: NodeJS.Timeout | null = null;
  private readonly assistantTextByItemId = new Map<string, string>();
  private readonly assistantItemsForTurn = new Set<string>();
  private readonly reasoningTextByItemId = new Map<string, string>();
  private readonly planTextByItemId = new Map<string, string>();
  private readonly pendingServerRequests = new Map<string, PendingServerRequest>();
  private readonly pendingQuestionRequestIds = new Map<string, string>();
  private readonly asyncQuestions = new Map<string, AsyncQuestion>();
  private readonly childThreads = new Map<string, ChildThread>();
  /** Latest title/detail per tool item so approval cards can describe the pending action. */
  private readonly toolItemSummaries = new Map<string, { title: string; detail?: string }>();
  private readonly emittedWarnings = new Set<string>();
  private lastTurnErrorText: string | null = null;
  private lastCodexEventError: string | null = null;
  /**
   * Inbound messages are processed strictly in wire order. Handlers await
   * storage writes, so without serialization a fast `turn/completed` could be
   * persisted before the `item/completed` that precedes it.
   */
  private inboundQueue: Promise<void> = Promise.resolve();
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
    await transport.request(
      "initialize",
      {
        clientInfo: {
          name: process.env.CODEX_APP_SERVER_CLIENT_NAME?.trim() || "cesium_codex_app_server",
          title: "Cesium Codex App Server",
          version: "0.2.0",
        },
        capabilities: {
          experimentalApi: true,
          // Cesium renders elicitation forms itself (questions/approval cards).
          extensions: { "openai/elicitation": { form: {} }, "openai/form": {} },
        },
      },
      { timeoutMs: HANDSHAKE_TIMEOUT_MS }
    );
    transport.notify("initialized");

    if (this.threadId && !(await this.storedThreadHasTurns())) {
      // Nothing was ever sent on the stored thread; Codex has no rollout to
      // resume, so start over quietly.
      this.threadId = null;
    }
    if (this.threadId) {
      const previousThreadId = this.threadId;
      try {
        await this.resumeThread();
      } catch (error) {
        const reason = error instanceof Error ? error.message : String(error);
        this.threadId = null;
        await this.startThread();
        await this.appendSystem(
          "warning",
          isCodexThreadNotFoundError(error)
            ? `Codex no longer has thread ${previousThreadId} on disk; started a fresh thread. Earlier turns stay in this chat, but Codex will not remember them.`
            : `Could not resume Codex thread ${previousThreadId} (${reason}); started a fresh thread. Earlier turns stay in this chat, but Codex will not remember them.`
        );
      }
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
    this.resetTurnState();
    const model = this.resolvedModel();
    const requestedEffort =
      currentValueFor(this.configOptions, "model_reasoning_effort") ||
      currentValueFor(this.configOptions, "effort");
    const effort = resolveCodexModelEffort(this.configOptions, model, requestedEffort);
    const permission = currentValueFor(this.configOptions, "permission") || "workspace-write";
    const mode = currentValueFor(this.configOptions, "mode") || this.callbacks.conversation.config.mode || "agent";
    const imageAttachments = await materializeImageAttachments(
      input.attachments,
      "codex-app-server"
    );
    const pluginAttachments = await resolveAgentPluginAttachments({
      workspaceId: this.callbacks.workspace.id,
      workspaceRoot: this.callbacks.workspace.root,
      backendId: "codex-app-server",
    });
    const promptText = appendAgentPluginPrompt(input.text, pluginAttachments);
    const turnParams: CodexAppServerJsonObject = {
      threadId: this.threadId,
      clientUserMessageId: input.userMessageId,
      input: [
        { type: "text", text: promptText },
        ...imageAttachments.paths.map((path) => ({ type: "localImage", path })),
      ],
      cwd: this.callbacks.workspace.root,
      approvalPolicy: approvalPolicyForPermission(permission),
      sandboxPolicy: sandboxPolicyForPermission(permission, this.callbacks.workspace.root, mode),
    };
    if (isExplicitModel(model)) {
      turnParams.model = model;
    }
    if (effort) {
      turnParams.effort = effort;
    }
    // Collaboration mode is sticky on the thread, so only send it when the
    // Cesium mode actually changes (plan ⇄ default). `settings.model` is
    // required by the schema; fall back to the thread's resolved model.
    const wantedCollaborationMode: "plan" | "default" = mode === "plan" ? "plan" : "default";
    if (wantedCollaborationMode !== this.activeCollaborationMode) {
      const settingsModel = isExplicitModel(model) ? model : this.threadModel;
      if (settingsModel) {
        turnParams.collaborationMode = {
          mode: wantedCollaborationMode,
          settings: {
            model: settingsModel,
            reasoning_effort: effort ?? this.threadReasoningEffort ?? null,
          },
        };
      }
    }

    await this.callbacks.updateConversation((current) => ({
      ...current,
      status: "running",
      pendingPermission: null,
      pendingQuestion: null,
      lastError: null,
      providerSessionId: this.sessionId,
      capabilities: this.capabilities,
      configOptions: this.configOptions,
    }));

    try {
      const turnPromise = new Promise<void>((resolve, reject) => {
        this.pendingTurn = { turnId: null, resolve, reject };
      });
      let result: CodexAppServerJsonObject;
      try {
        result = (await this.transport.request("turn/start", turnParams)) as CodexAppServerJsonObject;
      } catch (error) {
        this.pendingTurn = null;
        throw error;
      }
      const turn = asRecord(result.turn);
      const turnId = asString(turn?.id) ?? null;
      if (this.pendingTurn && !this.pendingTurn.turnId) {
        this.pendingTurn.turnId = turnId;
      }
      if (turnParams.collaborationMode) {
        this.activeCollaborationMode = wantedCollaborationMode;
      }
      await turnPromise;
    } finally {
      await imageAttachments.cleanup();
    }
  }

  async cancel(): Promise<void> {
    if (!this.pendingTurn && this.pendingServerRequests.size === 0) {
      // Nothing in flight (the turn already settled); leave the recorded
      // terminal state alone instead of overwriting it with "cancelled".
      return;
    }
    this.cancelRequested = true;
    const transport = this.transport;
    const turnId = this.pendingTurn?.turnId;
    if (transport && this.threadId && turnId) {
      const completed = new Promise<void>((resolve) => {
        const pending = this.pendingTurn;
        if (!pending) {
          resolve();
          return;
        }
        const originalResolve = pending.resolve;
        const originalReject = pending.reject;
        pending.resolve = () => {
          originalResolve();
          resolve();
        };
        pending.reject = (error) => {
          originalReject(error);
          resolve();
        };
      });
      await transport
        .request("turn/interrupt", { threadId: this.threadId, turnId }, { timeoutMs: CANCEL_WAIT_MS })
        .catch(() => undefined);
      await Promise.race([
        completed,
        new Promise<void>((resolve) => setTimeout(resolve, CANCEL_WAIT_MS)),
      ]);
    }
    await this.clearPendingServerRequests("cancelled");
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
      pendingQuestion: null,
    }));
    this.settlePendingTurn();
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
    if (!pending || pending.kind !== "approval" || !this.transport) {
      return;
    }
    this.pendingServerRequests.delete(input.requestId);
    let providerOptionId = input.optionId;
    // Cesium-side "Always allow/reject" options persist a remembered rule and
    // translate to the matching one-shot Codex decision.
    if (!input.cancelled && (input.optionId === "allow_always" || input.optionId === "reject_always")) {
      await persistRememberedPermissionChoice({
        workspaceId: this.callbacks.workspace.id,
        backendId: this.backend.id,
        toolKey: pending.toolKey,
        toolLabel: pending.toolLabel,
        optionId: input.optionId,
        optionKind: input.optionId,
      });
      providerOptionId = input.optionId === "allow_always" ? "accept" : "decline";
    }
    if (providerOptionId && !pending.optionIds.has(providerOptionId) && !input.cancelled) {
      // Unknown option ids (stale UI, mismatched client) must never be forwarded
      // as a decision the server would reject; fall back to a safe decline.
      providerOptionId = pending.optionIds.has("decline") ? "decline" : "cancel";
    }
    const response = codexAppServerApprovalResponse({
      method: pending.method,
      params: pending.params,
      optionId: providerOptionId,
      cancelled: input.cancelled,
    });
    this.transport.respond(pending.rpcId, response);
    await this.callbacks.appendEvents([
      {
        eventId: randomUUID(),
        conversationId: this.callbacks.conversation.id,
        kind: "permission_resolved",
        requestId: input.requestId,
        outcome: input.cancelled ? "cancelled" : "selected",
        optionId: input.optionId,
        raw: { response },
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
      pendingPermission:
        current.pendingPermission?.requestId === input.requestId ? null : current.pendingPermission,
    }));
  }

  async answerQuestion(input: { questionId: string; answer: string }): Promise<void> {
    const requestId = this.pendingQuestionRequestIds.get(input.questionId);
    const pending = requestId ? this.pendingServerRequests.get(requestId) : undefined;
    if (pending && this.transport && pending.kind !== "approval") {
      this.pendingServerRequests.delete(requestId!);
      this.pendingQuestionRequestIds.delete(input.questionId);
      const response =
        pending.kind === "user_input"
          ? codexAppServerUserInputResponse({ request: pending.request, answer: input.answer })
          : codexAppServerElicitationFormResponse({
              fields: pending.fields,
              steps: pending.steps,
              answer: input.answer,
            });
      this.transport.respond(pending.rpcId, response);
      const steps = pending.kind === "user_input" ? pending.request.steps : pending.steps;
      const prompt = pending.kind === "user_input" ? pending.request.prompt : pending.prompt;
      await this.callbacks.appendEvents([
        {
          eventId: randomUUID(),
          conversationId: this.callbacks.conversation.id,
          kind: "question",
          questionId: input.questionId,
          prompt,
          options: steps[0]?.options ?? [],
          questions: steps,
          allowMultiple: false,
          status: "answered",
          answer: input.answer,
          raw: { response },
        },
        {
          eventId: randomUUID(),
          conversationId: this.callbacks.conversation.id,
          kind: "status",
          status: "running",
          detail: "Question answered.",
        },
      ]);
      await this.callbacks.updateConversation((current) => ({
        ...current,
        status: "running",
        pendingQuestion:
          current.pendingQuestion?.questionId === input.questionId ? null : current.pendingQuestion,
      }));
      return;
    }
    const asyncQuestion = this.asyncQuestions.get(input.questionId);
    if (asyncQuestion) {
      // Inline (async) questions are answered with an ordinary follow-up turn.
      this.asyncQuestions.delete(input.questionId);
      await this.callbacks.appendEvents([
        {
          eventId: randomUUID(),
          conversationId: this.callbacks.conversation.id,
          kind: "question",
          questionId: input.questionId,
          prompt: asyncQuestion.prompt,
          options: asyncQuestion.steps[0]?.options ?? [],
          questions: asyncQuestion.steps,
          allowMultiple: false,
          status: "answered",
          answer: input.answer,
        },
      ]);
      await this.callbacks.updateConversation((current) => ({
        ...current,
        pendingQuestion:
          current.pendingQuestion?.questionId === input.questionId ? null : current.pendingQuestion,
        status: current.status === "awaiting_question" ? "idle" : current.status,
      }));
      if (this.pendingTurn?.turnId && this.transport && this.threadId) {
        await this.transport
          .request("turn/steer", {
            threadId: this.threadId,
            expectedTurnId: this.pendingTurn.turnId,
            input: [{ type: "text", text: input.answer }],
          })
          .catch(async () => {
            await this.prompt({ text: input.answer, userMessageId: randomUUID() });
          });
        return;
      }
      await this.prompt({ text: input.answer, userMessageId: randomUUID() });
    }
  }

  async dispose(): Promise<void> {
    this.disposed = true;
    this.clearTurnSettleTimer();
    for (const child of this.childThreads.values()) {
      if (child.flushTimer) {
        clearTimeout(child.flushTimer);
        child.flushTimer = null;
      }
    }
    if (this.transport && this.threadId && !this.transport.isDisposed) {
      await this.transport
        .request("thread/unsubscribe", { threadId: this.threadId }, { timeoutMs: 3_000 })
        .catch(() => undefined);
    }
    this.transport?.dispose();
    this.transport = null;
    this.settlePendingTurn(new Error("Codex App Server session disposed."));
  }

  // ---------------------------------------------------------------------------
  // Transport / thread lifecycle
  // ---------------------------------------------------------------------------

  private createTransport(): CodexAppServerTransport {
    return new CodexAppServerTransport({
      command: this.runtime.command,
      args: [...this.runtime.args, "app-server"],
      cwd: this.callbacks.workspace.root,
      env: this.runtime.env,
      processName: "Cesium Agent - Codex App Server",
      onNotification: (message) => {
        this.enqueueInbound(async () => {
          try {
            await this.handleNotification(message);
          } catch (error) {
            await this.appendSystem(
              "warning",
              `Failed to process Codex App Server notification ${asString(message.method) ?? ""}: ${
                error instanceof Error ? error.message : String(error)
              }`
            );
          }
        });
      },
      onServerRequest: (message) => {
        this.enqueueInbound(async () => {
          try {
            await this.handleServerRequest(message);
          } catch (error) {
            this.transport?.respondError(message.id, -32603, "Cesium failed to handle the request.");
            await this.appendSystem(
              "warning",
              `Failed to handle Codex App Server request ${message.method}: ${
                error instanceof Error ? error.message : String(error)
              }`
            );
          }
        });
      },
      onStderrLine: (line) => {
        void this.handleStderrLine(line);
      },
      onExit: () => {
        if (!this.disposed) {
          this.callbacks.markRuntimeStale?.();
          void this.clearPendingServerRequests("cancelled");
          this.settlePendingTurn(new Error("Codex App Server transport exited during a turn."));
        }
      },
    });
  }

  private enqueueInbound(task: () => Promise<void>): void {
    this.inboundQueue = this.inboundQueue.then(task, task);
  }

  private async handleStderrLine(line: string): Promise<void> {
    if (/codex_core::(?:exec|tools::router):/i.test(line)) {
      return;
    }
    // MCP transport teardown chatter; the structured
    // `mcpServer/startupStatus/updated` notification already reports failures.
    if (/worker quit with fatal: Transport channel closed/i.test(line) || /codex_rmcp_client/i.test(line)) {
      return;
    }
    // tracing prefix: `2026-09-05T04:57:54.540597Z ERROR codex_app_server: message`
    const tracing = /^\d{4}-\d{2}-\d{2}T[\d:.]+Z?\s+(TRACE|DEBUG|INFO|WARN|WARNING|ERROR)\s+[\w:]+:\s*(.*)$/i.exec(line);
    const level = tracing?.[1]?.toUpperCase();
    if (level === "TRACE" || level === "DEBUG" || level === "INFO") {
      return;
    }
    const stripped = (tracing?.[2] ?? line).trim();
    if (!stripped || !this.rememberWarning(stripped)) {
      return;
    }
    await this.appendSystem("warning", `[${this.backend.label}] ${stripped}`);
  }

  /**
   * Dedupes identical warning text for this conversation (Codex mirrors many
   * warnings on stderr and repeats config warnings on every process start).
   */
  private rememberWarning(text: string): boolean {
    const key = text.trim().toLowerCase();
    if (!key || this.emittedWarnings.has(key)) {
      return false;
    }
    const perConversation = rememberedWarningsFor(this.callbacks.conversation.id);
    if (perConversation.has(key)) {
      return false;
    }
    this.emittedWarnings.add(key);
    perConversation.add(key);
    if (perConversation.size > 200) {
      const first = perConversation.values().next().value;
      if (first) {
        perConversation.delete(first);
      }
    }
    return true;
  }

  /**
   * Codex only writes a rollout after the first turn, so a thread that never
   * ran cannot be resumed; starting fresh loses nothing in that case.
   */
  private async storedThreadHasTurns(): Promise<boolean> {
    try {
      const snapshot = await this.callbacks.readSnapshot();
      if (!snapshot) {
        return true;
      }
      return snapshot.events.some((event) => event.kind === "user_message");
    } catch {
      return true;
    }
  }

  private async appendSystem(level: "info" | "warning" | "error", text: string, raw?: unknown): Promise<void> {
    await this.callbacks.appendEvents([
      {
        eventId: randomUUID(),
        conversationId: this.callbacks.conversation.id,
        kind: "system",
        level,
        text,
        raw,
      },
    ]);
  }

  /**
   * `__default__` (the backend default) intentionally resolves to "no model
   * param" so Codex applies its own config.toml `model`/`model_provider`;
   * forcing the catalog default onto a custom provider fails every turn.
   */
  private resolvedModel(): string | undefined {
    return this.callbacks.conversation.config.modelId || currentValueFor(this.configOptions, "model");
  }

  private resetTurnState(): void {
    this.assistantItemsForTurn.clear();
    this.assistantTextByItemId.clear();
    this.reasoningTextByItemId.clear();
    this.planTextByItemId.clear();
    this.lastCodexEventError = null;
    this.lastTurnErrorText = null;
    this.cancelRequested = false;
    this.clearTurnSettleTimer();
  }

  private settlePendingTurn(error?: Error): void {
    this.clearTurnSettleTimer();
    const pending = this.pendingTurn;
    if (!pending) {
      return;
    }
    this.pendingTurn = null;
    if (error) {
      pending.reject(error);
      return;
    }
    pending.resolve();
  }

  private clearTurnSettleTimer(): void {
    if (this.turnSettleTimer) {
      clearTimeout(this.turnSettleTimer);
      this.turnSettleTimer = null;
    }
  }

  /**
   * `turn/completed` is the authoritative terminal event, but if the server
   * signalled a terminal thread state and never follows up, settle anyway so
   * the conversation does not hang in `running` forever.
   */
  private armTurnSettleFallback(status: "idle" | "failed"): void {
    if (!this.pendingTurn || this.turnSettleTimer) {
      return;
    }
    this.turnSettleTimer = setTimeout(() => {
      this.turnSettleTimer = null;
      if (!this.pendingTurn) {
        return;
      }
      void this.finishTurn(
        {
          status,
          detail:
            status === "failed"
              ? this.lastTurnErrorText ?? "Codex App Server reported a system error."
              : undefined,
        },
        { method: "cesium/turnSettleFallback" }
      );
    }, TURN_SETTLE_GRACE_MS);
  }

  private async startThread(): Promise<void> {
    if (!this.transport) {
      throw new Error("Codex App Server transport is not initialized.");
    }
    const model = this.resolvedModel();
    const permission = currentValueFor(this.configOptions, "permission") || "workspace-write";
    const mode = currentValueFor(this.configOptions, "mode") || this.callbacks.conversation.config.mode || "agent";
    const params: CodexAppServerJsonObject = {
      cwd: this.callbacks.workspace.root,
      ...(isExplicitModel(model) ? { model } : {}),
      serviceName: "cesium_codex_app_server",
      approvalPolicy: approvalPolicyForPermission(permission),
      sandbox: sandboxModeForPermission(permission, mode),
    };
    const config = await this.threadConfigOverrides();
    if (Object.keys(config).length > 0) {
      params.config = config;
    }
    const result = (await this.transport.request("thread/start", params, {
      timeoutMs: HANDSHAKE_TIMEOUT_MS,
    })) as CodexAppServerJsonObject;
    await this.applyThreadResult(result);
  }

  private async resumeThread(): Promise<void> {
    if (!this.transport || !this.threadId) {
      throw new Error("Codex App Server transport is not initialized.");
    }
    const permission = currentValueFor(this.configOptions, "permission") || "workspace-write";
    const mode = currentValueFor(this.configOptions, "mode") || this.callbacks.conversation.config.mode || "agent";
    const params: CodexAppServerJsonObject = {
      threadId: this.threadId,
      cwd: this.callbacks.workspace.root,
      // Cesium keeps its own transcript; hydrating `thread.turns` is deprecated
      // for paginated threads and only adds payload.
      excludeTurns: true,
      approvalPolicy: approvalPolicyForPermission(permission),
      sandbox: sandboxModeForPermission(permission, mode),
    };
    const model = this.resolvedModel();
    if (isExplicitModel(model)) {
      params.model = model;
    }
    const config = await this.threadConfigOverrides();
    if (Object.keys(config).length > 0) {
      params.config = config;
    }
    const result = (await this.transport.request("thread/resume", params, {
      timeoutMs: HANDSHAKE_TIMEOUT_MS,
    })) as CodexAppServerJsonObject;
    await this.applyThreadResult(result);
  }

  /** Per-thread config.toml overrides: plugin MCP servers and opt-in features. */
  private async threadConfigOverrides(): Promise<CodexAppServerJsonObject> {
    const config: CodexAppServerJsonObject = {};
    try {
      const pluginAttachments = await resolveAgentPluginAttachments({
        workspaceId: this.callbacks.workspace.id,
        workspaceRoot: this.callbacks.workspace.root,
        backendId: "codex-app-server",
      });
      const mcp = codexMcpServerConfigFromSdk(pluginAttachments.sdkMcp.servers);
      if (Object.keys(mcp.config).length > 0) {
        config.mcp_servers = mcp.config;
      }
      if (mcp.skipped.length > 0) {
        await this.appendSystem(
          "warning",
          `Skipped MCP servers Codex cannot connect to: ${mcp.skipped.join(", ")}.`
        );
      }
    } catch (error) {
      await this.appendSystem(
        "warning",
        `Could not attach Cesium MCP servers to Codex: ${error instanceof Error ? error.message : String(error)}`
      );
    }
    if (process.env.OPENCURSOR_CODEX_APP_SERVER_ASK_IN_AGENT_MODE === "1") {
      config.features = { default_mode_request_user_input: true };
    }
    return config;
  }

  private async applyThreadResult(result: CodexAppServerJsonObject): Promise<void> {
    const thread = asRecord(result.thread);
    const id = asString(thread?.id);
    if (!id) {
      throw new Error("Codex App Server did not return a thread id.");
    }
    this.threadId = id;
    this.sessionId = id;
    this.threadModel = asString(result.model) ?? asString(thread?.model) ?? null;
    this.threadModelProvider = asString(result.modelProvider) ?? asString(thread?.modelProvider) ?? null;
    this.threadReasoningEffort = asString(result.reasoningEffort) ?? asString(thread?.reasoningEffort) ?? null;
    // Fresh and resumed threads start in the default collaboration mode.
    this.activeCollaborationMode = "default";
    const threadModel = this.threadModel;
    if (threadModel) {
      const providerSuffix =
        this.threadModelProvider && this.threadModelProvider !== "openai"
          ? ` (${this.threadModelProvider})`
          : "";
      const threadModelValue = { value: threadModel, name: `${threadModel}${providerSuffix}` };
      const hasModelOption = this.configOptions.some((option) => option.id === "model");
      this.configOptions = hasModelOption
        ? this.configOptions.map((option) => {
            if (option.id !== "model" || option.options.some((candidate) => candidate.value === threadModel)) {
              return option;
            }
            return { ...option, options: [threadModelValue, ...option.options] };
          })
        : [
            ...this.configOptions,
            {
              id: "model",
              name: "Model",
              category: "model",
              currentValue: threadModel,
              description: "Model resolved by the Codex App Server for this thread.",
              options: [threadModelValue],
            },
          ];
    }
    await this.callbacks.updateConversation((current) => ({
      ...current,
      providerSessionId: id,
      capabilities: this.capabilities,
      configOptions: this.configOptions,
      config:
        threadModel && !isExplicitModel(current.config.modelId)
          ? { ...current.config, modelName: `Default (${threadModel})` }
          : current.config,
      status: current.status === "running" ? current.status : "idle",
      pendingPermission: null,
      pendingQuestion: null,
      lastError: null,
    }));
  }

  // ---------------------------------------------------------------------------
  // Notifications
  // ---------------------------------------------------------------------------

  private async handleNotification(message: CodexAppServerJsonObject): Promise<void> {
    const method = asString(message.method);
    const params = asRecord(message.params) ?? {};
    if (!method) {
      return;
    }
    const notificationThreadId =
      asString(params.threadId) ?? asString(asRecord(params.thread)?.id) ?? null;
    if (notificationThreadId && this.threadId && notificationThreadId !== this.threadId) {
      await this.handleChildThreadNotification(notificationThreadId, method, params, message);
      return;
    }
    switch (method) {
      case "turn/started":
        this.handleTurnStarted(params);
        return;
      case "item/agentMessage/delta":
        await this.handleAssistantDelta(params, message);
        return;
      case "item/plan/delta":
        await this.handlePlanDelta(params, message);
        return;
      case "item/reasoning/summaryTextDelta":
      case "item/reasoning/textDelta":
        await this.handleReasoningDelta(params, message);
        return;
      case "item/reasoning/summaryPartAdded":
        await this.handleReasoningPartBoundary(params, message);
        return;
      case "turn/plan/updated":
        await this.handlePlanUpdated(params, message);
        return;
      case "item/started":
      case "item/updated":
      case "item/completed":
        await this.handleItemLifecycle(method, params, message);
        return;
      case "item/commandExecution/outputDelta":
      case "item/fileChange/outputDelta":
        await this.handleOutputDelta(method, params, message);
        return;
      case "item/commandExecution/terminalInteraction":
        await this.handleTerminalInteraction(params, message);
        return;
      case "item/fileChange/patchUpdated":
        await this.handlePatchUpdated(params, message);
        return;
      case "item/mcpToolCall/progress":
        await this.handleMcpProgress(params, message);
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
      case "thread/status/changed":
        await this.handleThreadStatusChanged(params);
        return;
      case "thread/tokenUsage/updated":
        await this.handleTokenUsage(params);
        return;
      case "thread/compacted":
        await this.appendSystem("info", "Codex compacted the conversation context.", message);
        return;
      case "model/rerouted": {
        const from = asString(params.fromModel);
        const to = asString(params.toModel);
        const reason = asString(params.reason);
        await this.appendSystem(
          "info",
          `Codex rerouted this turn from ${from ?? "the selected model"} to ${to ?? "another model"}${reason ? ` (${reason})` : ""}.`,
          message
        );
        return;
      }
      case "warning":
      case "guardianWarning": {
        const text = asString(params.message);
        if (text && this.rememberWarning(text)) {
          await this.appendSystem("warning", text, message);
        }
        return;
      }
      case "configWarning":
      case "deprecationNotice": {
        const summary = asString(params.summary);
        const details = asString(params.details);
        const path = asString(params.path);
        const text = [summary, details, path ? `(${path})` : undefined].filter(Boolean).join(" ");
        if (text && this.rememberWarning(text)) {
          await this.appendSystem(method === "deprecationNotice" ? "info" : "warning", text, message);
        }
        return;
      }
      case "mcpServer/startupStatus/updated": {
        const status = asString(params.status);
        const name = asString(params.name) ?? "MCP server";
        if (status === "failed") {
          const error = asString(params.error);
          const reason = asString(params.failureReason);
          const text =
            reason === "reauthenticationRequired"
              ? `MCP server ${name} needs to be reconnected (stored credentials expired).`
              : `MCP server ${name} failed to start${error ? `: ${error}` : "."}`;
          if (this.rememberWarning(text)) {
            await this.appendSystem("warning", text, message);
          }
        }
        return;
      }
      case "account/rateLimits/updated": {
        const limits = asRecord(params.rateLimits);
        const reached = asString(limits?.rateLimitReachedType);
        if (reached && this.rememberWarning(`ratelimit:${reached}`)) {
          await this.appendSystem("warning", `Codex rate limit reached (${reached}).`, message);
        }
        return;
      }
      case "thread/name/updated":
      case "thread/started":
      case "thread/closed":
      case "thread/settings/updated":
      case "turn/diff/updated":
      case "item/autoApprovalReview/started":
      case "item/autoApprovalReview/completed":
      case "autoApprovalReview/strictReviewRequired":
      case "hook/started":
      case "hook/completed":
      case "remoteControl/status/changed":
      case "account/updated":
      case "app/list/updated":
      case "skills/changed":
      case "fs/changed":
      case "project/changed":
      case "thread/project/updated":
      case "thread/environment/connected":
      case "thread/environment/disconnected":
      case "thread/queue/changed":
      case "thread/goal/updated":
      case "thread/goal/cleared":
      case "model/safetyBuffering/updated":
      case "model/verification":
      case "turn/moderationMetadata":
      case "modelProvider/authRecoveryStarted":
      case "modelProvider/authRecoveryCompleted":
        return;
      default:
        if (method.startsWith("codex/event/")) {
          await this.handleLegacyCodexEvent(method, params, message);
          return;
        }
        return;
    }
  }

  // ---------------------------------------------------------------------------
  // Sub-agent (child thread) routing
  // ---------------------------------------------------------------------------

  private childThread(threadId: string, hint?: { title?: string; meta?: string }): ChildThread {
    const existing = this.childThreads.get(threadId);
    if (existing) {
      if (hint?.title && (existing.title === "Subagent" || !existing.title)) {
        existing.title = hint.title;
      }
      if (hint?.meta && !existing.meta) {
        existing.meta = hint.meta;
      }
      return existing;
    }
    const created: ChildThread = {
      threadId,
      title: hint?.title ?? "Subagent",
      meta: hint?.meta,
      status: "running",
      transcript: [],
      seq: 0,
      assistantTextByItemId: new Map(),
      reasoningTextByItemId: new Map(),
      lastActivity: undefined,
      flushTimer: null,
      dirty: false,
    };
    this.childThreads.set(threadId, created);
    return created;
  }

  private pushChildRow(child: ChildThread, row: AgentEventInput): void {
    child.seq += 1;
    child.transcript.push({ ...row, seq: child.seq, createdAt: Date.now() } as AgentStoredEvent);
    child.dirty = true;
  }

  private scheduleChildFlush(child: ChildThread, immediate = false): void {
    if (immediate) {
      if (child.flushTimer) {
        clearTimeout(child.flushTimer);
        child.flushTimer = null;
      }
      void this.flushChild(child);
      return;
    }
    if (child.flushTimer) {
      return;
    }
    child.flushTimer = setTimeout(() => {
      child.flushTimer = null;
      void this.flushChild(child);
    }, CHILD_THREAD_FLUSH_MS);
  }

  private async flushChild(child: ChildThread): Promise<void> {
    if (!child.dirty || this.disposed) {
      return;
    }
    child.dirty = false;
    await this.callbacks.appendEvents([
      {
        eventId: randomUUID(),
        conversationId: this.callbacks.conversation.id,
        kind: "subagent",
        subagentId: child.threadId,
        title: child.title,
        meta: child.meta,
        status: child.status,
        transcript: [...child.transcript],
        recentActivity: child.lastActivity,
        raw: { codexThreadId: child.threadId, parentThreadId: this.threadId },
      },
    ]);
  }

  /** Registers children announced by the parent's collab tool calls (title from the prompt). */
  private noteCollabSpawn(item: CodexAppServerJsonObject): void {
    const tool = asString(item.tool);
    if (tool !== "spawnAgent" && tool !== "spawn_agent" && tool !== "resumeAgent" && tool !== "resume_agent") {
      return;
    }
    const prompt = asString(item.prompt)?.split(/\r?\n/).map((line) => line.trim()).find(Boolean);
    const title = prompt ? prompt.slice(0, 120) : undefined;
    const receivers = Array.isArray(item.receiverThreadIds) ? item.receiverThreadIds : [];
    for (const receiver of receivers) {
      if (typeof receiver === "string" && receiver.trim()) {
        this.childThread(receiver, { title });
      }
    }
  }

  private async handleChildThreadNotification(
    threadId: string,
    method: string,
    params: CodexAppServerJsonObject,
    raw: CodexAppServerJsonObject
  ): Promise<void> {
    if (method === "thread/started") {
      const thread = asRecord(params.thread);
      const nickname = asString(thread?.agentNickname);
      const role = asString(thread?.agentRole);
      const meta = nickname && role ? `${nickname} (${role})` : nickname ?? role ?? undefined;
      // The spawn prompt (if already seen) is the better title; the nickname
      // is metadata. Fall back to the nickname as the title when no prompt is known.
      this.childThread(threadId, { title: meta, meta });
      return;
    }
    const child = this.childThread(threadId);
    switch (method) {
      case "turn/started":
        child.status = "running";
        this.scheduleChildFlush(child, true);
        return;
      case "turn/completed": {
        const status = codexAppServerStatusFromTurn(params);
        child.status = status?.status === "failed" ? "failed" : "completed";
        for (const [itemId] of child.assistantTextByItemId) {
          this.pushChildRow(child, {
            eventId: randomUUID(),
            conversationId: this.callbacks.conversation.id,
            kind: "assistant_message_end",
            messageId: `codex-app-server-${itemId}`,
            stopReason: status?.status ?? "idle",
          });
        }
        child.assistantTextByItemId.clear();
        if (status?.status === "failed" && status.detail) {
          child.lastActivity = status.detail;
          this.pushChildRow(child, {
            eventId: randomUUID(),
            conversationId: this.callbacks.conversation.id,
            kind: "system",
            level: "error",
            text: status.detail,
          });
        }
        child.dirty = true;
        this.scheduleChildFlush(child, true);
        return;
      }
      case "item/agentMessage/delta": {
        const delta = codexAppServerTextDelta(params);
        if (!delta) {
          return;
        }
        child.assistantTextByItemId.set(
          delta.itemId,
          `${child.assistantTextByItemId.get(delta.itemId) ?? ""}${delta.text}`
        );
        this.pushChildRow(child, {
          eventId: randomUUID(),
          conversationId: this.callbacks.conversation.id,
          kind: "assistant_message_chunk",
          messageId: `codex-app-server-${delta.itemId}`,
          text: delta.text,
        });
        child.lastActivity = child.assistantTextByItemId.get(delta.itemId)?.slice(-240);
        this.scheduleChildFlush(child);
        return;
      }
      case "item/reasoning/summaryTextDelta":
      case "item/reasoning/textDelta": {
        const text = codexAppServerReasoningDelta(params);
        const itemId = asString(params.itemId) ?? "turn";
        if (!text) {
          return;
        }
        child.reasoningTextByItemId.set(itemId, `${child.reasoningTextByItemId.get(itemId) ?? ""}${text}`);
        this.pushChildRow(child, {
          eventId: randomUUID(),
          conversationId: this.callbacks.conversation.id,
          kind: "reasoning",
          messageId: `codex-app-server-reasoning-${itemId}`,
          text,
        });
        this.scheduleChildFlush(child);
        return;
      }
      case "item/commandExecution/outputDelta": {
        const itemId = asString(params.itemId);
        const text = asString(params.delta);
        if (!itemId || !text) {
          return;
        }
        this.pushChildRow(child, {
          eventId: randomUUID(),
          conversationId: this.callbacks.conversation.id,
          kind: "tool_call_update",
          toolCallId: itemId,
          toolKind: "terminal",
          status: "in_progress",
          detail: text,
        });
        this.scheduleChildFlush(child);
        return;
      }
      case "item/started":
      case "item/completed": {
        const item = asRecord(params.item);
        const itemId = asString(item?.id);
        const type = asString(item?.type);
        if (!item || !itemId || !type || type === "userMessage") {
          return;
        }
        if (type === "agentMessage") {
          if (method !== "item/completed") {
            return;
          }
          const finalText = codexAppServerAssistantTextFromItem(item) ?? "";
          const emitted = child.assistantTextByItemId.get(itemId) ?? "";
          const remainder = finalText.startsWith(emitted) ? finalText.slice(emitted.length) : emitted ? "" : finalText;
          if (remainder) {
            child.assistantTextByItemId.set(itemId, `${emitted}${remainder}`);
            this.pushChildRow(child, {
              eventId: randomUUID(),
              conversationId: this.callbacks.conversation.id,
              kind: "assistant_message_chunk",
              messageId: `codex-app-server-${itemId}`,
              text: remainder,
            });
          }
          child.lastActivity = (finalText || emitted).slice(-240) || child.lastActivity;
          this.scheduleChildFlush(child, true);
          return;
        }
        if (type === "reasoning") {
          if (method !== "item/completed") {
            return;
          }
          const finalText = codexAppServerReasoningTextFromItem(item);
          if (finalText && !(child.reasoningTextByItemId.get(itemId) ?? "").trim()) {
            child.reasoningTextByItemId.set(itemId, finalText);
            this.pushChildRow(child, {
              eventId: randomUUID(),
              conversationId: this.callbacks.conversation.id,
              kind: "reasoning",
              messageId: `codex-app-server-reasoning-${itemId}`,
              text: finalText,
            });
            this.scheduleChildFlush(child);
          }
          return;
        }
        if (type === "plan") {
          if (method === "item/completed") {
            const text = codexAppServerPlanTextFromItem(item);
            if (text) {
              this.pushChildRow(child, {
                eventId: randomUUID(),
                conversationId: this.callbacks.conversation.id,
                kind: "assistant_message_chunk",
                messageId: `codex-app-server-plan-${itemId}`,
                text,
              });
              this.scheduleChildFlush(child, true);
            }
          }
          return;
        }
        const hasOwnStatus = item.status != null || (type === "subAgentActivity" && item.kind != null);
        const event = codexAppServerToolEventFromItem({
          item,
          conversationId: this.callbacks.conversation.id,
          eventId: randomUUID(),
          emitAsUpdate: method !== "item/started",
          status: method === "item/completed" && !hasOwnStatus ? "completed" : undefined,
        });
        if (event) {
          this.pushChildRow(child, event);
          if ("title" in event && event.title) {
            child.lastActivity = event.title;
          }
          this.scheduleChildFlush(child, method === "item/completed");
        }
        return;
      }
      case "error": {
        const error = asRecord(params.error) ?? params;
        const text = codexAppServerErrorSummary(error);
        if (text && params.willRetry !== true) {
          this.pushChildRow(child, {
            eventId: randomUUID(),
            conversationId: this.callbacks.conversation.id,
            kind: "system",
            level: "error",
            text,
          });
          child.lastActivity = text;
          this.scheduleChildFlush(child, true);
        }
        return;
      }
      default:
        // Token usage, status flags, plan updates etc. for children are not surfaced.
        void raw;
        return;
    }
  }

  private handleTurnStarted(params: CodexAppServerJsonObject): void {
    const turnId = asString(asRecord(params.turn)?.id);
    if (turnId && this.pendingTurn && !this.pendingTurn.turnId) {
      this.pendingTurn.turnId = turnId;
    }
    this.clearTurnSettleTimer();
  }

  private async handleThreadStatusChanged(params: CodexAppServerJsonObject): Promise<void> {
    const status = asRecord(params.status);
    const type = asString(status?.type);
    if (!this.pendingTurn) {
      return;
    }
    if (type === "systemError") {
      this.armTurnSettleFallback("failed");
      return;
    }
    if (type === "idle") {
      // `turn/completed` normally follows within milliseconds; the fallback only
      // fires if the server goes quiet after declaring the thread idle.
      this.armTurnSettleFallback(this.lastTurnErrorText ? "failed" : "idle");
    }
  }

  private async handleTokenUsage(params: CodexAppServerJsonObject): Promise<void> {
    const snapshot = contextUsageFromTokenUsage(params);
    if (!snapshot) {
      return;
    }
    await this.callbacks.updateConversation((current) => ({
      ...current,
      contextUsage: snapshot,
    }));
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

  private async handlePlanDelta(
    params: CodexAppServerJsonObject,
    raw: CodexAppServerJsonObject
  ): Promise<void> {
    const delta = codexAppServerTextDelta(params);
    if (!delta) {
      return;
    }
    const messageId = `codex-app-server-plan-${delta.itemId}`;
    this.assistantItemsForTurn.add(`plan-${delta.itemId}`);
    this.planTextByItemId.set(
      delta.itemId,
      `${this.planTextByItemId.get(delta.itemId) ?? ""}${delta.text}`
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

  private async handleReasoningDelta(
    params: CodexAppServerJsonObject,
    raw: CodexAppServerJsonObject
  ): Promise<void> {
    const text = codexAppServerReasoningDelta(params);
    if (!text) {
      return;
    }
    const itemId = asString(params.itemId) ?? "turn";
    this.reasoningTextByItemId.set(itemId, `${this.reasoningTextByItemId.get(itemId) ?? ""}${text}`);
    await this.callbacks.appendEvents([
      {
        eventId: randomUUID(),
        conversationId: this.callbacks.conversation.id,
        kind: "reasoning",
        messageId: `codex-app-server-reasoning-${itemId}`,
        text,
        raw,
      },
    ]);
  }

  private async handleReasoningPartBoundary(
    params: CodexAppServerJsonObject,
    raw: CodexAppServerJsonObject
  ): Promise<void> {
    const itemId = asString(params.itemId) ?? "turn";
    const existing = this.reasoningTextByItemId.get(itemId);
    // The first summary part needs no separator; later parts are new paragraphs.
    if (!existing || existing.endsWith("\n\n")) {
      return;
    }
    this.reasoningTextByItemId.set(itemId, `${existing}\n\n`);
    await this.callbacks.appendEvents([
      {
        eventId: randomUUID(),
        conversationId: this.callbacks.conversation.id,
        kind: "reasoning",
        messageId: `codex-app-server-reasoning-${itemId}`,
        text: "\n\n",
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
    const type = asString(item.type);
    if (type === "userMessage") {
      return;
    }
    if (type === "agentMessage") {
      if (itemId && method === "item/completed") {
        await this.flushAgentMessage(itemId, item, raw);
      }
      return;
    }
    if (type === "plan") {
      if (itemId && method === "item/completed") {
        await this.flushPlanItem(itemId, item, raw);
      }
      return;
    }
    if (type === "reasoning") {
      if (itemId && method === "item/completed") {
        await this.flushReasoning(itemId, item, raw);
      }
      return;
    }
    if (type === "collabAgentToolCall" || type === "collabToolCall") {
      this.noteCollabSpawn(item);
    }
    const hasOwnStatus = item.status != null || (type === "subAgentActivity" && item.kind != null);
    const event = codexAppServerToolEventFromItem({
      item,
      conversationId: this.callbacks.conversation.id,
      eventId: randomUUID(),
      emitAsUpdate: method !== "item/started",
      status:
        method === "item/updated"
          ? "in_progress"
          : method === "item/completed" && !hasOwnStatus
            ? "completed"
            : undefined,
    });
    if (event) {
      if (itemId && (event.kind === "tool_call" || event.kind === "tool_call_update") && event.title) {
        this.toolItemSummaries.set(itemId, { title: event.title, detail: event.detail });
        if (this.toolItemSummaries.size > 200) {
          const oldest = this.toolItemSummaries.keys().next().value;
          if (oldest) {
            this.toolItemSummaries.delete(oldest);
          }
        }
      }
      await this.callbacks.appendEvents([event]);
    }
    if (type === "contextCompaction" && method === "item/completed") {
      await this.appendSystem("info", "Codex compacted the conversation context.", raw);
    }
  }

  /** Emits whatever text of the final agent message was not already streamed. */
  private async flushAgentMessage(
    itemId: string,
    item: CodexAppServerJsonObject,
    raw: CodexAppServerJsonObject
  ): Promise<void> {
    const finalText = codexAppServerAssistantTextFromItem(item) ?? "";
    const emitted = this.assistantTextByItemId.get(itemId) ?? "";
    const remainder = finalText.startsWith(emitted) ? finalText.slice(emitted.length) : emitted ? "" : finalText;
    if (remainder) {
      await this.handleAssistantDelta({ itemId, delta: remainder }, raw);
    }
    const questions = codexAppServerAsyncQuestionsFromItem(item);
    if (questions.length > 0) {
      await this.surfaceAsyncQuestions(itemId, questions, item);
    }
  }

  private async flushPlanItem(
    itemId: string,
    item: CodexAppServerJsonObject,
    raw: CodexAppServerJsonObject
  ): Promise<void> {
    const finalText = codexAppServerPlanTextFromItem(item) ?? "";
    const emitted = this.planTextByItemId.get(itemId) ?? "";
    const remainder = finalText.startsWith(emitted) ? finalText.slice(emitted.length) : emitted ? "" : finalText;
    if (remainder) {
      await this.handlePlanDelta({ itemId, delta: remainder }, raw);
    }
    const planMarkdown = finalText || emitted;
    if (!planMarkdown.trim()) {
      return;
    }
    try {
      const artifact = await writeProviderPlanArtifact({
        workspaceRoot: this.callbacks.workspace.root,
        backendId: "codex-app-server",
        title: planTitleFromText(planMarkdown),
        markdown: planMarkdown,
      });
      await this.callbacks.appendEvents(
        providerPlanEvents({
          conversationId: this.callbacks.conversation.id,
          planId: `${this.callbacks.conversation.id}-codex-app-server-proposed-plan`,
          artifact,
          raw,
        })
      );
    } catch (error) {
      await this.appendSystem(
        "warning",
        `Could not save the Codex plan file: ${error instanceof Error ? error.message : String(error)}`
      );
    }
  }

  private async flushReasoning(
    itemId: string,
    item: CodexAppServerJsonObject,
    raw: CodexAppServerJsonObject
  ): Promise<void> {
    const finalText = codexAppServerReasoningTextFromItem(item);
    if (!finalText) {
      return;
    }
    const emitted = (this.reasoningTextByItemId.get(itemId) ?? "").trim();
    if (emitted) {
      // Streamed deltas already carried this text (summary parts may be joined
      // differently than the final item, so only top up clear prefixes).
      const normalizedFinal = finalText.replace(/\s+/g, " ").trim();
      const normalizedEmitted = emitted.replace(/\s+/g, " ").trim();
      if (normalizedFinal.startsWith(normalizedEmitted) && normalizedFinal.length > normalizedEmitted.length) {
        const remainder = finalText.slice(emitted.length).trimStart();
        if (remainder) {
          await this.handleReasoningDelta({ itemId, delta: remainder }, raw);
        }
      }
      return;
    }
    await this.handleReasoningDelta({ itemId, delta: finalText }, raw);
  }

  private async surfaceAsyncQuestions(
    itemId: string,
    steps: CodexAppServerQuestionStep[],
    item: CodexAppServerJsonObject
  ): Promise<void> {
    const questionId = `codex-app-server-async-${itemId}`;
    const prompt = steps.length === 1 ? steps[0]!.prompt : "Codex has a few questions";
    this.asyncQuestions.set(questionId, { questionId, prompt, steps });
    await this.callbacks.appendEvents([
      {
        eventId: randomUUID(),
        conversationId: this.callbacks.conversation.id,
        kind: "question",
        questionId,
        prompt,
        options: steps[0]?.options ?? [],
        questions: steps,
        allowMultiple: false,
        status: "pending",
        raw: item,
      },
    ]);
    await this.callbacks.updateConversation((current) => ({
      ...current,
      pendingQuestion: { questionId, requestedAt: Date.now() },
    }));
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

  private async handleTerminalInteraction(
    params: CodexAppServerJsonObject,
    raw: CodexAppServerJsonObject
  ): Promise<void> {
    const itemId = asString(params.itemId);
    const stdin = asString(params.stdin);
    if (!itemId || !stdin) {
      return;
    }
    await this.callbacks.appendEvents([
      {
        eventId: randomUUID(),
        conversationId: this.callbacks.conversation.id,
        kind: "tool_call_update",
        toolCallId: itemId,
        toolKind: "terminal",
        status: "in_progress",
        detail: `> ${stdin.replace(/\n$/, "")}\n`,
        raw,
      },
    ]);
  }

  private async handlePatchUpdated(
    params: CodexAppServerJsonObject,
    raw: CodexAppServerJsonObject
  ): Promise<void> {
    const itemId = asString(params.itemId);
    if (!itemId || !Array.isArray(params.changes)) {
      return;
    }
    const event = codexAppServerToolEventFromItem({
      item: { id: itemId, type: "fileChange", changes: params.changes, status: "inProgress" },
      conversationId: this.callbacks.conversation.id,
      eventId: randomUUID(),
      emitAsUpdate: true,
      status: "in_progress",
    });
    if (event && event.kind === "tool_call_update") {
      await this.callbacks.appendEvents([{ ...event, raw }]);
    }
  }

  private async handleMcpProgress(
    params: CodexAppServerJsonObject,
    raw: CodexAppServerJsonObject
  ): Promise<void> {
    const itemId = asString(params.itemId);
    const text = asString(params.message);
    if (!itemId || !text) {
      return;
    }
    await this.callbacks.appendEvents([
      {
        eventId: randomUUID(),
        conversationId: this.callbacks.conversation.id,
        kind: "tool_call_update",
        toolCallId: itemId,
        toolKind: "mcp",
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
    const turnId = asString(asRecord(params.turn)?.id);
    if (this.pendingTurn?.turnId && turnId && this.pendingTurn.turnId !== turnId) {
      // Completion for a turn we did not start (e.g. queued follow-ups) - ignore.
      return;
    }
    const status = codexAppServerStatusFromTurn(params) ?? { status: "idle" as const };
    if (this.cancelRequested && status.status === "interrupted") {
      // cancel() already recorded the cancelled state.
      this.cancelRequested = false;
      this.settlePendingTurn();
      return;
    }
    await this.finishTurn(status, raw);
  }

  private async finishTurn(
    status: { status: "idle" | "failed" | "interrupted"; detail?: string },
    raw: CodexAppServerJsonObject
  ): Promise<void> {
    const events: AgentEventInput[] = [];
    for (const key of this.assistantItemsForTurn) {
      const messageId = key.startsWith("plan-")
        ? `codex-app-server-plan-${key.slice("plan-".length)}`
        : `codex-app-server-${key}`;
      events.push({
        eventId: randomUUID(),
        conversationId: this.callbacks.conversation.id,
        kind: "assistant_message_end",
        messageId,
        stopReason: status.status,
        raw,
      });
    }
    const detail = status.status === "failed" ? status.detail ?? this.lastTurnErrorText ?? undefined : status.detail;
    if (status.status === "failed" && detail && detail !== this.lastTurnErrorText) {
      events.unshift({
        eventId: randomUUID(),
        conversationId: this.callbacks.conversation.id,
        kind: "system",
        level: "error",
        text: detail,
        raw,
      });
    }
    events.push({
      eventId: randomUUID(),
      conversationId: this.callbacks.conversation.id,
      kind: "status",
      status: status.status,
      detail,
      raw,
    });
    await this.clearPendingServerRequests(status.status === "idle" ? "cancelled" : "cancelled");
    await this.callbacks.appendEvents(events);
    const hasPendingAsyncQuestion = this.asyncQuestions.size > 0;
    await this.callbacks.updateConversation((current) => ({
      ...current,
      status:
        status.status === "idle" && hasPendingAsyncQuestion && current.pendingQuestion
          ? "awaiting_question"
          : turnStatusFromConversationStatus(status.status),
      pendingPermission: null,
      pendingQuestion: hasPendingAsyncQuestion ? current.pendingQuestion : null,
      lastError: status.status === "failed" ? detail ?? "Codex App Server turn failed." : null,
      providerSessionId: this.sessionId,
    }));
    this.settlePendingTurn();
  }

  private async handlePlanUpdated(
    params: CodexAppServerJsonObject,
    raw: CodexAppServerJsonObject
  ): Promise<void> {
    const entries = codexAppServerPlanEntriesFromTurnPlan(params);
    if (entries.length === 0) {
      return;
    }
    const artifact = await writeProviderPlanArtifact({
      workspaceRoot: this.callbacks.workspace.root,
      backendId: "codex-app-server",
      title: "Codex plan",
      overview: asString(params.explanation),
      entries,
    });
    await this.callbacks.appendEvents(providerPlanEvents({
      conversationId: this.callbacks.conversation.id,
      planId: `${this.callbacks.conversation.id}-codex-app-server-plan`,
      artifact,
      raw,
    }));
  }

  private async handleServerRequestResolved(
    params: CodexAppServerJsonObject,
    raw: CodexAppServerJsonObject
  ): Promise<void> {
    const rawId = params.requestId;
    const requestId = typeof rawId === "number" || typeof rawId === "string" ? String(rawId) : undefined;
    if (!requestId) {
      return;
    }
    const pending = this.pendingServerRequests.get(requestId);
    if (!pending) {
      // We already answered it (or never saw it); nothing to clean up.
      return;
    }
    // The server cleared a request we never answered (turn interrupted/completed).
    this.pendingServerRequests.delete(requestId);
    if (pending.kind === "approval") {
      await this.callbacks.appendEvents([
        {
          eventId: randomUUID(),
          conversationId: this.callbacks.conversation.id,
          kind: "permission_resolved",
          requestId,
          outcome: "cancelled",
          raw,
        },
      ]);
      await this.callbacks.updateConversation((current) => ({
        ...current,
        status: current.status === "awaiting_permission" ? "running" : current.status,
        pendingPermission:
          current.pendingPermission?.requestId === requestId ? null : current.pendingPermission,
      }));
      return;
    }
    this.pendingQuestionRequestIds.delete(pending.questionId);
    await this.callbacks.appendEvents([
      {
        eventId: randomUUID(),
        conversationId: this.callbacks.conversation.id,
        kind: "question",
        questionId: pending.questionId,
        prompt: pending.kind === "user_input" ? pending.request.prompt : pending.prompt,
        options: (pending.kind === "user_input" ? pending.request.steps : pending.steps)[0]?.options ?? [],
        questions: pending.kind === "user_input" ? pending.request.steps : pending.steps,
        status: "cancelled",
        raw,
      },
    ]);
    await this.callbacks.updateConversation((current) => ({
      ...current,
      status: current.status === "awaiting_question" ? "running" : current.status,
      pendingQuestion:
        current.pendingQuestion?.questionId === pending.questionId ? null : current.pendingQuestion,
    }));
  }

  /** Drops every outstanding server request (turn ended, cancelled, or transport died). */
  private async clearPendingServerRequests(outcome: "cancelled"): Promise<void> {
    if (this.pendingServerRequests.size === 0) {
      return;
    }
    const events: AgentEventInput[] = [];
    for (const [requestId, pending] of this.pendingServerRequests) {
      if (pending.kind === "approval") {
        this.transport?.respond(
          pending.rpcId,
          codexAppServerApprovalResponse({
            method: pending.method,
            params: pending.params,
            optionId: undefined,
            cancelled: true,
          })
        );
        events.push({
          eventId: randomUUID(),
          conversationId: this.callbacks.conversation.id,
          kind: "permission_resolved",
          requestId,
          outcome,
        });
      } else {
        this.transport?.respondError(pending.rpcId, -32800, "Request cancelled by the client.");
        this.pendingQuestionRequestIds.delete(pending.questionId);
        events.push({
          eventId: randomUUID(),
          conversationId: this.callbacks.conversation.id,
          kind: "question",
          questionId: pending.questionId,
          prompt: pending.kind === "user_input" ? pending.request.prompt : pending.prompt,
          options: (pending.kind === "user_input" ? pending.request.steps : pending.steps)[0]?.options ?? [],
          questions: pending.kind === "user_input" ? pending.request.steps : pending.steps,
          status: "cancelled",
        });
      }
    }
    this.pendingServerRequests.clear();
    await this.callbacks.appendEvents(events);
  }

  private async handleError(
    params: CodexAppServerJsonObject,
    raw: CodexAppServerJsonObject
  ): Promise<void> {
    const error = asRecord(params.error) ?? params;
    const message = codexAppServerErrorSummary(error) ?? "Codex App Server emitted an error.";
    const willRetry = params.willRetry === true;
    if (willRetry) {
      await this.appendSystem("warning", `${message} (retrying)`, raw);
      return;
    }
    this.lastTurnErrorText = message;
    await this.appendSystem("error", message, raw);
    // `turn/completed { status: "failed" }` normally follows and settles the
    // turn; the fallback timer covers servers that never send it.
    this.armTurnSettleFallback("failed");
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
      await this.appendSystem("error", text, raw);
      return;
    }
    if (type === "stream_error" || type === "background_event" || type === "warning") {
      const text = asString(msg?.message);
      if (text) {
        await this.appendSystem(type === "warning" ? "warning" : "info", text, raw);
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
      this.settlePendingTurn();
    }
  }

  // ---------------------------------------------------------------------------
  // Server → client requests
  // ---------------------------------------------------------------------------

  private async handleServerRequest(message: CodexAppServerRequestMessage): Promise<void> {
    const requestId = String(message.id);
    if (CODEX_USER_INPUT_REQUEST_METHODS.has(message.method)) {
      await this.handleUserInputRequest(message, requestId);
      return;
    }
    if (message.method === "currentTime/read") {
      this.transport?.respond(message.id, { currentTimeAt: Math.floor(Date.now() / 1000) });
      return;
    }
    if (message.method === "mcpServer/elicitation/request") {
      const form = codexAppServerElicitationQuestion(message.params);
      if (form) {
        await this.handleElicitationForm(message, requestId, form);
        return;
      }
    }
    if (CODEX_APPROVAL_REQUEST_METHODS.has(message.method)) {
      await this.handleApprovalRequest(message, requestId);
      return;
    }
    // Requests Cesium intentionally does not implement: dynamic client tools
    // (we register none), desktop attestation, ChatGPT token refresh.
    if (message.method === "item/tool/call") {
      this.transport?.respond(message.id, {
        contentItems: [{ type: "inputText", text: "This client does not provide dynamic tools." }],
        success: false,
      });
      return;
    }
    if (message.method === "attestation/generate" || message.method === "account/chatgptAuthTokens/refresh") {
      this.transport?.respondError(message.id, -32601, `${message.method} is not supported by this client.`);
      return;
    }
    this.transport?.respondError(message.id, -32601, `Unsupported Codex App Server request: ${message.method}`);
    if (this.rememberWarning(`unsupported:${message.method}`)) {
      await this.appendSystem(
        "warning",
        `Codex App Server requested an unsupported client method: ${message.method}`,
        message
      );
    }
  }

  private async handleApprovalRequest(message: CodexAppServerRequestMessage, requestId: string): Promise<void> {
    const event = codexAppServerPermissionRequestFromServerRequest({
      requestId,
      method: message.method,
      params: message.params,
      conversationId: this.callbacks.conversation.id,
      eventId: randomUUID(),
    });
    if (!event) {
      this.transport?.respond(
        message.id,
        codexAppServerApprovalResponse({
          method: message.method,
          params: message.params,
          optionId: undefined,
          cancelled: true,
        })
      );
      await this.appendSystem(
        "warning",
        `Declined a Codex request Cesium cannot render: ${message.method}`,
        message
      );
      return;
    }
    // File-change approvals only reference the item id; borrow the pending
    // item's summary so the card says which files are about to change.
    if (event.toolCallId && !event.detail?.trim()) {
      const summary = this.toolItemSummaries.get(event.toolCallId);
      if (summary) {
        event.detail = [summary.title, summary.detail].filter(Boolean).join("\n");
      }
    }
    const supportsRemembered =
      message.method === "item/commandExecution/requestApproval" ||
      message.method === "item/fileChange/requestApproval";
    const toolKey = buildRememberedPermissionToolKey(
      "codex-app-server",
      message.method,
      event.title,
      event.detail
    );
    const toolLabel = event.title ?? message.method;
    {
      const resolved = await resolveRememberedPermissionDecision({
        workspaceId: this.callbacks.workspace.id,
        backendId: this.backend.id,
        toolKey,
        options: event.options,
      });
      // Remembered per-tool rules only exist for command/file approvals; the
      // global "auto-approve all" switch covers every approval kind (MCP tool
      // approvals, permission grants, ...).
      const applies =
        (resolved.kind === "remembered" && supportsRemembered) || resolved.kind === "auto_accept";
      if (applies && (resolved.kind === "remembered" || resolved.kind === "auto_accept")) {
        const allowOptionId =
          event.options.find((option) => option.kind === "allow_once")?.optionId ?? "accept";
        const declineOptionId =
          event.options.find((option) => option.kind === "reject_once")?.optionId ?? "decline";
        const optionId =
          resolved.kind === "remembered"
            ? resolved.decision === "allow"
              ? allowOptionId
              : declineOptionId
            : allowOptionId;
        this.transport?.respond(
          message.id,
          codexAppServerApprovalResponse({
            method: message.method,
            params: message.params,
            optionId,
          })
        );
        await this.callbacks.appendEvents([
          {
            eventId: randomUUID(),
            conversationId: this.callbacks.conversation.id,
            kind: "permission_resolved",
            requestId,
            outcome: "selected",
            optionId: resolved.kind === "remembered" ? resolved.rule.optionId : optionId,
            raw:
              resolved.kind === "remembered"
                ? {
                    rememberedPermission: {
                      id: resolved.rule.id,
                      decision: resolved.rule.decision,
                      toolLabel: resolved.rule.toolLabel,
                    },
                  }
                : { autoAcceptedAll: true },
          },
          {
            eventId: randomUUID(),
            conversationId: this.callbacks.conversation.id,
            kind: "status",
            status: "running",
            detail:
              resolved.kind === "remembered"
                ? `Used remembered permission for ${resolved.rule.toolLabel}.`
                : "Auto-accepted (Agents → auto-approve all).",
          },
        ]);
        await this.callbacks.updateConversation((current) => ({
          ...current,
          status: "running",
          pendingPermission: null,
        }));
        return;
      }
    }
    const options = supportsRemembered ? withPersistentPermissionOptions(event.options) : event.options;
    this.pendingServerRequests.set(requestId, {
      kind: "approval",
      rpcId: message.id,
      method: message.method,
      params: message.params,
      toolKey,
      toolLabel,
      optionIds: new Set(event.options.map((option) => option.optionId)),
    });
    await this.callbacks.appendEvents([
      { ...event, options },
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
        options,
      },
    }));
  }

  private async handleUserInputRequest(message: CodexAppServerRequestMessage, requestId: string): Promise<void> {
    const request = codexAppServerUserInputRequest(message.params);
    if (!request) {
      this.transport?.respond(message.id, { answers: {} });
      return;
    }
    const questionId = `codex-app-server-question-${requestId}`;
    this.pendingServerRequests.set(requestId, {
      kind: "user_input",
      rpcId: message.id,
      method: message.method,
      params: message.params,
      questionId,
      request,
    });
    this.pendingQuestionRequestIds.set(questionId, requestId);
    await this.callbacks.appendEvents([
      {
        eventId: randomUUID(),
        conversationId: this.callbacks.conversation.id,
        kind: "question",
        questionId,
        prompt: request.prompt,
        options: request.steps[0]?.options ?? [],
        questions: request.steps,
        allowMultiple: false,
        status: "pending",
        raw: { method: message.method, params: message.params },
      },
      {
        eventId: randomUUID(),
        conversationId: this.callbacks.conversation.id,
        kind: "status",
        status: "awaiting_question",
        detail: request.prompt,
      },
    ]);
    await this.callbacks.updateConversation((current) => ({
      ...current,
      status: "awaiting_question",
      pendingQuestion: { questionId, requestedAt: Date.now() },
    }));
  }

  private async handleElicitationForm(
    message: CodexAppServerRequestMessage,
    requestId: string,
    form: { prompt: string; steps: CodexAppServerQuestionStep[]; fields: CodexAppServerElicitationField[] }
  ): Promise<void> {
    const questionId = `codex-app-server-elicitation-${requestId}`;
    this.pendingServerRequests.set(requestId, {
      kind: "elicitation_form",
      rpcId: message.id,
      method: message.method,
      params: message.params,
      questionId,
      prompt: form.prompt,
      steps: form.steps,
      fields: form.fields,
    });
    this.pendingQuestionRequestIds.set(questionId, requestId);
    await this.callbacks.appendEvents([
      {
        eventId: randomUUID(),
        conversationId: this.callbacks.conversation.id,
        kind: "question",
        questionId,
        prompt: form.prompt,
        options: form.steps[0]?.options ?? [],
        questions: form.steps,
        allowMultiple: false,
        status: "pending",
        raw: { method: message.method, params: message.params },
      },
      {
        eventId: randomUUID(),
        conversationId: this.callbacks.conversation.id,
        kind: "status",
        status: "awaiting_question",
        detail: form.prompt,
      },
    ]);
    await this.callbacks.updateConversation((current) => ({
      ...current,
      status: "awaiting_question",
      pendingQuestion: { questionId, requestedAt: Date.now() },
    }));
  }
}

function planTitleFromText(markdown: string): string {
  const heading = /^#+\s+(.+)$/m.exec(markdown)?.[1]?.trim();
  if (heading) {
    return heading.slice(0, 80);
  }
  const firstLine = markdown
    .split(/\r?\n/)
    .map((line) => line.trim())
    .find((line) => line.length > 0);
  return (firstLine ?? "Codex plan").replace(/^[-*\d.\s]+/, "").slice(0, 80) || "Codex plan";
}

export function isCodexThreadNotFoundError(error: unknown): boolean {
  if (error instanceof CodexAppServerRpcError) {
    return /no rollout found|thread not found|unknown thread|not loaded/i.test(error.message);
  }
  return error instanceof Error && /no rollout found|thread not found/i.test(error.message);
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
