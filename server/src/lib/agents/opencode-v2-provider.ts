import { randomUUID } from "node:crypto";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { asRecord, asString } from "./json-coerce.js";
import type {
  AgentBackendInfo,
  AgentConfigOption,
  AgentConversationRecord,
  AgentConversationSnapshot,
  AgentEventInput,
  AgentProvider,
  AgentProviderCapabilities,
  AgentRuntimeCallbacks,
  AgentSessionHandle,
} from "./types.js";
import {
  connectOpenCodeV2,
  type OpenCodeV2Connection,
} from "./opencode-v2-process.js";
import {
  parseOpenCodeV2ModelRef,
  OpenCodeV2Error,
  type OpenCodeV2Client,
  type OpenCodeV2Json,
} from "./opencode-v2-client.js";
import { buildOpenCodeV2ConfigOptions } from "./opencode-v2-config.js";
import { writeAgentBackendConfigCache } from "./provider-cache-store.js";
import {
  startOpenCodeV2Events,
  startOpenCodeV2SessionLog,
  type OpenCodeV2EventStream,
} from "./opencode-v2-events.js";
import {
  OpenCodeV2EventNormalizer,
  openCodeV2ChildSessionId,
  openCodeV2EventSessionId,
  openCodeV2FormFieldPrompt,
  openCodeV2FormPrompt,
  openCodeV2PermissionReply,
  openCodeV2PermissionRequestEvent,
  readOpenCodeV2FormRequest,
  readOpenCodeV2PermissionRequest,
  readOpenCodeV2QuestionRequest,
  type OpenCodeV2FormField,
  type OpenCodeV2FormRequest,
  type OpenCodeV2QuestionRequest,
} from "./opencode-v2-normalize.js";
import { harnessLog } from "./harness-diagnostics.js";
import { ensureOpenCodeGenerationOption } from "./opencode-generation.js";
import {
  buildRememberedPermissionToolKey,
  persistRememberedPermissionChoice,
  resolveRememberedPermissionDecision,
} from "./remembered-permissions.js";
import { isPersistentPermissionOptionId } from "./permission-options.js";
import { materializeImageAttachments } from "./prompt-attachments.js";
import {
  appendAgentPluginPrompt,
  resolveAgentPluginAttachments,
} from "../plugins/attachments.js";

function optionValue(options: AgentConfigOption[], id: string, fallback = ""): string {
  return options.find((option) => option.id === id)?.currentValue || fallback;
}

function optionName(options: AgentConfigOption[], id: string, value: string): string {
  return options
    .find((option) => option.id === id)
    ?.options.find((candidate) => candidate.value === value)?.name ?? value;
}

function updateConfigOption(options: AgentConfigOption[], id: string, value: string): AgentConfigOption[] {
  return options.map((option) => (option.id === id ? { ...option, currentValue: value } : option));
}

/**
 * The conversation's configured model/mode must win over catalog defaults.
 * Fresh conversations start from the backend option catalog, whose model
 * `currentValue` is just "first model the server listed" - without this merge
 * it silently overrides the model the user picked when creating the chat.
 */
function withConversationConfig(
  options: AgentConfigOption[],
  conversation: AgentConversationRecord
): AgentConfigOption[] {
  const applies = (option: AgentConfigOption, value: string): boolean =>
    Boolean(value) &&
    (option.options.length === 0 ||
      option.options.some((candidate) => candidate.value === value));
  return options.map((option) => {
    if (option.category === "model" && applies(option, conversation.config.modelId ?? "")) {
      return { ...option, currentValue: conversation.config.modelId };
    }
    if (option.category === "mode" && applies(option, conversation.config.mode ?? "")) {
      return { ...option, currentValue: conversation.config.mode };
    }
    return option;
  });
}

function transcriptText(snapshot: AgentConversationSnapshot | null, excludeUserMessageId?: string): string {
  if (!snapshot) return "";
  const lines: string[] = [];
  const assistantChunks = new Map<string, string>();
  for (const event of snapshot.events) {
    if (event.kind === "user_message") {
      if (event.messageId !== excludeUserMessageId) {
        lines.push(`User: ${event.content}`);
      }
    } else if (event.kind === "assistant_message_chunk") {
      assistantChunks.set(event.messageId, `${assistantChunks.get(event.messageId) ?? ""}${event.text}`);
    } else if (event.kind === "assistant_message_end") {
      const text = assistantChunks.get(event.messageId)?.trim();
      if (text) lines.push(`Assistant: ${text}`);
      assistantChunks.delete(event.messageId);
    }
  }
  for (const text of assistantChunks.values()) {
    if (text.trim()) lines.push(`Assistant: ${text.trim()}`);
  }
  return lines.join("\n\n").trim();
}

function splitSessionRecoveryPrompt(text: string): { transcript: string; userText: string } | null {
  const recovered = text.match(/<recovered_conversation>\s*([\s\S]*?)\s*<\/recovered_conversation>/i);
  const current = text.match(/<current_user_message>\s*([\s\S]*?)\s*<\/current_user_message>/i);
  const transcript = recovered?.[1]?.trim();
  const userText = current?.[1]?.trim();
  return transcript && userText ? { transcript, userText } : null;
}

function modelValue(model: unknown): string | undefined {
  const record = asRecord(model);
  const providerId = asString(record?.providerID);
  const id = asString(record?.id) ?? asString(record?.modelID);
  const variant = asString(record?.variant);
  return providerId && id ? `${providerId}/${id}${variant ? `#${variant}` : ""}` : undefined;
}

async function withTimeout<T>(promise: Promise<T>, ms: number, message: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(message)), ms);
        timer.unref?.();
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

function openCodeV2WaitSettleGraceMs(): number {
  const raw = Number(process.env.OPENCURSOR_OPENCODE_V2_WAIT_SETTLE_MS);
  return Number.isFinite(raw) && raw >= 0 ? raw : 1_500;
}

function openCodeV2PermissionPollIntervalMs(): number {
  const raw = Number(process.env.OPENCURSOR_OPENCODE_V2_PERMISSION_POLL_MS);
  return Number.isFinite(raw) && raw >= 50 ? raw : 1_500;
}

function eventMatchesWorkspace(payload: OpenCodeV2Json, workspaceRoot: string): boolean {
  const directory = asString(asRecord(payload.location)?.directory);
  if (!directory) return true;
  try {
    return path.resolve(directory) === path.resolve(workspaceRoot);
  } catch {
    return false;
  }
}

type ActivePrompt = {
  messageId: string;
  emittedText: string;
  completed: boolean;
  cancelled: boolean;
  promise: Promise<void>;
  resolve: () => void;
  reject: (error: Error) => void;
};

type PendingInteraction =
  | { kind: "question"; request: OpenCodeV2QuestionRequest; raw: OpenCodeV2Json }
  | { kind: "form"; request: OpenCodeV2FormRequest; raw: OpenCodeV2Json };

function createActivePrompt(messageId: string): ActivePrompt {
  let resolve: () => void = () => undefined;
  let reject: (error: Error) => void = () => undefined;
  const promise = new Promise<void>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return {
    messageId,
    emittedText: "",
    completed: false,
    cancelled: false,
    promise,
    resolve,
    reject,
  };
}

function eventErrorMessage(value: unknown): string {
  if (typeof value === "string" && value.trim()) return value.trim();
  const record = asRecord(value);
  return (
    asString(record?.message) ??
    asString(asRecord(record?.data)?.message) ??
    asString(record?.name) ??
    "OpenCode v2 execution failed."
  );
}

function stripSynthesizedAnswerLabel(value: string, label: string): string {
  const prefix = `${label.trim()}:`;
  return value.trim().toLowerCase().startsWith(prefix.toLowerCase())
    ? value.trim().slice(prefix.length).trim()
    : value.trim();
}

function answerLines(answer: string, labels: string[]): string[] {
  if (labels.length <= 1) {
    return [stripSynthesizedAnswerLabel(answer, labels[0] ?? "")];
  }
  const lines = answer
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  return labels.map((label, index) =>
    stripSynthesizedAnswerLabel(lines[index] ?? "", label)
  );
}

function questionAnswers(request: OpenCodeV2QuestionRequest, answer: string): string[][] {
  return answerLines(
    answer,
    request.questions.map((question) => question.question)
  ).map((line, index) =>
    request.questions[index]?.multiple
      ? line.split(/\s*,\s*/).filter(Boolean)
      : line
        ? [line]
        : []
  );
}

function formAnswerValue(field: OpenCodeV2FormField, answer: string): string | number | boolean | string[] {
  const optionValueForLabel = (label: string) =>
    field.options?.find((option) => option.label.toLowerCase() === label.toLowerCase())?.value ?? label;
  if (field.type === "multiselect") {
    return answer.split(/\s*,\s*/).filter(Boolean).map(optionValueForLabel);
  }
  if (field.type === "boolean") {
    return /^(?:yes|true|1)$/i.test(answer);
  }
  if (field.type === "number" || field.type === "integer") {
    const value = Number(answer);
    return Number.isFinite(value) ? value : answer;
  }
  return optionValueForLabel(answer);
}

function formAnswers(
  request: OpenCodeV2FormRequest,
  answer: string
): Record<string, string | number | boolean | string[]> {
  const lines = answerLines(
    answer,
    request.fields.map((field) => openCodeV2FormFieldPrompt(field, request.kind))
  );
  return Object.fromEntries(
    request.fields.map((field, index) => [
      field.key,
      formAnswerValue(field, lines[index] ?? ""),
    ])
  );
}

function questionEventForInteraction(
  interaction: PendingInteraction,
  conversationId: string,
  status: "answered" | "cancelled",
  answer?: string
): AgentEventInput {
  if (interaction.kind === "question") {
    const questions = interaction.request.questions.map((question, index) => ({
      id: `question-${index + 1}`,
      prompt: question.question,
      options: question.options.map((option, optionIndex) => ({
        id: `option-${optionIndex + 1}`,
        label: option.label,
      })),
      allowMultiple: question.multiple,
    }));
    return {
      eventId: randomUUID(),
      conversationId,
      kind: "question",
      questionId: interaction.request.id,
      prompt:
        interaction.request.questions.length === 1
          ? interaction.request.questions[0]!.question
          : "OpenCode questions",
      options: questions[0]?.options ?? [],
      questions,
      allowMultiple:
        interaction.request.questions.length === 1 && interaction.request.questions[0]?.multiple,
      status,
      answer,
      raw: interaction.raw,
    };
  }
  const questions = interaction.request.fields.map((field) => ({
    id: field.key,
    prompt: openCodeV2FormFieldPrompt(field, interaction.request.kind),
    options:
      field.type === "boolean"
        ? [
            { id: "true", label: "Yes" },
            { id: "false", label: "No" },
          ]
        : (field.options ?? []).map((option) => ({ id: option.value, label: option.label })),
    allowMultiple: field.multiple,
  }));
  return {
    eventId: randomUUID(),
    conversationId,
    kind: "question",
    questionId: interaction.request.id,
    prompt: openCodeV2FormPrompt(interaction.request),
    options: questions[0]?.options ?? [],
    questions,
    allowMultiple: questions.length === 1 && questions[0]?.allowMultiple,
    status,
    answer,
    raw: interaction.raw,
  };
}

class OpenCodeV2SessionHandle implements AgentSessionHandle {
  readonly capabilities: AgentProviderCapabilities;
  sessionId: string;
  configOptions: AgentConfigOption[];

  private connection: OpenCodeV2Connection | null = null;
  private globalEvents: OpenCodeV2EventStream | null = null;
  private readonly sessionLogs = new Map<string, OpenCodeV2EventStream>();
  private readonly normalizer = new OpenCodeV2EventNormalizer();
  private readonly seenEventIds = new Set<string>();
  private readonly sessionBelongsToRoot = new Map<string, boolean>();
  private readonly completedChildSessions = new Set<string>();
  private readonly permissionSessions = new Map<string, string>();
  private readonly pendingPermissionContext = new Map<
    string,
    { toolKey: string; toolLabel: string }
  >();
  private readonly pendingInteractions = new Map<string, PendingInteraction>();
  private readonly reportedStreamErrors = new Set<string>();
  /** Permissions Cesium is currently replying to (so the echoed `permission.replied` is not treated as external). */
  private readonly answeringPermissionIds = new Set<string>();
  /** Recently resolved permission ids (guards the polling fallback against re-surfacing them). */
  private readonly resolvedPermissionIds = new Set<string>();
  private permissionPollTimer: ReturnType<typeof setInterval> | null = null;
  private permissionPollDisabled = false;
  private permissionPollBusy = false;
  private permissionPollFailures = 0;
  private seededContext = false;
  private disposed = false;
  private activePrompt: ActivePrompt | null = null;
  private waitController: AbortController | null = null;
  /**
   * Root-session execution OpenCode started on its own (a background subagent
   * finishing injects a synthetic message and wakes the parent). There is no
   * Cesium prompt in flight, so the assistant output needs its own message.
   */
  private autonomousTurn: ActivePrompt | null = null;

  constructor(
    private readonly backend: AgentBackendInfo,
    private readonly callbacks: AgentRuntimeCallbacks,
    configOptions: AgentConfigOption[],
    providerSessionId?: string | null
  ) {
    this.capabilities = backend.capabilities;
    this.configOptions = withConversationConfig(
      ensureOpenCodeGenerationOption(
        callbacks.conversation.configOptions.length > 0
          ? callbacks.conversation.configOptions
          : configOptions,
        callbacks.conversation
      ),
      callbacks.conversation
    );
    this.sessionId = providerSessionId ?? `opencode-v2-pending-${callbacks.conversation.id}`;
  }

  async initialize(loadSessionId?: string | null): Promise<void> {
    this.connection = await connectOpenCodeV2({
      workspaceRoot: this.callbacks.workspace.root,
      onOutputLine: (line) => {
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
    try {
      await this.initializeConnected(loadSessionId);
    } catch (error) {
      await this.closeStreamsAndConnection();
      throw error;
    }
  }

  private async initializeConnected(loadSessionId?: string | null): Promise<void> {
    const client = this.connection!.client;
    const existingSession = loadSessionId ? await client.getSession(loadSessionId) : null;
    await this.refreshConfigOptions(client, existingSession);
    const selectedAgent = optionValue(
      this.configOptions,
      "agent",
      this.callbacks.conversation.config.mode
    );
    const selectedModel = optionValue(
      this.configOptions,
      "model",
      this.callbacks.conversation.config.modelId
    );
    const selectedModelRef = parseOpenCodeV2ModelRef(selectedModel);
    const session =
      existingSession ??
      (await client.createSession({
        location: { directory: this.callbacks.workspace.root },
        ...(selectedAgent && selectedAgent !== "auto" && selectedAgent !== "__default__"
          ? { agent: selectedAgent }
          : {}),
        ...(selectedModelRef ? { model: selectedModelRef } : {}),
      }));
    const id = asString(session.id) ?? loadSessionId ?? undefined;
    if (!id) {
      throw new Error("OpenCode v2 Beta did not return a session id.");
    }
    this.sessionId = id;
    this.sessionBelongsToRoot.set(id, true);
    if (!existingSession && this.callbacks.conversation.title.trim()) {
      await client.renameSession(id, this.callbacks.conversation.title).catch(() => undefined);
    }
    this.globalEvents = startOpenCodeV2Events({
      client,
      onEvent: (event) => this.handleEvent(event),
      onError: (error) => this.reportStreamError(error),
      onReconnect: () => this.reconcileAfterReconnect(),
    });
    const rootLog = startOpenCodeV2SessionLog({
      client,
      sessionId: id,
      replayExisting: false,
      onEvent: (event) => this.handleEvent(event),
      onError: (error) => this.reportStreamError(error),
    });
    this.sessionLogs.set(id, rootLog);
    // The volatile feed is the real-time source and must be up before we
    // prompt. The durable log is supplementary: local servers run without
    // event persistence, so it only ever yields `log.synced`, and a server
    // that never syncs it must not take the whole conversation down.
    await withTimeout(
      this.globalEvents.ready,
      15_000,
      "OpenCode v2 event stream (/api/event) did not become ready."
    );
    const logReady = await withTimeout(rootLog.ready, 3_000, "").then(
      () => true,
      () => false
    );
    if (!logReady) {
      harnessLog({
        level: "warning",
        backendId: this.backend.id,
        conversationId: this.callbacks.conversation.id,
        event: "session.log_not_synced",
        detail: "Durable session log did not sync within 3s; continuing on the volatile event stream.",
      });
    }
    await this.discoverActiveChildren();
    this.startPermissionPolling();
    await this.callbacks.updateConversation((current) => ({
      ...current,
      providerSessionId: id,
      configOptions: this.configOptions,
      capabilities: this.capabilities,
      status: this.autonomousTurn && !this.autonomousTurn.completed ? "running" : "idle",
      pendingPermission: null,
      pendingQuestion: null,
      lastError: null,
    }));
  }

  async prompt(input: {
    text: string;
    userMessageId: string;
    attachments?: Array<{ mimeType: string; data: string; name?: string }>;
  }): Promise<void> {
    const client = this.connection?.client;
    if (!client) {
      throw new Error("OpenCode v2 Beta session is not initialized.");
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
      backendId: this.backend.id,
    });
    const text = appendAgentPluginPrompt(recovery?.userText ?? input.text, pluginAttachments);
    const images = await materializeImageAttachments(input.attachments, this.backend.id);
    const active = createActivePrompt(`opencode-v2-${input.userMessageId}`);
    this.activePrompt = active;
    await this.callbacks.updateConversation((current) => ({
      ...current,
      status: "running",
      pendingPermission: null,
      pendingQuestion: null,
      lastError: null,
    }));
    try {
      try {
        await client.sendPrompt(this.sessionId, {
          id: `msg_cesium_${input.userMessageId}`,
          text,
          ...(images.paths.length > 0
            ? {
                files: images.paths.map((filePath) => ({
                  uri: pathToFileURL(filePath).href,
                })),
              }
            : {}),
          metadata: { source: "cesium", conversationId: this.callbacks.conversation.id },
          delivery: "steer",
        });
      } catch (error) {
        if (!(error instanceof OpenCodeV2Error) || error.status !== 409) {
          throw error;
        }
      }
      const waitController = new AbortController();
      this.waitController?.abort();
      this.waitController = waitController;
      const wait = this.waitForTurn(client, active, waitController.signal)
        .then(() => this.reconcileActivePrompt(active))
        .catch((error) => {
          if (!waitController.signal.aborted) {
            this.reportStreamError(
              error instanceof Error ? error : new Error(String(error))
            );
          }
        });
      await Promise.race([active.promise, wait.then(() => active.promise)]);
      await active.promise;
      waitController.abort();
      if (this.waitController === waitController) {
        this.waitController = null;
      }
      if (active.cancelled) return;
      await this.callbacks.appendEvents([
        {
          eventId: randomUUID(),
          conversationId: this.callbacks.conversation.id,
          kind: "status",
          status: "idle",
          detail: "OpenCode v2 Beta turn complete.",
        },
      ]);
      await this.callbacks.updateConversation((current) => ({
        ...current,
        status: "idle",
        pendingPermission: null,
        pendingQuestion: null,
        lastError: null,
        providerSessionId: this.sessionId,
      }));
    } catch (error) {
      if (active.cancelled) return;
      await client.interruptSession(this.sessionId).catch(() => undefined);
      const message = error instanceof Error ? error.message : "OpenCode v2 Beta prompt failed.";
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
        pendingQuestion: null,
        lastError: message,
      }));
      throw error;
    } finally {
      this.waitController?.abort();
      this.waitController = null;
      if (this.activePrompt === active) this.activePrompt = null;
      await images.cleanup();
    }
  }

  async cancel(): Promise<void> {
    this.waitController?.abort();
    this.waitController = null;
    const active = this.activePrompt;
    if (active && !active.completed) {
      active.cancelled = true;
      active.completed = true;
      active.reject(new Error("OpenCode v2 Beta session interrupted."));
    }
    this.activePrompt = null;
    const autonomous = this.autonomousTurn;
    if (autonomous && !autonomous.completed) {
      // The server-side interrupt below settles it; close our message now so
      // the cancelled status written here is not overwritten by a late event.
      autonomous.completed = true;
      autonomous.cancelled = true;
      autonomous.resolve();
      if (autonomous.emittedText) {
        await this.callbacks.appendEvents([
          {
            eventId: randomUUID(),
            conversationId: this.callbacks.conversation.id,
            kind: "assistant_message_end",
            messageId: autonomous.messageId,
            stopReason: "cancelled",
          },
        ]);
      }
    }
    this.autonomousTurn = null;
    await this.connection?.client.interruptSession(this.sessionId).catch(() => undefined);
    await this.callbacks.appendEvents([
      {
        eventId: randomUUID(),
        conversationId: this.callbacks.conversation.id,
        kind: "status",
        status: "cancelled",
        detail: "OpenCode v2 Beta session interrupted.",
      },
    ]);
    await this.callbacks.updateConversation((current) => ({
      ...current,
      status: "cancelled",
      pendingPermission: null,
      pendingQuestion: null,
    }));
  }

  async setConfigOption(configId: string, value: string): Promise<void> {
    const client = this.connection?.client;
    if (
      client &&
      (configId === "agent" || configId === "mode") &&
      value &&
      value !== "__default__" &&
      value !== "auto"
    ) {
      await client.switchAgent(this.sessionId, value);
    }
    const model = configId === "model" ? parseOpenCodeV2ModelRef(value) : undefined;
    if (client && model) {
      await client.switchModel(this.sessionId, model);
    }
    const storedConfigId = configId === "mode" ? "agent" : configId;
    this.configOptions = updateConfigOption(this.configOptions, storedConfigId, value);
    await this.callbacks.updateConversation((current) => {
      const next = { ...current, configOptions: this.configOptions };
      if (configId === "model") {
        next.config = {
          ...next.config,
          modelId: value,
          modelName: optionName(this.configOptions, configId, value),
        };
      } else if (configId === "agent" || configId === "mode") {
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
    const client = this.connection?.client;
    if (!client) return;
    const sessionId = this.permissionSessions.get(input.requestId);
    if (!sessionId) {
      throw new Error(`OpenCode v2 permission request ${input.requestId} is no longer pending.`);
    }
    const context = this.pendingPermissionContext.get(input.requestId);
    this.pendingPermissionContext.delete(input.requestId);
    if (
      !input.cancelled &&
      context &&
      isPersistentPermissionOptionId(input.optionId)
    ) {
      await persistRememberedPermissionChoice({
        workspaceId: this.callbacks.workspace.id,
        backendId: this.backend.id,
        toolKey: context.toolKey,
        toolLabel: context.toolLabel,
        optionId: input.optionId,
        optionKind: input.optionId,
      });
    }
    this.answeringPermissionIds.add(input.requestId);
    try {
      await client.answerPermission(
        sessionId,
        input.requestId,
        openCodeV2PermissionReply(input.optionId, input.cancelled)
      );
    } catch (error) {
      this.answeringPermissionIds.delete(input.requestId);
      if (error instanceof OpenCodeV2Error && (error.status === 404 || error.status === 410)) {
        // Already resolved server-side (another client answered, or the tool
        // was interrupted). Treat as settled rather than leaving the prompt up.
        harnessLog({
          level: "warning",
          backendId: this.backend.id,
          conversationId: this.callbacks.conversation.id,
          event: "permission.answer_stale",
          detail: `Permission ${input.requestId} was no longer pending on the server (${error.status}).`,
        });
      } else {
        harnessLog({
          level: "error",
          backendId: this.backend.id,
          conversationId: this.callbacks.conversation.id,
          event: "permission.answer_failed",
          detail: error instanceof Error ? error.message : String(error),
          data: { requestId: input.requestId, sessionId },
        });
        throw error;
      }
    }
    harnessLog({
      backendId: this.backend.id,
      conversationId: this.callbacks.conversation.id,
      event: "permission.answered",
      detail: `Permission ${input.requestId} resolved on session ${sessionId}.`,
      data: { optionId: input.optionId ?? null, cancelled: Boolean(input.cancelled) },
    });
    this.forgetPermission(input.requestId);
    // Keep the "answering" marker briefly so the echoed permission.replied is ignored.
    setTimeout(() => this.answeringPermissionIds.delete(input.requestId), 30_000).unref?.();
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

  async answerQuestion(input: { questionId: string; answer: string }): Promise<void> {
    const client = this.connection?.client;
    const interaction = this.pendingInteractions.get(input.questionId);
    if (!client || !interaction) return;
    if (interaction.kind === "question") {
      await client.answerQuestion(
        interaction.request.sessionId,
        interaction.request.id,
        questionAnswers(interaction.request, input.answer)
      );
    } else {
      await client.answerForm(
        interaction.request.sessionId,
        interaction.request.id,
        formAnswers(interaction.request, input.answer),
        interaction.request.location
      );
    }
    this.pendingInteractions.delete(input.questionId);
    await this.callbacks.appendEvents([
      questionEventForInteraction(
        interaction,
        this.callbacks.conversation.id,
        "answered",
        input.answer
      ),
      {
        eventId: randomUUID(),
        conversationId: this.callbacks.conversation.id,
        kind: "status",
        status: "running",
        detail: "OpenCode v2 input submitted.",
      },
    ]);
    await this.callbacks.updateConversation((current) => ({
      ...current,
      status: "running",
      pendingQuestion: null,
    }));
  }

  async dispose(): Promise<void> {
    this.disposed = true;
    this.waitController?.abort();
    this.waitController = null;
    const active = this.activePrompt;
    if (active && !active.completed) {
      active.cancelled = true;
      active.completed = true;
      active.reject(new Error("OpenCode v2 Beta session disposed."));
    }
    this.activePrompt = null;
    if (this.autonomousTurn && !this.autonomousTurn.completed) {
      this.autonomousTurn.completed = true;
      this.autonomousTurn.resolve();
    }
    this.autonomousTurn = null;
    await this.closeStreamsAndConnection();
  }

  private async refreshConfigOptions(
    client: OpenCodeV2Client,
    session: OpenCodeV2Json | null
  ): Promise<void> {
    const [agents, models] = await Promise.all([
      client.listAgents(this.callbacks.workspace.root).catch(() => []),
      client.listModels(this.callbacks.workspace.root).catch(() => []),
    ]);
    if (agents.length === 0 && models.length === 0 && this.configOptions.length > 0) {
      return;
    }
    this.configOptions = buildOpenCodeV2ConfigOptions({
      agents,
      models,
      currentAgent:
        asString(session?.agent) ??
        optionValue(this.configOptions, "agent", this.callbacks.conversation.config.mode),
      currentModel:
        modelValue(session?.model) ??
        optionValue(this.configOptions, "model", this.callbacks.conversation.config.modelId),
      previous: this.configOptions,
    });
    await writeAgentBackendConfigCache(this.backend.id, this.configOptions).catch(
      () => undefined
    );
  }

  private async seedContextIfNeeded(userMessageId: string): Promise<void> {
    if (this.seededContext) return;
    const snapshot = await this.callbacks.readSnapshot();
    const transcript = transcriptText(snapshot, userMessageId);
    if (!transcript) {
      this.seededContext = true;
      return;
    }
    await this.seedContextText(transcript);
  }

  private async seedContextText(transcript: string): Promise<void> {
    const client = this.connection?.client;
    if (!client || this.seededContext) return;
    this.seededContext = true;
    await client
      .addSynthetic(this.sessionId, {
        text: `Prior Cesium conversation context:\n\n${transcript}`,
        description: "Cesium conversation recovery context",
        metadata: { source: "cesium-recovery" },
        resume: false,
      })
      .catch((error) => {
        void this.callbacks.appendEvents([
          {
            eventId: randomUUID(),
            conversationId: this.callbacks.conversation.id,
            kind: "system",
            level: "warning",
            text: `OpenCode v2 context seeding failed: ${
              error instanceof Error ? error.message : String(error)
            }`,
          },
        ]);
      });
  }

  /**
   * `POST /api/session/:id/wait` blocks until the execution settles. A long
   * turn can outlive proxies, runtime idle timers or a server hiccup; while the
   * turn is still running, re-issue the wait instead of losing the completion
   * signal that reconciliation depends on.
   */
  private async waitForTurn(
    client: OpenCodeV2Client,
    active: ActivePrompt,
    signal: AbortSignal
  ): Promise<void> {
    let failures = 0;
    while (!signal.aborted && !active.completed && !active.cancelled) {
      try {
        await client.waitForSession(this.sessionId, signal);
        return;
      } catch (error) {
        if (signal.aborted || active.completed || active.cancelled) return;
        failures += 1;
        if (error instanceof OpenCodeV2Error && error.status === 404) {
          throw error;
        }
        if (failures >= 5) {
          throw error;
        }
        harnessLog({
          level: "warning",
          backendId: this.backend.id,
          conversationId: this.callbacks.conversation.id,
          event: "wait.retry",
          detail: `Session wait failed (${error instanceof Error ? error.message : String(error)}); retrying (${failures}).`,
        });
        await new Promise((resolve) => setTimeout(resolve, Math.min(500 * failures, 3_000)));
        // The server may have finished in the gap; do not block on a wait
        // that will never return for an already-idle session.
        const active_ = await client.listActiveSessionIds().catch(() => null);
        if (active_ && !active_.includes(this.sessionId)) return;
      }
    }
  }

  private async reconcileActivePrompt(active: ActivePrompt): Promise<void> {
    if (
      active.completed ||
      active.cancelled ||
      this.activePrompt !== active ||
      !this.connection
    ) {
      return;
    }
    // `wait` resolves the moment the server finishes; the volatile stream is
    // usually a few frames behind (final text, execution.succeeded). Let it
    // settle the turn itself before reading the message list, so reconciliation
    // only fills gaps the stream actually left.
    const settled = await Promise.race([
      active.promise.then(() => true, () => true),
      new Promise<false>((resolve) => {
        const timer = setTimeout(() => resolve(false), openCodeV2WaitSettleGraceMs());
        timer.unref?.();
      }),
    ]);
    if (settled || active.completed || active.cancelled || this.activePrompt !== active || !this.connection) {
      return;
    }
    const messages = await this.connection.client.listMessages(this.sessionId, 20);
    const assistant = messages.find((message) => message.type === "assistant");
    if (!assistant) {
      await this.completeActivePrompt(active, {
        type: "cesium.opencode-v2.wait-reconciled",
      });
      return;
    }
    if (assistant.error) {
      active.completed = true;
      active.reject(new Error(eventErrorMessage(assistant.error)));
      return;
    }
    const text = Array.isArray(assistant.content)
      ? assistant.content
          .flatMap((entry) => {
            const record = asRecord(entry);
            return record?.type === "text" && typeof record.text === "string"
              ? [record.text]
              : [];
          })
          .join("")
      : "";
    const missing =
      !active.emittedText
        ? text
        : text.startsWith(active.emittedText)
          ? text.slice(active.emittedText.length)
          : "";
    if (missing) {
      active.emittedText += missing;
      await this.callbacks.appendEvents([
        {
          eventId: randomUUID(),
          conversationId: this.callbacks.conversation.id,
          kind: "assistant_message_chunk",
          messageId: active.messageId,
          text: missing,
          raw: assistant,
        },
      ]);
    }
    await this.completeActivePrompt(active, assistant);
  }

  private async discoverActiveChildren(): Promise<void> {
    const client = this.connection?.client;
    if (!client) return;
    const activeSessionIds = await client.listActiveSessionIds().catch((): string[] => []);
    await Promise.all(
      activeSessionIds
        .filter((sessionId) => sessionId !== this.sessionId)
        .map(async (sessionId) => {
          if (await this.eventChildSession(sessionId)) {
            this.startChildLog(sessionId);
          }
        })
    );
    if (activeSessionIds.includes(this.sessionId)) {
      // Resumed into a root session that is already executing (e.g. a background
      // subagent woke it while Cesium was away): its `session.execution.started`
      // predates our stream, so open the autonomous turn from the active list.
      await this.noteRootExecutionStarted({ type: "session.active", data: { sessionID: this.sessionId } });
    }
  }

  private cleanupChildSession(sessionId: string): void {
    this.completedChildSessions.add(sessionId);
    this.sessionLogs.get(sessionId)?.close();
    this.sessionLogs.delete(sessionId);
    this.sessionBelongsToRoot.delete(sessionId);
    for (const [requestId, ownerSessionId] of this.permissionSessions) {
      if (ownerSessionId === sessionId) this.permissionSessions.delete(requestId);
    }
    for (const [requestId, interaction] of this.pendingInteractions) {
      if (interaction.request.sessionId === sessionId) {
        this.pendingInteractions.delete(requestId);
      }
    }
  }

  private async closeStreamsAndConnection(): Promise<void> {
    this.stopPermissionPolling();
    this.globalEvents?.close();
    this.globalEvents = null;
    for (const stream of this.sessionLogs.values()) stream.close();
    this.sessionLogs.clear();
    await this.connection?.dispose();
    this.connection = null;
  }

  private async completeActivePrompt(active: ActivePrompt, raw: unknown): Promise<void> {
    if (active.completed || active.cancelled || this.activePrompt !== active) return;
    active.completed = true;
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

  /**
   * The volatile `/api/event` feed dropped everything published while we were
   * disconnected. Recover what matters: permissions still blocking the agent,
   * tool results (so no card is stuck "running"), and whether the root session
   * is executing (a background subagent may have woken it meanwhile).
   */
  private async reconcileAfterReconnect(): Promise<void> {
    const client = this.connection?.client;
    if (!client || this.disposed) return;
    harnessLog({
      backendId: this.backend.id,
      conversationId: this.callbacks.conversation.id,
      event: "sse.reconnected",
      detail: "OpenCode v2 event stream reconnected; reconciling missed state.",
    });
    this.reportedStreamErrors.clear();
    await this.pollPermissionsOnce().catch(() => undefined);
    const sessions = [this.sessionId, ...[...this.sessionLogs.keys()].filter((id) => id !== this.sessionId)];
    for (const sessionId of sessions) {
      if (this.disposed) return;
      const messages = await client.listMessages(sessionId, 50).catch(() => null);
      if (!messages) continue;
      const events = this.normalizer.reconcileMessages({
        conversationId: this.callbacks.conversation.id,
        sessionId,
        messages: [...messages].reverse(),
        ...(sessionId !== this.sessionId ? { childSessionId: sessionId } : {}),
      });
      if (events.length > 0) {
        harnessLog({
          backendId: this.backend.id,
          conversationId: this.callbacks.conversation.id,
          event: "sse.reconciled_tools",
          detail: `Reconciled ${events.length} tool state update(s) for ${sessionId} after reconnect.`,
        });
        await this.callbacks.appendEvents(events);
      }
    }
    const active = await client.listActiveSessionIds().catch(() => null);
    if (active?.includes(this.sessionId)) {
      await this.noteRootExecutionStarted({ type: "session.active", data: { sessionID: this.sessionId } });
    }
  }

  private reportStreamError(error: Error): void {
    if (this.disposed) return;
    harnessLog({
      level: "warning",
      backendId: this.backend.id,
      conversationId: this.callbacks.conversation.id,
      event: "sse.error",
      detail: error.message,
    });
    if (this.reportedStreamErrors.has(error.message)) return;
    this.reportedStreamErrors.add(error.message);
    void this.callbacks.appendEvents([
      {
        eventId: randomUUID(),
        conversationId: this.callbacks.conversation.id,
        kind: "system",
        level: "warning",
        text: `OpenCode v2 event stream reconnecting: ${error.message}`,
      },
    ]);
  }

  private rememberEvent(payload: OpenCodeV2Json): boolean {
    const id = asString(payload.id);
    if (!id) return true;
    if (this.seenEventIds.has(id)) return false;
    this.seenEventIds.add(id);
    if (this.seenEventIds.size > 20_000) {
      const oldest = this.seenEventIds.values().next().value as string | undefined;
      if (oldest) this.seenEventIds.delete(oldest);
    }
    return true;
  }

  private async eventChildSession(sessionId: string | undefined): Promise<string | undefined> {
    if (!sessionId || sessionId === this.sessionId) return undefined;
    const known = this.sessionBelongsToRoot.get(sessionId);
    if (known != null) return known ? sessionId : undefined;
    const client = this.connection?.client;
    if (!client) return undefined;
    let current: string | undefined = sessionId;
    const visited = new Set<string>();
    for (let depth = 0; depth < 48 && current && !visited.has(current); depth += 1) {
      visited.add(current);
      if (current === this.sessionId) {
        this.sessionBelongsToRoot.set(sessionId, true);
        return sessionId;
      }
      const row = await client.getSession(current).catch(() => null);
      current = asString(row?.parentID);
    }
    this.sessionBelongsToRoot.set(sessionId, false);
    return undefined;
  }

  private startChildLog(sessionId: string): void {
    const client = this.connection?.client;
    if (
      !client ||
      this.sessionLogs.has(sessionId) ||
      this.completedChildSessions.has(sessionId)
    ) return;
    this.sessionBelongsToRoot.set(sessionId, true);
    const stream = startOpenCodeV2SessionLog({
      client,
      sessionId,
      replayExisting: true,
      reconnectOnCleanClose: false,
      onEvent: (event) => this.handleEvent(event),
      onError: (error) => this.reportStreamError(error),
    });
    this.sessionLogs.set(sessionId, stream);
  }

  /**
   * Apply remembered/auto-accept rules or park the request as the pending
   * permission. Shared by the SSE path and the polling fallback.
   */
  private async surfacePermissionRequest(
    permission: Extract<AgentEventInput, { kind: "permission_request" }>
  ): Promise<"auto_resolved" | "pending"> {
    const toolKey = buildRememberedPermissionToolKey(
      "opencode-v2",
      permission.title,
      permission.detail
    );
    const toolLabel = permission.title ?? "OpenCode permission";
    const resolved = await resolveRememberedPermissionDecision({
      workspaceId: this.callbacks.workspace.id,
      backendId: this.backend.id,
      toolKey,
      options: permission.options,
    });
    if (resolved.kind === "remembered" || resolved.kind === "auto_accept") {
      const ownerSessionId = this.permissionSessions.get(permission.requestId);
      const optionId =
        resolved.kind === "remembered"
          ? resolved.providerOptionId ??
            (resolved.decision === "allow" ? "allow" : "deny")
          : resolved.providerOptionId ?? "allow";
      if (ownerSessionId && this.connection?.client) {
        await this.connection.client
          .answerPermission(
            ownerSessionId,
            permission.requestId,
            openCodeV2PermissionReply(optionId, false)
          )
          .catch(() => undefined);
      }
      this.forgetPermission(permission.requestId);
      await this.callbacks.appendEvents([
        {
          eventId: randomUUID(),
          conversationId: this.callbacks.conversation.id,
          kind: "permission_resolved",
          requestId: permission.requestId,
          outcome: "selected",
          optionId:
            resolved.kind === "remembered" ? resolved.rule.optionId : optionId,
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
      return "auto_resolved";
    }
    this.pendingPermissionContext.set(permission.requestId, { toolKey, toolLabel });
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
    return "pending";
  }

  /** Drop all bookkeeping for a permission that is no longer pending. */
  private forgetPermission(requestId: string): void {
    this.permissionSessions.delete(requestId);
    this.pendingPermissionContext.delete(requestId);
    this.resolvedPermissionIds.add(requestId);
    if (this.resolvedPermissionIds.size > 1_000) {
      const oldest = this.resolvedPermissionIds.values().next().value as string | undefined;
      if (oldest) this.resolvedPermissionIds.delete(oldest);
    }
  }

  /**
   * `permission.replied` for a request we did not answer ourselves: another
   * client (TUI, desktop, ...) sharing the server resolved it. Clear the prompt
   * so Cesium does not sit in `awaiting_permission` for a decision already made.
   */
  private async handleExternalPermissionReply(payload: OpenCodeV2Json): Promise<void> {
    const data = asRecord(payload.data);
    const requestId = asString(data?.requestID) ?? asString(data?.id);
    if (!requestId || !this.permissionSessions.has(requestId)) return;
    if (this.answeringPermissionIds.has(requestId)) return;
    const reply = asString(data?.reply);
    this.forgetPermission(requestId);
    harnessLog({
      backendId: this.backend.id,
      conversationId: this.callbacks.conversation.id,
      event: "permission.replied_externally",
      detail: `Permission ${requestId} was resolved outside Cesium (reply: ${reply ?? "unknown"}).`,
    });
    await this.callbacks.appendEvents([
      {
        eventId: randomUUID(),
        conversationId: this.callbacks.conversation.id,
        kind: "permission_resolved",
        requestId,
        outcome: reply === "reject" ? "cancelled" : "selected",
        ...(reply ? { optionId: reply === "always" ? "allow_always" : reply === "reject" ? "deny" : "allow" } : {}),
        raw: payload,
      },
    ]);
    await this.callbacks.updateConversation((current) => {
      if (current.pendingPermission && current.pendingPermission.requestId !== requestId) {
        return current;
      }
      return {
        ...current,
        status:
          this.permissionSessions.size > 0
            ? "awaiting_permission"
            : this.activePrompt && !this.activePrompt.completed
              ? "running"
              : current.status === "awaiting_permission"
                ? "running"
                : current.status,
        pendingPermission: null,
      };
    });
  }

  /**
   * `/api/event` is volatile by contract (a slow consumer or a reconnect drops
   * events), so a `permission.asked` can be missed while OpenCode blocks on
   * it forever. `GET /api/permission/request` lists what is still pending for
   * this workspace; poll it while a turn is running or a prompt is pending.
   */
  private startPermissionPolling(): void {
    if (this.permissionPollTimer || this.permissionPollDisabled) return;
    this.permissionPollTimer = setInterval(() => {
      void this.pollPermissionsOnce();
    }, openCodeV2PermissionPollIntervalMs());
    this.permissionPollTimer.unref?.();
  }

  private stopPermissionPolling(): void {
    if (this.permissionPollTimer) {
      clearInterval(this.permissionPollTimer);
      this.permissionPollTimer = null;
    }
    this.permissionPollBusy = false;
  }

  private async pollPermissionsOnce(): Promise<void> {
    const client = this.connection?.client;
    if (this.disposed || !client || this.permissionPollDisabled || this.permissionPollBusy) return;
    const turnActive = Boolean(this.activePrompt && !this.activePrompt.completed);
    if (!turnActive && this.permissionSessions.size === 0 && this.sessionLogs.size <= 1) return;
    this.permissionPollBusy = true;
    try {
      let entries: OpenCodeV2Json[];
      try {
        entries = await client.listPendingPermissions(this.callbacks.workspace.root);
      } catch (error) {
        if (error instanceof OpenCodeV2Error && error.status === 404) {
          this.permissionPollDisabled = true;
          this.stopPermissionPolling();
          return;
        }
        this.permissionPollFailures += 1;
        if (this.permissionPollFailures === 1 || this.permissionPollFailures % 20 === 0) {
          harnessLog({
            level: "warning",
            backendId: this.backend.id,
            conversationId: this.callbacks.conversation.id,
            event: "permission.poll_failed",
            detail: `${error instanceof Error ? error.message : String(error)} (attempt ${this.permissionPollFailures})`,
          });
        }
        return;
      }
      this.permissionPollFailures = 0;
      for (const entry of entries) {
        const requestId = asString(entry.id);
        const ownerSessionId = asString(entry.sessionID);
        if (!requestId || !ownerSessionId) continue;
        if (this.permissionSessions.has(requestId) || this.resolvedPermissionIds.has(requestId)) continue;
        const childSessionId = await this.eventChildSession(ownerSessionId);
        if (ownerSessionId !== this.sessionId && !childSessionId) continue;
        if (this.disposed) return;
        this.permissionSessions.set(requestId, ownerSessionId);
        harnessLog({
          backendId: this.backend.id,
          conversationId: this.callbacks.conversation.id,
          event: "permission.requested",
          detail: `OpenCode v2 permission ${requestId} discovered by polling.`,
          data: { sessionId: ownerSessionId },
        });
        const event = openCodeV2PermissionRequestEvent({
          conversationId: this.callbacks.conversation.id,
          request: entry,
        });
        await this.callbacks.appendEvents([event]);
        await this.surfacePermissionRequest(event);
      }
    } finally {
      this.permissionPollBusy = false;
    }
  }

  private async handleEvent(payload: OpenCodeV2Json): Promise<void> {
    if (this.disposed) return;
    const type = asString(payload.type);
    if (
      type &&
      ["agent.updated", "catalog.updated", "integration.updated", "models-dev.refreshed"].includes(type)
    ) {
      if (!eventMatchesWorkspace(payload, this.callbacks.workspace.root)) return;
      if (!this.rememberEvent(payload) || !this.connection) return;
      await this.refreshConfigOptions(this.connection.client, null);
      await this.callbacks.updateConversation((current) => ({
        ...current,
        configOptions: this.configOptions,
      }));
      return;
    }
    const sessionId = openCodeV2EventSessionId(payload);
    const data = asRecord(payload.data);
    if (type === "session.created" && sessionId && sessionId !== this.sessionId) {
      // A child announces its parent in `session.created`; trusting it avoids a
      // GET /api/session round-trip per subagent (and any race with the tool
      // progress event that also names the child).
      const parentId = asString(data?.parentID);
      if (parentId && this.sessionBelongsToRoot.get(parentId) === true) {
        this.sessionBelongsToRoot.set(sessionId, true);
      }
    }
    const form = readOpenCodeV2FormRequest(payload);
    const globalForm =
      form?.sessionId === "global" &&
      eventMatchesWorkspace(payload, this.callbacks.workspace.root);
    const childSessionId = globalForm
      ? undefined
      : await this.eventChildSession(sessionId);
    if (
      sessionId &&
      sessionId !== this.sessionId &&
      !childSessionId &&
      !globalForm
    ) {
      return;
    }
    if (!this.rememberEvent(payload)) return;
    if (childSessionId) {
      this.startChildLog(childSessionId);
    }

    const spawnedChild = openCodeV2ChildSessionId(payload);
    if (spawnedChild && sessionId === this.sessionId) {
      this.sessionBelongsToRoot.set(spawnedChild, true);
      this.startChildLog(spawnedChild);
    }

    if (type === "permission.replied") {
      await this.handleExternalPermissionReply(payload);
      return;
    }
    const permissionData = readOpenCodeV2PermissionRequest(payload);
    const permissionRequest = permissionData ? asString(permissionData.id) : undefined;
    if (permissionRequest && sessionId) {
      if (this.permissionSessions.has(permissionRequest)) {
        // Already surfaced (e.g. discovered by polling before the event landed).
        return;
      }
      this.permissionSessions.set(permissionRequest, sessionId);
      harnessLog({
        backendId: this.backend.id,
        conversationId: this.callbacks.conversation.id,
        event: "permission.requested",
        detail: `OpenCode v2 requested permission ${permissionRequest}.`,
        data: { sessionId },
      });
    }
    const question = readOpenCodeV2QuestionRequest(payload);
    if (question) {
      this.pendingInteractions.set(question.id, { kind: "question", request: question, raw: payload });
    }
    if (form) {
      this.pendingInteractions.set(form.id, { kind: "form", request: form, raw: payload });
    }

    if (sessionId === this.sessionId && type === "session.execution.started") {
      await this.noteRootExecutionStarted(payload);
    }
    const rootTurn = this.currentRootTurn();
    const events = this.normalizer.normalize({
      conversationId: this.callbacks.conversation.id,
      rootSessionId: this.sessionId,
      payload,
      rootMessageId: rootTurn?.messageId,
      childSessionId,
    });
    const subagentNotice =
      sessionId === this.sessionId ? backgroundSubagentNotice(payload, this.callbacks.conversation.id) : undefined;
    if (subagentNotice) events.push(subagentNotice);
    if (events.length > 0) {
      // Record emitted text BEFORE the storage write: `wait` can resolve while
      // that write is in flight, and reconcileActivePrompt would otherwise see
      // an empty transcript and append the same text a second time.
      if (rootTurn) {
        for (const event of events) {
          if (
            event.kind === "assistant_message_chunk" &&
            event.messageId === rootTurn.messageId
          ) {
            rootTurn.emittedText += event.text;
          }
        }
      }
      await this.callbacks.appendEvents(events);
    }
    const permission = events.find((event) => event.kind === "permission_request");
    if (permission?.kind === "permission_request") {
      const handled = await this.surfacePermissionRequest(permission);
      if (handled === "auto_resolved") return;
    }
    const questionEvent = events.find((event) => event.kind === "question" && event.status === "pending");
    if (questionEvent?.kind === "question") {
      await this.callbacks.updateConversation((current) => ({
        ...current,
        status: "awaiting_question",
        pendingQuestion: {
          questionId: questionEvent.questionId,
          requestedAt: Date.now(),
        },
      }));
    }

    if (childSessionId) {
      if (
        type === "session.execution.succeeded" ||
        type === "session.execution.failed" ||
        type === "session.execution.interrupted"
      ) {
        this.cleanupChildSession(childSessionId);
      }
      return;
    }
    if (sessionId !== this.sessionId) return;
    const autonomous = this.autonomousTurn;
    if (autonomous && !autonomous.completed) {
      if (
        type === "session.execution.succeeded" ||
        type === "session.execution.failed" ||
        type === "session.execution.interrupted"
      ) {
        await this.finishAutonomousTurn(autonomous, type, payload);
      }
      return;
    }
    const active = this.activePrompt;
    if (!active || active.completed || active.cancelled) return;
    if (type === "session.execution.succeeded") {
      await this.completeActivePrompt(active, payload);
    } else if (type === "session.execution.failed") {
      active.completed = true;
      active.reject(new Error(eventErrorMessage(asRecord(payload.data)?.error)));
    } else if (type === "session.execution.interrupted") {
      active.cancelled = true;
      active.completed = true;
      active.reject(new Error("OpenCode v2 execution was interrupted."));
    }
  }

  /** The turn that root-session assistant output should be attributed to right now. */
  private currentRootTurn(): ActivePrompt | null {
    const active = this.activePrompt;
    if (active && !active.completed && !active.cancelled) return active;
    const autonomous = this.autonomousTurn;
    return autonomous && !autonomous.completed ? autonomous : null;
  }

  /**
   * OpenCode started executing the root session without a Cesium prompt in
   * flight: a background subagent finished and its synthetic completion
   * message woke the parent. Open an assistant message for that output and
   * mark the conversation running until the execution settles.
   */
  private async noteRootExecutionStarted(payload: OpenCodeV2Json): Promise<void> {
    const active = this.activePrompt;
    if (active && !active.completed && !active.cancelled) return;
    if (this.autonomousTurn && !this.autonomousTurn.completed) return;
    const turn = createActivePrompt(`opencode-v2-autonomous-${randomUUID()}`);
    // Nothing awaits an autonomous turn; keep its promise from becoming an
    // unhandled rejection if the execution fails.
    turn.promise.catch(() => undefined);
    this.autonomousTurn = turn;
    harnessLog({
      backendId: this.backend.id,
      conversationId: this.callbacks.conversation.id,
      event: "session.autonomous_execution",
      detail: "OpenCode v2 resumed the root session without a Cesium prompt (background work completed).",
    });
    await this.callbacks.appendEvents([
      {
        eventId: randomUUID(),
        conversationId: this.callbacks.conversation.id,
        kind: "status",
        status: "running",
        detail: "OpenCode resumed after background work completed.",
        raw: payload,
      },
    ]);
    await this.callbacks.updateConversation((current) => ({
      ...current,
      status: "running",
      lastError: null,
    }));
  }

  private async finishAutonomousTurn(
    turn: ActivePrompt,
    type: string,
    payload: OpenCodeV2Json
  ): Promise<void> {
    if (turn.completed) return;
    turn.completed = true;
    if (this.autonomousTurn === turn) this.autonomousTurn = null;
    const failed = type === "session.execution.failed";
    const interrupted = type === "session.execution.interrupted";
    const errorMessage = failed
      ? eventErrorMessage(asRecord(payload.data)?.error)
      : interrupted
        ? "OpenCode v2 execution was interrupted."
        : undefined;
    const events: AgentEventInput[] = [];
    if (turn.emittedText) {
      events.push({
        eventId: randomUUID(),
        conversationId: this.callbacks.conversation.id,
        kind: "assistant_message_end",
        messageId: turn.messageId,
        stopReason: failed ? "error" : interrupted ? "cancelled" : "completed",
        raw: payload,
      });
    }
    if (errorMessage) {
      events.push({
        eventId: randomUUID(),
        conversationId: this.callbacks.conversation.id,
        kind: "system",
        level: "error",
        text: errorMessage,
        raw: payload,
      });
    }
    events.push({
      eventId: randomUUID(),
      conversationId: this.callbacks.conversation.id,
      kind: "status",
      status: failed ? "failed" : interrupted ? "cancelled" : "idle",
      detail: failed
        ? errorMessage
        : interrupted
          ? "OpenCode v2 background turn interrupted."
          : "OpenCode v2 background turn complete.",
      raw: payload,
    });
    await this.callbacks.appendEvents(events);
    if (failed) {
      turn.reject(new Error(errorMessage));
    } else {
      turn.resolve();
    }
    await this.callbacks.updateConversation((current) => {
      // A user prompt may have started meanwhile; never clobber its status.
      if (this.activePrompt && !this.activePrompt.completed) return current;
      return {
        ...current,
        status: failed ? "failed" : interrupted ? "cancelled" : "idle",
        pendingPermission: this.permissionSessions.size > 0 ? current.pendingPermission : null,
        lastError: failed ? errorMessage ?? null : current.lastError,
      };
    });
  }
}

/**
 * A background subagent finishing shows up as a synthetic inbox item on the
 * parent (`item.type === "synthetic"`, `metadata.source === "subagent"`).
 * Surface it so the user can see why the agent woke up.
 */
function backgroundSubagentNotice(
  payload: OpenCodeV2Json,
  conversationId: string
): AgentEventInput | undefined {
  if (payload.type !== "session.inbox.enqueued") return undefined;
  const item = asRecord(asRecord(payload.data)?.item);
  if (item?.type !== "synthetic") return undefined;
  const itemPayload = asRecord(item.payload);
  const metadata = asRecord(itemPayload?.metadata);
  if (metadata?.source !== "subagent") return undefined;
  const description = asString(itemPayload?.description) ?? "subagent";
  const state = asString(metadata.state) ?? "completed";
  const agent = asString(metadata.agent);
  return {
    eventId: randomUUID(),
    conversationId,
    kind: "system",
    level: state === "completed" ? "info" : "warning",
    text: `Background subagent "${description}"${agent ? ` (${agent})` : ""} ${state}.`,
    raw: payload,
  };
}

export function createOpenCodeV2Provider(input: {
  backend: AgentBackendInfo;
  configOptions: AgentConfigOption[];
}): AgentProvider {
  return {
    backend: input.backend,
    async startSession(callbacks) {
      const handle = new OpenCodeV2SessionHandle(input.backend, callbacks, input.configOptions);
      await handle.initialize();
      return handle;
    },
    async loadSession(callbacks, providerSessionId) {
      const handle = new OpenCodeV2SessionHandle(
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
