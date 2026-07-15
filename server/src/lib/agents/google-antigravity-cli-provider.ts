import { randomUUID } from "node:crypto";
import type { CliRuntimeSpec } from "./cli-adapter.js";
import {
  antigravityEventToAgentEvents,
  antigravityFinishToolEvent,
  antigravityPermissionRequestId,
  antigravityPlanArtifactFromTool,
  antigravityStartToolEvent,
  antigravityToolSnapshotFromEvent,
  type GoogleAntigravityToolSnapshot,
} from "./google-antigravity-cli-normalize.js";
import {
  GoogleAntigravityEventBus,
  startGoogleAntigravitySession,
  type GoogleAntigravityEvent,
  type GoogleAntigravityPermissionMode,
  type GoogleAntigravitySession,
} from "./google-antigravity-cli-session.js";
import {
  providerPlanEvents,
  writeProviderPlanArtifact,
} from "./plan-artifacts.js";
import {
  appendAgentPluginPrompt,
  resolveAgentPluginAttachments,
} from "../plugins/attachments.js";
import type {
  AgentBackendInfo,
  AgentConfigOption,
  AgentConversationRecord,
  AgentEventInput,
  AgentProvider,
  AgentProviderCapabilities,
  AgentRuntimeCallbacks,
  AgentSessionHandle,
} from "./types.js";

type GoogleAntigravityHandleInput = {
  backend: AgentBackendInfo;
  runtime: CliRuntimeSpec;
  callbacks: AgentRuntimeCallbacks;
  configOptions: AgentConfigOption[];
  providerSessionId?: string | null;
};

function withCurrentConfig(
  configOptions: AgentConfigOption[],
  conversation: AgentConversationRecord
): AgentConfigOption[] {
  return configOptions.map((option) => {
    if (option.category === "model") {
      return { ...option, currentValue: conversation.config.modelId || option.currentValue };
    }
    if (option.category === "mode") {
      return { ...option, currentValue: conversation.config.mode || option.currentValue };
    }
    return option;
  });
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

function optionDisplayName(configOptions: AgentConfigOption[], configId: string, value: string): string {
  return configOptions
    .find((option) => option.id === configId)
    ?.options.find((option) => option.value === value)?.name ?? value;
}

function optionValue(
  configOptions: AgentConfigOption[],
  id: string,
  fallback: string
): string {
  return configOptions.find((option) => option.id === id)?.currentValue || fallback;
}

function permissionModeForConfig(
  conversation: AgentConversationRecord,
  configOptions: AgentConfigOption[]
): GoogleAntigravityPermissionMode | undefined {
  const mode = optionValue(configOptions, "mode", conversation.config.mode);
  if (mode === "ask") {
    return "strict";
  }
  const permission = optionValue(configOptions, "permission", "request-review");
  if (
    permission === "request-review" ||
    permission === "proceed-in-sandbox" ||
    permission === "always-proceed" ||
    permission === "strict"
  ) {
    return permission;
  }
  return "request-review";
}

class GoogleAntigravityCliSessionHandle implements AgentSessionHandle {
  readonly capabilities: AgentProviderCapabilities;
  sessionId: string;
  configOptions: AgentConfigOption[];

  private session: GoogleAntigravitySession | null = null;
  private bus: GoogleAntigravityEventBus | null = null;
  private eventAbortController: AbortController | null = null;
  private assistantMessageId: string | null = null;
  private assistantChunksEmitted = false;
  private disposed = false;
  private readonly toolByStep = new Map<number, GoogleAntigravityToolSnapshot>();
  private readonly permissionByRequest = new Map<string, Extract<GoogleAntigravityEvent, { type: "permission.requested" }>>();

  private constructor(
    private readonly backend: AgentBackendInfo,
    private readonly runtime: CliRuntimeSpec,
    private readonly callbacks: AgentRuntimeCallbacks,
    configOptions: AgentConfigOption[],
    private readonly providerSessionId?: string | null
  ) {
    this.capabilities = backend.capabilities;
    this.configOptions = withCurrentConfig(configOptions, callbacks.conversation);
    this.sessionId = providerSessionId ?? `google-antigravity-cli-pending-${callbacks.conversation.id}`;
  }

  static async create(input: GoogleAntigravityHandleInput): Promise<GoogleAntigravityCliSessionHandle> {
    const handle = new GoogleAntigravityCliSessionHandle(
      input.backend,
      input.runtime,
      input.callbacks,
      input.configOptions,
      input.providerSessionId
    );
    await handle.startSession(input.providerSessionId ?? undefined);
    await input.callbacks.updateConversation((current) => ({
      ...current,
      providerSessionId: input.providerSessionId ?? current.providerSessionId,
      configOptions: handle.configOptions,
      capabilities: input.backend.capabilities,
      status: "idle",
      pendingPermission: null,
      lastError: null,
    }));
    return handle;
  }

  private async startSession(providerSessionId?: string): Promise<void> {
    this.eventAbortController?.abort();
    this.eventAbortController = new AbortController();
    this.bus = new GoogleAntigravityEventBus();
    this.session = await startGoogleAntigravitySession({
      command: this.runtime.command,
      args: this.runtime.args,
      workspace: this.callbacks.workspace.root,
      env: this.runtime.env,
      bus: this.bus,
      createOptions: {
        conversationId: providerSessionId,
        permissionMode: permissionModeForConfig(this.callbacks.conversation, this.configOptions),
        sandbox: optionValue(this.configOptions, "permission", "request-review") === "proceed-in-sandbox",
        dangerouslySkipPermissions:
          optionValue(this.configOptions, "permission", "request-review") === "always-proceed",
        hookBridge: { mergeExistingHooks: false },
      },
    });
    this.sessionId = this.session.conversationId ?? providerSessionId ?? this.session.id;
    void this.consumeEvents(this.session, this.eventAbortController.signal);
  }

  private ensureAssistantMessage(): string {
    if (!this.assistantMessageId) {
      this.assistantMessageId = `google-antigravity-assistant-${randomUUID()}`;
      this.assistantChunksEmitted = false;
    }
    return this.assistantMessageId;
  }

  private async consumeEvents(
    session: GoogleAntigravitySession,
    signal: AbortSignal
  ): Promise<void> {
    try {
      for await (const event of session.events(signal)) {
        if (this.disposed) {
          break;
        }
        await this.handleAntigravityEvent(event);
      }
    } catch (error) {
      if (!this.disposed) {
        await this.callbacks.appendEvents([
          {
            eventId: randomUUID(),
            conversationId: this.callbacks.conversation.id,
            kind: "system",
            level: "warning",
            text: error instanceof Error ? error.message : String(error),
          },
        ]);
      }
    }
  }

  private async handleAntigravityEvent(event: GoogleAntigravityEvent): Promise<void> {
    if (event.type === "tool.proposed") {
      const snapshot = antigravityToolSnapshotFromEvent(event);
      this.toolByStep.set(event.stepIdx, snapshot);
      const events: AgentEventInput[] = [
        antigravityStartToolEvent({
          event,
          conversationId: this.callbacks.conversation.id,
          snapshot,
        }),
      ];
      const questionEvent = this.questionEventFromTool(event);
      if (questionEvent) {
        events.push(questionEvent);
      }
      await this.callbacks.appendEvents(events);
      if (questionEvent) {
        await this.callbacks.updateConversation((current) => ({
          ...current,
          status: "awaiting_question",
          pendingQuestion: {
            questionId: questionEvent.questionId,
            requestedAt: Date.now(),
          },
        }));
      }
      await this.maybeMirrorPlan(event);
      return;
    }

    if (event.type === "tool.finished" || event.type === "tool.failed") {
      const snapshot = this.toolByStep.get(event.stepIdx);
      await this.callbacks.appendEvents([
        antigravityFinishToolEvent({
          event,
          conversationId: this.callbacks.conversation.id,
          snapshot,
        }),
      ]);
      if (event.type === "tool.finished") {
        this.toolByStep.delete(event.stepIdx);
      }
      return;
    }

    if (event.type === "permission.requested") {
      this.permissionByRequest.set(antigravityPermissionRequestId(event), event);
    }

    const assistantMessageId = this.ensureAssistantMessage();
    let events = antigravityEventToAgentEvents({
      event,
      conversationId: this.callbacks.conversation.id,
      assistantMessageId,
    });

    if (event.type === "text.delta" || event.type === "thought.delta") {
      this.assistantChunksEmitted = true;
    }

    if (event.type === "text.final") {
      if (event.text && !this.assistantChunksEmitted) {
        events = [
          {
            eventId: randomUUID(),
            conversationId: this.callbacks.conversation.id,
            kind: "assistant_message_chunk",
            messageId: assistantMessageId,
            text: event.text,
            raw: event,
          },
          ...events,
        ];
      }
      this.assistantMessageId = null;
      this.assistantChunksEmitted = false;
    }

    if (events.length > 0) {
      await this.callbacks.appendEvents(events);
    }

    if (event.type === "conversation.resumable") {
      this.sessionId = event.conversationId;
      await this.callbacks.updateConversation((current) => ({
        ...current,
        providerSessionId: event.conversationId,
      }));
    }

    if (event.type === "auth.required") {
      await this.callbacks.updateConversation((current) => ({
        ...current,
        status: "failed",
        lastError: "Google Antigravity CLI requires ambient authentication.",
      }));
    } else if (event.type === "error") {
      const detail = event.error.message?.trim() || "Google Antigravity CLI error.";
      await this.callbacks.updateConversation((current) => ({
        ...current,
        status: "failed",
        pendingPermission: null,
        lastError: detail,
        providerSessionId: this.session?.conversationId ?? current.providerSessionId,
      }));
    } else if (event.type === "session.stopped") {
      const failed = !/complete|success|stop|idle/i.test(event.reason);
      await this.callbacks.updateConversation((current) => ({
        ...current,
        status: failed ? "failed" : "idle",
        pendingPermission: null,
        lastError: failed
          ? event.reason.trim() || current.lastError || "Google Antigravity session stopped."
          : null,
        providerSessionId: this.session?.conversationId ?? current.providerSessionId,
      }));
    } else if (event.type === "text.final") {
      await this.callbacks.updateConversation((current) => ({
        ...current,
        status: "idle",
        pendingPermission: null,
        lastError: null,
        providerSessionId: this.session?.conversationId ?? current.providerSessionId,
      }));
    } else if (event.type === "permission.requested") {
      const requestId = antigravityPermissionRequestId(event);
      await this.callbacks.updateConversation((current) => ({
        ...current,
        status: "awaiting_permission",
        pendingPermission: {
          requestId,
          requestedAt: Date.now(),
          title: event.action ? `Permission requested: ${event.action}` : "Permission requested",
          detail: [event.target, event.reason].filter(Boolean).join("\n\n") || undefined,
          options: [
            { optionId: "allow_once", name: "Allow once", kind: "allow_once" },
            { optionId: "allow_always", name: "Always allow", kind: "allow_always" },
            { optionId: "reject_once", name: "Reject once", kind: "reject_once" },
            { optionId: "reject_always", name: "Always reject", kind: "reject_always" },
          ],
        },
      }));
    }
  }

  private async maybeMirrorPlan(
    event: Extract<GoogleAntigravityEvent, { type: "tool.proposed" }>
  ): Promise<void> {
    const artifactInput = antigravityPlanArtifactFromTool(event.toolName, event.args);
    if (!artifactInput) {
      return;
    }
    const artifact = await writeProviderPlanArtifact({
      workspaceRoot: this.callbacks.workspace.root,
      backendId: "google-antigravity-cli",
      title: artifactInput.title,
      overview: artifactInput.overview,
      markdown: artifactInput.markdown,
      entries: artifactInput.entries,
      path: artifactInput.path,
    });
    await this.callbacks.appendEvents(
      providerPlanEvents({
        conversationId: this.callbacks.conversation.id,
        planId: `google-antigravity-plan-${randomUUID()}`,
        artifact,
        raw: event,
      })
    );
  }

  private questionEventFromTool(
    event: Extract<GoogleAntigravityEvent, { type: "tool.proposed" }>
  ): Extract<AgentEventInput, { kind: "question" }> | null {
    if (event.toolName !== "ask_question") {
      return null;
    }
    const prompt =
      typeof event.args.prompt === "string" && event.args.prompt.trim()
        ? event.args.prompt.trim()
        : typeof event.args.question === "string" && event.args.question.trim()
          ? event.args.question.trim()
          : "Antigravity question";
    const rawOptions = Array.isArray(event.args.options)
      ? event.args.options
      : Array.isArray(event.args.choices)
        ? event.args.choices
        : [];
    const options = rawOptions.flatMap((option, index) => {
      if (typeof option === "string" && option.trim()) {
        return [{ id: option.trim(), label: option.trim() }];
      }
      if (!option || typeof option !== "object" || Array.isArray(option)) {
        return [];
      }
      const record = option as Record<string, unknown>;
      const label =
        typeof record.label === "string" && record.label.trim()
          ? record.label.trim()
          : typeof record.name === "string" && record.name.trim()
            ? record.name.trim()
            : typeof record.value === "string" && record.value.trim()
              ? record.value.trim()
              : undefined;
      if (!label) {
        return [];
      }
      return [
        {
          id:
            typeof record.id === "string" && record.id.trim()
              ? record.id.trim()
              : `option-${index + 1}`,
          label,
        },
      ];
    });
    return {
      eventId: randomUUID(),
      conversationId: this.callbacks.conversation.id,
      kind: "question",
      questionId: `antigravity-question-${event.sessionId ?? "session"}-${event.stepIdx}`,
      prompt,
      options: options.length > 0 ? options : [{ id: "continue", label: "Continue" }],
      allowMultiple: Boolean(event.args.allowMultiple ?? event.args.allow_multiple),
      status: "pending",
      raw: event,
    };
  }

  async prompt(input: {
    text: string;
    userMessageId: string;
    attachments?: Array<{ mimeType: string; data: string; name?: string }>;
  }): Promise<void> {
    if (this.disposed) {
      throw new Error("Google Antigravity CLI session has been disposed.");
    }
    if (!this.session) {
      await this.startSession(this.callbacks.conversation.providerSessionId ?? undefined);
    }

    const warningEvents: AgentEventInput[] = [];
    if (input.attachments?.length) {
      warningEvents.push({
        eventId: randomUUID(),
        conversationId: this.callbacks.conversation.id,
        kind: "system",
        level: "warning",
        text: "Google Antigravity CLI prompt attachments are not exposed by the CLI harness yet; sending text only.",
      });
    }

    await this.callbacks.updateConversation((current) => ({
      ...current,
      status: "running",
      pendingPermission: null,
      lastError: null,
      configOptions: this.configOptions,
      providerSessionId: this.session?.conversationId ?? current.providerSessionId,
    }));
    if (warningEvents.length > 0) {
      await this.callbacks.appendEvents(warningEvents);
    }
    this.ensureAssistantMessage();
    const pluginAttachments = await resolveAgentPluginAttachments({
      workspaceId: this.callbacks.workspace.id,
      workspaceRoot: this.callbacks.workspace.root,
      backendId: "google-antigravity-cli",
    });
    this.session?.prompt(appendAgentPluginPrompt(input.text, pluginAttachments));
  }

  async cancel(): Promise<void> {
    const assistantMessageId = this.assistantMessageId;
    const emitted = this.assistantChunksEmitted;
    await this.session?.close().catch(() => undefined);
    this.session = null;
    this.eventAbortController?.abort();
    const events: AgentEventInput[] = [];
    if (assistantMessageId && emitted) {
      events.push({
        eventId: randomUUID(),
        conversationId: this.callbacks.conversation.id,
        kind: "assistant_message_end",
        messageId: assistantMessageId,
        stopReason: "cancelled",
      });
    }
    events.push({
      eventId: randomUUID(),
      conversationId: this.callbacks.conversation.id,
      kind: "status",
      status: "cancelled",
      detail: "Antigravity CLI session closed to cancel the active turn.",
    });
    await this.callbacks.appendEvents(events);
    await this.callbacks.updateConversation((current) => ({
      ...current,
      status: "cancelled",
      pendingPermission: null,
    }));
    this.assistantMessageId = null;
    this.assistantChunksEmitted = false;
  }

  async setConfigOption(configId: string, value: string): Promise<void> {
    this.configOptions = updateConfigOption(this.configOptions, configId, value);
    await this.callbacks.updateConversation((current) => {
      const next = { ...current, configOptions: this.configOptions };
      if (configId === "model") {
        next.config = {
          ...next.config,
          modelId: value,
          modelName: optionDisplayName(this.configOptions, configId, value),
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
    const selected = input.cancelled ? "reject_once" : input.optionId ?? "reject_once";
    const allow = selected === "allow_once" || selected === "allow_always";
    const pending = this.permissionByRequest.get(input.requestId);
    this.session?.prompt(allow ? "allow" : "reject");
    this.permissionByRequest.delete(input.requestId);
    await this.callbacks.appendEvents([
      {
        eventId: randomUUID(),
        conversationId: this.callbacks.conversation.id,
        kind: "permission_resolved",
        requestId: input.requestId,
        outcome: input.cancelled ? "cancelled" : "selected",
        optionId: selected,
        raw: pending,
      },
    ]);
    await this.callbacks.updateConversation((current) => ({
      ...current,
      pendingPermission: null,
      status: "running",
    }));
  }

  async answerQuestion(input: { questionId: string; answer: string }): Promise<void> {
    this.session?.prompt(input.answer);
    await this.callbacks.appendEvents([
      {
        eventId: randomUUID(),
        conversationId: this.callbacks.conversation.id,
        kind: "question",
        questionId: input.questionId,
        prompt: "",
        options: [],
        status: "answered",
        answer: input.answer,
      },
    ]);
    await this.callbacks.updateConversation((current) => ({
      ...current,
      pendingQuestion: null,
      status: "running",
    }));
  }

  async dispose(): Promise<void> {
    this.disposed = true;
    this.eventAbortController?.abort();
    await this.session?.close().catch(() => undefined);
    this.session = null;
  }
}

export function createGoogleAntigravityCliProvider(input: {
  backend: AgentBackendInfo;
  runtime: CliRuntimeSpec;
  configOptions: AgentConfigOption[];
}): AgentProvider {
  return {
    backend: input.backend,
    async startSession(callbacks) {
      return GoogleAntigravityCliSessionHandle.create({
        backend: input.backend,
        runtime: input.runtime,
        callbacks,
        configOptions: input.configOptions,
      });
    },
    async loadSession(callbacks, providerSessionId) {
      return GoogleAntigravityCliSessionHandle.create({
        backend: input.backend,
        runtime: input.runtime,
        callbacks,
        configOptions: input.configOptions,
        providerSessionId,
      });
    },
  };
}
