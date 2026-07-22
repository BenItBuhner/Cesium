import { randomUUID } from "node:crypto";
import { pathToFileURL } from "node:url";
import { asRecord, asString } from "./json-coerce.js";
import type {
  AgentBackendInfo,
  AgentConfigOption,
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
  type OpenCodeV2Client,
  type OpenCodeV2Json,
} from "./opencode-v2-client.js";
import {
  startOpenCodeV2Events,
  startOpenCodeV2SessionLog,
  type OpenCodeV2EventStream,
} from "./opencode-v2-events.js";
import {
  OpenCodeV2EventNormalizer,
  openCodeV2ChildSessionId,
  openCodeV2EventSessionId,
  openCodeV2PermissionReply,
  readOpenCodeV2FormRequest,
  readOpenCodeV2QuestionRequest,
  type OpenCodeV2FormField,
  type OpenCodeV2FormRequest,
  type OpenCodeV2QuestionRequest,
} from "./opencode-v2-normalize.js";
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

export function buildOpenCodeV2ConfigOptions(input: {
  agents: OpenCodeV2Json[];
  models: OpenCodeV2Json[];
  currentAgent?: string;
  currentModel?: string;
}): AgentConfigOption[] {
  const agents = input.agents.flatMap((agent) => {
    const id = asString(agent.id);
    const mode = asString(agent.mode);
    if (!id || agent.hidden === true || mode === "subagent") return [];
    return [
      {
        value: id,
        name: asString(agent.name) ?? id,
        ...(asString(agent.description) ? { description: asString(agent.description) } : {}),
      },
    ];
  });
  const models = input.models.flatMap((model) => {
    const providerId = asString(model.providerID);
    const id = asString(model.id) ?? asString(model.modelID);
    if (!providerId || !id || model.enabled === false) return [];
    const name = asString(model.name) ?? id;
    const base = { value: `${providerId}/${id}`, name: `${providerId}/${name}` };
    const variants = Array.isArray(model.variants)
      ? model.variants.flatMap((variant) => {
          const variantId = asString(asRecord(variant)?.id);
          return variantId
            ? [{ value: `${providerId}/${id}#${variantId}`, name: `${providerId}/${name} (${variantId})` }]
            : [];
        })
      : [];
    return [base, ...variants];
  });
  return [
    {
      id: "agent",
      name: "Agent",
      category: "mode",
      currentValue:
        input.currentAgent && agents.some((option) => option.value === input.currentAgent)
          ? input.currentAgent
          : agents[0]?.value ?? "__default__",
      description: "Primary agents reported by the OpenCode v2 server.",
      options: agents,
    },
    {
      id: "model",
      name: "Model",
      category: "model",
      currentValue:
        input.currentModel && models.some((option) => option.value === input.currentModel)
          ? input.currentModel
          : models[0]?.value ?? "auto",
      description:
        models.length > 0
          ? "Models and variants reported by the OpenCode v2 server."
          : "No OpenCode v2 models were reported. Configure provider credentials in OpenCode.",
      options: models,
    },
  ];
}

type ActivePrompt = {
  messageId: string;
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
  return { messageId, completed: false, cancelled: false, promise, resolve, reject };
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

function answerLines(answer: string, count: number): string[] {
  const lines = answer
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  if (count <= 1) {
    const value = lines.join(" ").trim();
    const colon = value.indexOf(":");
    return [colon >= 0 ? value.slice(colon + 1).trim() : value];
  }
  return Array.from({ length: count }, (_, index) => {
    const line = lines[index] ?? "";
    const colon = line.indexOf(":");
    return (colon >= 0 ? line.slice(colon + 1) : line).trim();
  });
}

function questionAnswers(request: OpenCodeV2QuestionRequest, answer: string): string[][] {
  return answerLines(answer, request.questions.length).map((line, index) =>
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
  const lines = answerLines(answer, request.fields.length);
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
    prompt: field.title ?? field.description ?? field.key,
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
    prompt: interaction.request.title,
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
  private readonly permissionSessions = new Map<string, string>();
  private readonly pendingInteractions = new Map<string, PendingInteraction>();
  private readonly reportedStreamErrors = new Set<string>();
  private seededContext = false;
  private disposed = false;
  private activePrompt: ActivePrompt | null = null;

  constructor(
    private readonly backend: AgentBackendInfo,
    private readonly callbacks: AgentRuntimeCallbacks,
    configOptions: AgentConfigOption[],
    providerSessionId?: string | null
  ) {
    this.capabilities = backend.capabilities;
    this.configOptions =
      callbacks.conversation.configOptions.length > 0
        ? callbacks.conversation.configOptions
        : configOptions;
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
    const client = this.connection.client;
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
    const session =
      existingSession ??
      (await client.createSession({
        location: { directory: this.callbacks.workspace.root },
        ...(selectedAgent && selectedAgent !== "auto" && selectedAgent !== "__default__"
          ? { agent: selectedAgent }
          : {}),
        ...(parseOpenCodeV2ModelRef(selectedModel)
          ? { model: parseOpenCodeV2ModelRef(selectedModel)! }
          : {}),
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
    });
    const rootLog = startOpenCodeV2SessionLog({
      client,
      sessionId: id,
      replayExisting: false,
      onEvent: (event) => this.handleEvent(event),
      onError: (error) => this.reportStreamError(error),
    });
    this.sessionLogs.set(id, rootLog);
    await Promise.race([
      Promise.all([this.globalEvents.ready, rootLog.ready]),
      new Promise<never>((_, reject) => {
        const timer = setTimeout(
          () => reject(new Error("OpenCode v2 event streams did not become ready.")),
          15_000
        );
        timer.unref?.();
      }),
    ]);
    await this.callbacks.updateConversation((current) => ({
      ...current,
      providerSessionId: id,
      configOptions: this.configOptions,
      capabilities: this.capabilities,
      status: "idle",
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
      backendId: "opencode-v2-beta",
    });
    const text = appendAgentPluginPrompt(recovery?.userText ?? input.text, pluginAttachments);
    const images = await materializeImageAttachments(input.attachments, "opencode-v2-beta");
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
      await client.sendPrompt(this.sessionId, {
        text,
        ...(images.paths.length > 0
          ? {
              files: images.paths.map((filePath) => ({
                uri: pathToFileURL(filePath).href,
              })),
            }
          : {}),
        metadata: { source: "cesium", conversationId: this.callbacks.conversation.id },
      });
      const wait = client.waitForSession(this.sessionId).then(async () => {
        await new Promise((resolve) => setTimeout(resolve, 750));
        if (this.activePrompt === active && !active.completed && !active.cancelled) {
          await this.completeActivePrompt(active, {
            type: "cesium.opencode-v2.wait-fallback",
          });
        }
      });
      await Promise.all([active.promise, wait]);
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
      if (this.activePrompt === active) this.activePrompt = null;
      await images.cleanup();
    }
  }

  async cancel(): Promise<void> {
    const active = this.activePrompt;
    if (active && !active.completed) {
      active.cancelled = true;
      active.completed = true;
      active.reject(new Error("OpenCode v2 Beta session interrupted."));
    }
    this.activePrompt = null;
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
    this.configOptions = updateConfigOption(this.configOptions, configId, value);
    const client = this.connection?.client;
    if (client && configId === "agent" && value && value !== "__default__" && value !== "auto") {
      await client.switchAgent(this.sessionId, value);
    }
    const model = configId === "model" ? parseOpenCodeV2ModelRef(value) : undefined;
    if (client && model) {
      await client.switchModel(this.sessionId, model);
    }
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
    const sessionId = this.permissionSessions.get(input.requestId) ?? this.sessionId;
    await client.answerPermission(
      sessionId,
      input.requestId,
      openCodeV2PermissionReply(input.optionId, input.cancelled)
    );
    this.permissionSessions.delete(input.requestId);
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
        formAnswers(interaction.request, input.answer)
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
    this.globalEvents?.close();
    this.globalEvents = null;
    for (const stream of this.sessionLogs.values()) stream.close();
    this.sessionLogs.clear();
    const active = this.activePrompt;
    if (active && !active.completed) {
      active.cancelled = true;
      active.completed = true;
      active.reject(new Error("OpenCode v2 Beta session disposed."));
    }
    this.activePrompt = null;
    await this.connection?.dispose();
    this.connection = null;
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
    });
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

  private reportStreamError(error: Error): void {
    if (this.disposed || this.reportedStreamErrors.has(error.message)) return;
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
    if (!client || this.sessionLogs.has(sessionId)) return;
    this.sessionBelongsToRoot.set(sessionId, true);
    const stream = startOpenCodeV2SessionLog({
      client,
      sessionId,
      replayExisting: true,
      onEvent: (event) => this.handleEvent(event),
      onError: (error) => this.reportStreamError(error),
    });
    this.sessionLogs.set(sessionId, stream);
  }

  private async handleEvent(payload: OpenCodeV2Json): Promise<void> {
    if (this.disposed || !this.rememberEvent(payload)) return;
    const type = asString(payload.type);
    const sessionId = openCodeV2EventSessionId(payload);
    const childSessionId = await this.eventChildSession(sessionId);
    if (sessionId && sessionId !== this.sessionId && !childSessionId) return;

    const spawnedChild = openCodeV2ChildSessionId(payload);
    if (spawnedChild && sessionId === this.sessionId) {
      this.startChildLog(spawnedChild);
    }

    const permissionRequest =
      type === "permission.v2.asked" ? asString(asRecord(payload.data)?.id) : undefined;
    if (permissionRequest && sessionId) {
      this.permissionSessions.set(permissionRequest, sessionId);
    }
    const question = readOpenCodeV2QuestionRequest(payload);
    if (question) {
      this.pendingInteractions.set(question.id, { kind: "question", request: question, raw: payload });
    }
    const form = readOpenCodeV2FormRequest(payload);
    if (form) {
      this.pendingInteractions.set(form.id, { kind: "form", request: form, raw: payload });
    }

    const events = this.normalizer.normalize({
      conversationId: this.callbacks.conversation.id,
      rootSessionId: this.sessionId,
      payload,
      rootMessageId: this.activePrompt?.messageId,
      childSessionId,
    });
    if (events.length > 0) {
      await this.callbacks.appendEvents(events);
    }
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

    if (sessionId !== this.sessionId) return;
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
