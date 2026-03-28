import { randomUUID } from "node:crypto";
import {
  appendConversationEvents,
  createConversationId,
  readConversationRecord,
  readConversationSnapshot,
  saveConversationRecord,
  updateConversationRecord,
  listWorkspaceConversationRecords,
} from "./session-store.js";
import { AGENT_BACKENDS, createAgentProvider, listAgentBackends } from "./providers.js";
import {
  findPrimaryModelConfigOption,
  findPrimaryModeConfigOption,
} from "./config-option-utils.js";
import type {
  AgentBackendId,
  AgentBackendInfo,
  AgentConversationConfigPatch,
  AgentConversationCreateInput,
  AgentConversationListResult,
  AgentConversationRecord,
  AgentConversationSnapshot,
  AgentEventInput,
  AgentProvider,
  AgentSessionHandle,
} from "./types.js";
import type { WorkspaceRecord } from "../workspace-registry.js";

type ActiveRuntime = {
  provider: AgentProvider;
  handle: AgentSessionHandle;
};

type AgentRuntimeManagerOptions = {
  backends?: Record<AgentBackendId, AgentBackendInfo>;
  createProvider?: (backendId: AgentBackendId) => Promise<AgentProvider>;
  listBackends?: () => AgentBackendInfo[];
};

function truncateConversationTitle(text: string): string {
  const normalized = text.trim().replace(/\s+/g, " ");
  if (!normalized) {
    return "New chat";
  }
  return normalized.length > 44 ? `${normalized.slice(0, 41)}...` : normalized;
}

function hasConfigChange(
  record: AgentConversationRecord,
  patch: Partial<AgentConversationRecord["config"]>,
  nextBackendId: AgentBackendId
): boolean {
  return (
    nextBackendId !== record.config.backendId ||
    (patch.mode !== undefined && patch.mode !== record.config.mode) ||
    (patch.modelId !== undefined && patch.modelId !== record.config.modelId) ||
    (patch.modelName !== undefined && patch.modelName !== record.config.modelName)
  );
}

export class AgentRuntimeManager {
  private readonly runtimes = new Map<string, ActiveRuntime>();
  private readonly retainedConversationCounts = new Map<string, number>();
  private readonly backends: Record<AgentBackendId, AgentBackendInfo>;
  private readonly createProviderFn: (backendId: AgentBackendId) => Promise<AgentProvider>;
  private readonly listBackendsFn: () => AgentBackendInfo[];

  constructor(options: AgentRuntimeManagerOptions = {}) {
    this.backends = options.backends ?? AGENT_BACKENDS;
    this.createProviderFn = options.createProvider ?? createAgentProvider;
    this.listBackendsFn = options.listBackends ?? listAgentBackends;
  }

  async listWorkspaceConversations(
    workspaceId: string
  ): Promise<AgentConversationListResult> {
    return {
      backends: this.listBackendsFn(),
      conversations: await listWorkspaceConversationRecords(workspaceId),
    };
  }

  async createConversation(
    workspace: WorkspaceRecord,
    input: AgentConversationCreateInput
  ): Promise<AgentConversationRecord> {
    const backendId = this.resolveBackendId(input.backendId);
    this.assertRunnableBackend(backendId);
    const backend = this.backends[backendId];
    const now = Date.now();
    const record: AgentConversationRecord = {
      schemaVersion: 1,
      id: createConversationId(),
      workspaceId: workspace.id,
      title: input.title?.trim() || "New chat",
      createdAt: now,
      updatedAt: now,
      lastEventSeq: 0,
      status: "idle",
      config: {
        backendId,
        mode: input.mode ?? backend.defaultMode,
        modelId: input.modelId ?? backend.defaultModelId,
        modelName: input.modelName ?? backend.defaultModelName,
      },
      providerSessionId: null,
      configOptions: [],
      capabilities: backend.capabilities,
      pendingPermission: null,
      lastError: null,
      experimental: Boolean(backend.experimental),
    };
    await saveConversationRecord(record);
    try {
      await this.ensureRuntime(workspace, record);
      return (await readConversationRecord(workspace.id, record.id)) ?? record;
    } catch (error) {
      await this.persistRuntimeFailure(workspace.id, record.id, error);
      return (await readConversationRecord(workspace.id, record.id)) ?? record;
    }
  }

  async getConversationSnapshot(
    workspace: WorkspaceRecord,
    conversationId: string,
    options?: { hydrateRuntime?: boolean }
  ): Promise<AgentConversationSnapshot | null> {
    let record = await readConversationRecord(workspace.id, conversationId);
    if (!record) {
      return null;
    }
    if (options?.hydrateRuntime) {
      try {
        await this.ensureRuntime(workspace, record);
        record = (await readConversationRecord(workspace.id, conversationId)) ?? record;
      } catch (error) {
        await this.persistRuntimeFailure(workspace.id, conversationId, error);
      }
    }
    return readConversationSnapshot(workspace.id, conversationId);
  }

  async updateConversationConfig(
    workspace: WorkspaceRecord,
    conversationId: string,
    patch: AgentConversationConfigPatch
  ): Promise<AgentConversationRecord> {
    const { setConfigOption, ...configPatch } = patch;
    let record = await readConversationRecord(workspace.id, conversationId);
    if (!record) {
      throw new Error(`Unknown conversation: ${conversationId}`);
    }

    const nextBackendId = configPatch.backendId
      ? this.resolveBackendId(configPatch.backendId)
      : record.config.backendId;
    this.assertRunnableBackend(nextBackendId);
    if (record.lastEventSeq > 0 && hasConfigChange(record, configPatch, nextBackendId)) {
      throw new Error(
        "This conversation is locked to its original backend, mode, and model after the first turn. Start a new chat to change them."
      );
    }
    const backendChanged = nextBackendId !== record.config.backendId;
    const nextBackend = this.backends[nextBackendId];

    if (backendChanged) {
      await this.disposeRuntime(conversationId);
      record = await updateConversationRecord(workspace.id, conversationId, {
        ...record,
        config: {
          ...record.config,
          ...configPatch,
          backendId: nextBackendId,
          modelId: configPatch.modelId ?? nextBackend.defaultModelId,
          modelName: configPatch.modelName ?? nextBackend.defaultModelName,
          mode: configPatch.mode ?? nextBackend.defaultMode,
        },
        capabilities: nextBackend.capabilities,
        configOptions: [],
        providerSessionId: null,
        pendingPermission: null,
        status: "idle",
        experimental: Boolean(nextBackend.experimental),
      });
      try {
        await this.ensureRuntime(workspace, record);
        return (await readConversationRecord(workspace.id, conversationId)) ?? record;
      } catch (error) {
        await this.persistRuntimeFailure(workspace.id, conversationId, error);
        return (await readConversationRecord(workspace.id, conversationId)) ?? record;
      }
    }

    record = await updateConversationRecord(workspace.id, conversationId, (current) => ({
      ...current,
      config: {
        ...current.config,
        ...configPatch,
      },
    }));

    const runtime = this.runtimes.get(conversationId);
    if (runtime) {
      await this.applyLiveConfig(runtime.handle, record, { ...configPatch, setConfigOption });
    }
    return record;
  }

  async promptConversation(
    workspace: WorkspaceRecord,
    conversationId: string,
    text: string
  ): Promise<AgentConversationSnapshot> {
    const trimmed = text.trim();
    if (!trimmed) {
      throw new Error("Prompt text is required.");
    }

    let record = await readConversationRecord(workspace.id, conversationId);
    if (!record) {
      throw new Error(`Unknown conversation: ${conversationId}`);
    }
    if (record.status === "running" || record.status === "awaiting_permission") {
      throw new Error("This conversation is already busy.");
    }

    if (record.title === "New chat" || record.lastEventSeq === 0) {
      record = await updateConversationRecord(workspace.id, conversationId, {
        ...record,
        title: truncateConversationTitle(trimmed),
      });
    }

    const userMessageId = randomUUID();
    await appendConversationEvents(workspace.id, conversationId, [
      {
        eventId: randomUUID(),
        conversationId,
        kind: "user_message",
        messageId: userMessageId,
        content: trimmed,
      },
    ]);
    await updateConversationRecord(workspace.id, conversationId, (current) => ({
      ...current,
      status: "running",
      pendingPermission: null,
      lastError: null,
    }));

    const runtime = await this.ensureRuntime(workspace, record);
    void runtime.handle.prompt({ text: trimmed, userMessageId }).catch(() => undefined);
    const snapshot = await readConversationSnapshot(workspace.id, conversationId);
    if (!snapshot) {
      throw new Error("Conversation disappeared after prompt.");
    }
    return snapshot;
  }

  async cancelConversation(
    workspace: WorkspaceRecord,
    conversationId: string
  ): Promise<AgentConversationRecord> {
    let runtime = this.runtimes.get(conversationId);
    if (!runtime) {
      const record = await readConversationRecord(workspace.id, conversationId);
      if (record && (record.providerSessionId || record.status !== "idle")) {
        runtime = await this.ensureRuntime(workspace, record).catch(() => undefined);
      }
    }
    if (!runtime) {
      return updateConversationRecord(workspace.id, conversationId, (current) => ({
        ...current,
        status: "idle",
        pendingPermission: null,
      }));
    }
    await runtime.handle.cancel();
    const record = await readConversationRecord(workspace.id, conversationId);
    if (!record) {
      throw new Error(`Unknown conversation: ${conversationId}`);
    }
    return record;
  }

  async answerPermission(
    workspace: WorkspaceRecord,
    conversationId: string,
    input: { requestId: string; optionId?: string; cancelled?: boolean }
  ): Promise<AgentConversationRecord> {
    let runtime = this.runtimes.get(conversationId);
    if (!runtime) {
      const record = await readConversationRecord(workspace.id, conversationId);
      if (record && (record.providerSessionId || record.status !== "idle")) {
        runtime = await this.ensureRuntime(workspace, record).catch(() => undefined);
      }
    }
    if (!runtime) {
      throw new Error(
        "No active runtime for this conversation. The provider session may have ended."
      );
    }
    await runtime.handle.answerPermission(input);
    const record = await readConversationRecord(workspace.id, conversationId);
    if (!record) {
      throw new Error(`Unknown conversation: ${conversationId}`);
    }
    return record;
  }

  async ensureConversationRuntime(
    workspace: WorkspaceRecord,
    conversationId: string
  ): Promise<void> {
    const record = await readConversationRecord(workspace.id, conversationId);
    if (!record) {
      return;
    }
    await this.ensureRuntime(workspace, record).catch(async (error) => {
      await this.persistRuntimeFailure(workspace.id, conversationId, error);
    });
  }

  async retainConversationRuntime(
    workspace: WorkspaceRecord,
    conversationId: string
  ): Promise<void> {
    const nextCount = (this.retainedConversationCounts.get(conversationId) ?? 0) + 1;
    this.retainedConversationCounts.set(conversationId, nextCount);
    const record = await readConversationRecord(workspace.id, conversationId);
    if (!record) {
      this.retainedConversationCounts.delete(conversationId);
      return;
    }
    if (
      record.status !== "running" &&
      record.status !== "awaiting_permission" &&
      !record.pendingPermission
    ) {
      return;
    }
    await this.ensureRuntime(workspace, record).catch(async (error) => {
      await this.persistRuntimeFailure(workspace.id, conversationId, error);
    });
  }

  async releaseConversationRuntime(
    workspaceId: string,
    conversationId: string
  ): Promise<void> {
    const currentCount = this.retainedConversationCounts.get(conversationId) ?? 0;
    if (currentCount <= 1) {
      this.retainedConversationCounts.delete(conversationId);
    } else {
      this.retainedConversationCounts.set(conversationId, currentCount - 1);
    }
    const record = await readConversationRecord(workspaceId, conversationId);
    if (!record) {
      return;
    }
    await this.disposeRuntimeIfUnused(record);
  }

  async disposeRuntime(conversationId: string): Promise<void> {
    const runtime = this.runtimes.get(conversationId);
    if (!runtime) {
      return;
    }
    this.runtimes.delete(conversationId);
    await runtime.handle.dispose().catch(() => undefined);
  }

  private resolveBackendId(raw?: string): AgentBackendId {
    if (raw && raw in this.backends) {
      return raw as AgentBackendId;
    }
    return "cursor-acp";
  }

  private assertRunnableBackend(backendId: AgentBackendId): void {
    const backend = this.backends[backendId];
    if (!backend.available) {
      throw new Error(`${backend.label} is not available yet.`);
    }
  }

  private async disposeRuntimeIfUnused(
    record: Pick<AgentConversationRecord, "id" | "status" | "pendingPermission">
  ): Promise<void> {
    if ((this.retainedConversationCounts.get(record.id) ?? 0) > 0) {
      return;
    }
    if (record.pendingPermission) {
      return;
    }
    if (record.status === "running" || record.status === "awaiting_permission") {
      return;
    }
    await this.disposeRuntime(record.id);
  }

  private async ensureRuntime(
    workspace: WorkspaceRecord,
    record: AgentConversationRecord
  ): Promise<ActiveRuntime> {
    const existing = this.runtimes.get(record.id);
    if (existing) {
      return existing;
    }

    const provider = await this.createProviderFn(record.config.backendId);
    const callbacks = {
      workspace,
      conversation: record,
      appendEvents: (events: AgentEventInput[]) =>
        appendConversationEvents(workspace.id, record.id, events),
      markRuntimeStale: () => {
        this.runtimes.delete(record.id);
      },
      updateConversation: (
        patch:
          | Partial<AgentConversationRecord>
          | ((current: AgentConversationRecord) => AgentConversationRecord)
      ) =>
        updateConversationRecord(workspace.id, record.id, patch).then(async (updated) => {
          await this.disposeRuntimeIfUnused(updated);
          return updated;
        }),
    } satisfies Parameters<AgentProvider["startSession"]>[0];

    let handle: AgentSessionHandle;
    if (record.providerSessionId && provider.backend.capabilities.supportsLoadSession) {
      try {
        handle = await provider.loadSession(callbacks, record.providerSessionId);
      } catch (error) {
        const message =
          error instanceof Error ? error.message : "Failed to resume ACP session.";
        await updateConversationRecord(workspace.id, record.id, (current) => ({
          ...current,
          providerSessionId: null,
        }));
        await appendConversationEvents(workspace.id, record.id, [
          {
            eventId: randomUUID(),
            conversationId: record.id,
            kind: "system",
            level: "warning",
            text: `Could not resume the previous provider session. Starting a fresh one instead. ${message}`,
          },
        ]);
        handle = await provider.startSession(callbacks);
      }
    } else {
      handle = await provider.startSession(callbacks);
    }

    const runtime: ActiveRuntime = { provider, handle };
    this.runtimes.set(record.id, runtime);
    return runtime;
  }

  private async applyLiveConfig(
    handle: AgentSessionHandle,
    record: AgentConversationRecord,
    patch: AgentConversationConfigPatch
  ): Promise<void> {
    const modeOption = findPrimaryModeConfigOption(handle.configOptions);
    const modelOption = findPrimaryModelConfigOption(handle.configOptions);

    if (patch.mode && modeOption) {
      const value =
        modeOption.options.find((option) => option.value === patch.mode)?.value ??
        (patch.mode === "agent"
          ? modeOption.options.find((option) =>
              option.value === "agent" || option.value === "code"
            )?.value
          : patch.mode === "plan"
            ? modeOption.options.find((option) =>
                option.value === "plan" || option.value === "ask"
              )?.value
            : patch.mode === "ask"
              ? modeOption.options.find((option) => option.value === "ask")?.value
              : modeOption.options.find((option) =>
                  option.value === "debug" ||
                  option.value === "agent" ||
                  option.value === "code"
                )?.value);
      if (value) {
        await handle.setConfigOption(modeOption.id, value);
      }
    }

    if ((patch.modelId || patch.modelName) && modelOption) {
      const value =
        modelOption.options.find((option) => option.value === patch.modelId)?.value ??
        modelOption.options.find((option) => option.name === patch.modelName)?.value ??
        modelOption.options.find((option) => option.value === record.config.modelId)
          ?.value;
      if (value) {
        await handle.setConfigOption(modelOption.id, value);
      }
    }

    if (patch.setConfigOption) {
      const target = handle.configOptions.find(
        (option) => option.id === patch.setConfigOption!.configId
      );
      if (
        target &&
        target.options.some((option) => option.value === patch.setConfigOption!.value)
      ) {
        await handle.setConfigOption(
          patch.setConfigOption.configId,
          patch.setConfigOption.value
        );
      }
    }
  }

  private async persistRuntimeFailure(
    workspaceId: string,
    conversationId: string,
    error: unknown
  ): Promise<void> {
    const message =
      error instanceof Error ? error.message : "Failed to initialize ACP runtime.";
    const current = await readConversationRecord(workspaceId, conversationId);
    if (!current) {
      return;
    }
    if (current.lastError === message && current.status === "failed") {
      return;
    }
    await appendConversationEvents(workspaceId, conversationId, [
      {
        eventId: randomUUID(),
        conversationId,
        kind: "system",
        level: "error",
        text: message,
      },
      {
        eventId: randomUUID(),
        conversationId,
        kind: "status",
        status: "failed",
        detail: message,
      },
    ]);
    await updateConversationRecord(workspaceId, conversationId, (record) => ({
      ...record,
      status: "failed",
      lastError: message,
      pendingPermission: null,
    }));
  }
}

export const agentRuntimeManager = new AgentRuntimeManager();
