import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { promises as fs } from "node:fs";
import type { AgentSession, AgentSessionEvent, ModelRegistry } from "@earendil-works/pi-coding-agent";
import {
  applyPiRuntimeApiKeys,
  createPiAuthStorage,
  getPiAgentSessionsDirForCwd,
  hasPiAgentStoredAuthConfig,
} from "../pi-agent-settings.js";
import { AGENT_CAPABILITIES } from "./agent-contract.js";
import { piAgentEventsFromSessionEvent } from "./pi-agent-normalize.js";
import {
  findPrimaryModelConfigOption,
} from "./config-option-utils.js";
import type {
  AgentBackendInfo,
  AgentConfigOption,
  AgentConversationRecord,
  AgentEventInput,
  AgentProvider,
  AgentRuntimeCallbacks,
  AgentSessionHandle,
} from "./types.js";
import {
  appendAgentPluginPrompt,
  resolveAgentPluginAttachments,
} from "../plugins/attachments.js";

type PiAgentHandleInput = {
  backend: AgentBackendInfo;
  callbacks: AgentRuntimeCallbacks;
  configOptions: AgentConfigOption[];
  providerSessionId?: string | null;
};

const capabilities = AGENT_CAPABILITIES["pi-agent"];

function withCurrentConfig(
  configOptions: AgentConfigOption[],
  conversation: AgentConversationRecord
): AgentConfigOption[] {
  return configOptions.map((option) => {
    if (option.category === "model") {
      return {
        ...option,
        currentValue: conversation.config.modelId || option.currentValue,
      };
    }
    if (option.category === "mode") {
      return {
        ...option,
        currentValue: conversation.config.mode || option.currentValue,
      };
    }
    return option;
  });
}

function optionDisplayName(configOptions: AgentConfigOption[], configId: string, value: string): string {
  return configOptions
    .find((option) => option.id === configId)
    ?.options.find((option) => option.value === value)?.name ?? value;
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

function parseModelValue(value: string | undefined): { provider: string; modelId: string } | null {
  const trimmed = value?.trim();
  if (!trimmed || trimmed === "auto" || trimmed === "__default__") {
    return null;
  }
  const slash = trimmed.indexOf("/");
  if (slash <= 0 || slash >= trimmed.length - 1) {
    return null;
  }
  return {
    provider: trimmed.slice(0, slash).toLowerCase(),
    modelId: trimmed.slice(slash + 1),
  };
}

function thinkingLevelForConfig(
  configOptions: AgentConfigOption[]
): "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | undefined {
  const value = configOptions.find((option) => option.id === "thinking_level")?.currentValue;
  if (
    value === "off" ||
    value === "minimal" ||
    value === "low" ||
    value === "medium" ||
    value === "high" ||
    value === "xhigh"
  ) {
    return value;
  }
  return undefined;
}

function useInMemorySessions(): boolean {
  return process.env.OPENCURSOR_PI_AGENT_IN_MEMORY === "1";
}

async function resolveSessionManager(cwd: string, providerSessionId?: string | null) {
  const { SessionManager } = await import("@earendil-works/pi-coding-agent");
  if (useInMemorySessions()) {
    return SessionManager.inMemory(cwd);
  }

  const sessionDir = getPiAgentSessionsDirForCwd(cwd);
  await fs.mkdir(sessionDir, { recursive: true });

  if (providerSessionId) {
    if (providerSessionId.endsWith(".jsonl") && existsSync(providerSessionId)) {
      return SessionManager.open(providerSessionId, sessionDir, cwd);
    }
    const candidate = providerSessionId.includes("/") || providerSessionId.includes("\\")
      ? providerSessionId
      : undefined;
    if (candidate && existsSync(candidate)) {
      return SessionManager.open(candidate, sessionDir, cwd);
    }
    const sessions = await SessionManager.list(cwd, sessionDir);
    const match = sessions.find(
      (session) => session.id === providerSessionId || session.path === providerSessionId
    );
    if (match) {
      return SessionManager.open(match.path, sessionDir, cwd);
    }
  }

  return SessionManager.create(cwd, sessionDir);
}

async function resolveModel(
  conversation: AgentConversationRecord,
  configOptions: AgentConfigOption[],
  modelRegistry: ModelRegistry
) {
  const modelOption = findPrimaryModelConfigOption(configOptions);
  const parsed = parseModelValue(conversation.config.modelId || modelOption?.currentValue);
  if (parsed) {
    return modelRegistry.find(parsed.provider, parsed.modelId);
  }
  const available = modelRegistry.getAvailable();
  return available[0];
}

class PiAgentSessionHandle implements AgentSessionHandle {
  readonly capabilities = capabilities;
  sessionId: string;
  configOptions: AgentConfigOption[];

  private session: AgentSession | null = null;
  private unsubscribe: (() => void) | null = null;
  private assistantMessageId: string | null = null;
  private assistantChunksEmitted = false;
  private disposed = false;

  private constructor(
    private readonly backend: AgentBackendInfo,
    private readonly callbacks: AgentRuntimeCallbacks,
    configOptions: AgentConfigOption[]
  ) {
    this.configOptions = configOptions;
    this.sessionId = `pi-agent-pending-${callbacks.conversation.id}`;
  }

  static async create(input: PiAgentHandleInput): Promise<PiAgentSessionHandle> {
    if (!(await hasPiAgentStoredAuthConfig())) {
      throw new Error(
        "Pi Agent requires at least one provider credential. Connect OAuth or add an API key in Settings -> Agents."
      );
    }

    const configOptions = withCurrentConfig(input.configOptions, input.callbacks.conversation);
    const cwd = input.callbacks.workspace.root;
    const authStorage = await createPiAuthStorage();
    await applyPiRuntimeApiKeys(authStorage);

    const { createAgentSession, ModelRegistry } = await import("@earendil-works/pi-coding-agent");
    const { getPiAgentModelsPath } = await import("../pi-agent-settings.js");
    const modelRegistry = ModelRegistry.create(authStorage, getPiAgentModelsPath());
    modelRegistry.refresh();

    const sessionManager = await resolveSessionManager(cwd, input.providerSessionId);
    const model = await resolveModel(input.callbacks.conversation, configOptions, modelRegistry);
    const thinkingLevel = thinkingLevelForConfig(configOptions);

    const { session } = await createAgentSession({
      cwd,
      agentDir: (await import("../pi-agent-settings.js")).getPiAgentDir(),
      authStorage,
      modelRegistry,
      sessionManager,
      ...(model ? { model } : {}),
      ...(thinkingLevel ? { thinkingLevel } : {}),
      tools: ["read", "bash", "edit", "write", "grep", "find", "ls"],
    });

    const handle = new PiAgentSessionHandle(input.backend, input.callbacks, configOptions);
    handle.attachSession(session);
    await input.callbacks.updateConversation((current) => ({
      ...current,
      providerSessionId: handle.providerSessionRef(session),
      configOptions,
      capabilities,
      status: "idle",
      pendingPermission: null,
      lastError: null,
    }));
    return handle;
  }

  private providerSessionRef(session: AgentSession): string {
    return session.sessionFile ?? session.sessionId;
  }

  private attachSession(session: AgentSession): void {
    this.session = session;
    this.sessionId = this.providerSessionRef(session);
    this.unsubscribe?.();
    this.unsubscribe = session.subscribe((event) => {
      void this.handleSessionEvent(event);
    });
  }

  private async handleSessionEvent(event: AgentSessionEvent): Promise<void> {
    if (this.disposed) {
      return;
    }

    if (event.type === "agent_start") {
      this.assistantMessageId = `pi-agent-assistant-${randomUUID()}`;
      this.assistantChunksEmitted = false;
      await this.callbacks.updateConversation((current) => ({
        ...current,
        status: "running",
        pendingPermission: null,
        lastError: null,
      }));
      return;
    }

    const assistantMessageId = this.assistantMessageId ?? `pi-agent-assistant-${randomUUID()}`;
    const events = piAgentEventsFromSessionEvent({
      event,
      conversationId: this.callbacks.conversation.id,
      assistantMessageId,
      eventId: () => randomUUID(),
    });

    if (events.some((entry) => entry.kind === "assistant_message_chunk" || entry.kind === "reasoning")) {
      this.assistantChunksEmitted = true;
    }

    if (events.length > 0) {
      await this.callbacks.appendEvents(events);
    }

    if (event.type === "agent_end") {
      const statusEvent = events.find((entry) => entry.kind === "status");
      await this.callbacks.updateConversation((current) => ({
        ...current,
        status: statusEvent?.status === "running" ? "running" : "idle",
        pendingPermission: null,
        providerSessionId: this.session ? this.providerSessionRef(this.session) : current.providerSessionId,
        lastError: null,
      }));
      this.assistantMessageId = null;
      this.assistantChunksEmitted = false;
    }
  }

  async prompt(input: {
    text: string;
    userMessageId: string;
    attachments?: Array<{ mimeType: string; data: string; name?: string }>;
  }): Promise<void> {
    if (!this.session || this.disposed) {
      throw new Error("Pi Agent session is not initialized.");
    }

    await this.callbacks.updateConversation((current) => ({
      ...current,
      status: "running",
      pendingPermission: null,
      lastError: null,
      providerSessionId: this.providerSessionRef(this.session!),
      configOptions: this.configOptions,
    }));

    const pluginAttachments = await resolveAgentPluginAttachments({
      workspaceId: this.callbacks.workspace.id,
      workspaceRoot: this.callbacks.workspace.root,
      backendId: "pi-agent",
    });
    const promptText = appendAgentPluginPrompt(input.text, pluginAttachments);

    if (input.attachments?.length) {
      await this.session.prompt(promptText, {
        images: input.attachments
          .filter((attachment) => attachment.mimeType.startsWith("image/"))
          .map((attachment) => ({
            type: "image" as const,
            data: attachment.data,
            mimeType: attachment.mimeType,
          })),
      });
      return;
    }

    await this.session.prompt(promptText);
  }

  async cancel(): Promise<void> {
    if (this.session) {
      await this.session.abort().catch(() => undefined);
    }
    const events: AgentEventInput[] = [
      {
        eventId: randomUUID(),
        conversationId: this.callbacks.conversation.id,
        kind: "status",
        status: "cancelled",
        detail: "Pi Agent turn cancelled.",
      },
    ];
    if (this.assistantMessageId && this.assistantChunksEmitted) {
      events.unshift({
        eventId: randomUUID(),
        conversationId: this.callbacks.conversation.id,
        kind: "assistant_message_end",
        messageId: this.assistantMessageId,
        stopReason: "cancelled",
      });
    }
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

    if (this.session && (configId === "model" || configId === "thinking_level")) {
      const { ModelRegistry } = await import("@earendil-works/pi-coding-agent");
      const authStorage = await createPiAuthStorage();
      await applyPiRuntimeApiKeys(authStorage);
      const { getPiAgentModelsPath } = await import("../pi-agent-settings.js");
      const modelRegistry = ModelRegistry.create(authStorage, getPiAgentModelsPath());
      modelRegistry.refresh();
      if (configId === "model") {
        const model = await resolveModel(this.callbacks.conversation, this.configOptions, modelRegistry);
        if (model) {
          await this.session.setModel(model);
        }
      }
      if (configId === "thinking_level") {
        const thinkingLevel = thinkingLevelForConfig(this.configOptions);
        if (thinkingLevel) {
          this.session.setThinkingLevel(thinkingLevel);
        }
      }
    }
  }

  async answerPermission(): Promise<void> {
    return;
  }

  async dispose(): Promise<void> {
    this.disposed = true;
    this.unsubscribe?.();
    this.unsubscribe = null;
    this.session?.dispose();
    this.session = null;
  }
}

export function createPiAgentProvider(input: {
  backend: AgentBackendInfo;
  configOptions: AgentConfigOption[];
}): AgentProvider {
  return {
    backend: input.backend,
    async startSession(callbacks) {
      return PiAgentSessionHandle.create({
        backend: input.backend,
        callbacks,
        configOptions: input.configOptions,
      });
    },
    async loadSession(callbacks, providerSessionId) {
      return PiAgentSessionHandle.create({
        backend: input.backend,
        callbacks,
        configOptions: input.configOptions,
        providerSessionId,
      });
    },
  };
}
