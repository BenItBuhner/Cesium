import { randomUUID } from "node:crypto";
import {
  appendConversationEvents,
  createConversationId,
  readConversationRecord,
  readConversationSnapshot,
  readConversationSnapshotHead,
  saveConversationRecord,
  updateConversationRecord,
  listWorkspaceConversationRecords,
} from "./session-store.js";
import {
  AGENT_BACKENDS,
  createAgentProvider,
  listAgentBackendsWithCache,
} from "./providers.js";
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
  AgentConversationSnapshotHead,
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
  listBackends?: () => AgentBackendInfo[] | Promise<AgentBackendInfo[]>;
};

function sameCapabilities(
  left: AgentConversationRecord["capabilities"],
  right: AgentBackendInfo["capabilities"]
): boolean {
  return (
    left.supportsLoadSession === right.supportsLoadSession &&
    left.supportsModeSelection === right.supportsModeSelection &&
    left.supportsModelSelection === right.supportsModelSelection &&
    left.supportsSlashCommands === right.supportsSlashCommands &&
    left.supportsPermissions === right.supportsPermissions &&
    left.supportsToolCalls === right.supportsToolCalls &&
    left.supportsStructuredPlans === right.supportsStructuredPlans &&
    left.supportsTodos === right.supportsTodos &&
    left.supportsSessionResume === right.supportsSessionResume
  );
}

function truncateConversationTitle(text: string): string {
  const normalized = text.trim().replace(/\s+/g, " ");
  if (!normalized) {
    return "New chat";
  }
  return normalized.length > 44 ? `${normalized.slice(0, 41)}...` : normalized;
}

export class AgentRuntimeManager {
  private readonly runtimes = new Map<string, ActiveRuntime>();
  private readonly retainedConversationCounts = new Map<string, number>();
  /** Serializes ensureRuntime per conversation so warm + prompt cannot double-start sessions. */
  private readonly runtimeEnsureQueues = new Map<string, Promise<unknown>>();
  private readonly backends: Record<AgentBackendId, AgentBackendInfo>;
  private readonly createProviderFn: (backendId: AgentBackendId) => Promise<AgentProvider>;
  private readonly listBackendsFn: () => AgentBackendInfo[] | Promise<AgentBackendInfo[]>;

  constructor(options: AgentRuntimeManagerOptions = {}) {
    this.backends = options.backends ?? AGENT_BACKENDS;
    this.createProviderFn = options.createProvider ?? createAgentProvider;
    this.listBackendsFn = options.listBackends ?? listAgentBackendsWithCache;
  }

  private withBackendDefaults(
    conversation: AgentConversationRecord
  ): AgentConversationRecord {
    const backend = this.backends[conversation.config.backendId];
    if (!backend) {
      return conversation;
    }
    if (
      sameCapabilities(conversation.capabilities, backend.capabilities) &&
      conversation.experimental === Boolean(backend.experimental)
    ) {
      return conversation;
    }
    return {
      ...conversation,
      capabilities: backend.capabilities,
      experimental: Boolean(backend.experimental),
    };
  }

  async listWorkspaceConversations(
    workspaceId: string
  ): Promise<AgentConversationListResult> {
    const conversations = await listWorkspaceConversationRecords(workspaceId);
    return {
      backends: await Promise.resolve(this.listBackendsFn()),
      conversations: conversations.map((conversation) =>
        this.withBackendDefaults(conversation)
      ),
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
      archivedAt: null,
      lastReadSeq: 0,
    };
    await saveConversationRecord(record);
    this.warmConversationRuntime(workspace, record);
    return record;
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
    const snapshot = await readConversationSnapshot(workspace.id, conversationId);
    if (!snapshot) {
      return null;
    }
    return {
      ...snapshot,
      conversation: this.withBackendDefaults(snapshot.conversation),
    };
  }

  async getConversationSnapshotHead(
    workspace: WorkspaceRecord,
    conversationId: string,
    options?: {
      hydrateRuntime?: boolean;
      limitTurns?: number;
      limitEvents?: number;
    }
  ): Promise<AgentConversationSnapshotHead | null> {
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
    const head = await readConversationSnapshotHead(workspace.id, conversationId, {
      limitTurns: options?.limitTurns,
      limitEvents: options?.limitEvents,
    });
    if (!head) {
      return null;
    }
    return {
      ...head,
      conversation: this.withBackendDefaults(head.conversation),
    };
  }

  async updateConversationConfig(
    workspace: WorkspaceRecord,
    conversationId: string,
    patch: AgentConversationConfigPatch
  ): Promise<AgentConversationRecord> {
    const { setConfigOption, setConfigOptions, title: titlePatch, ...configPatch } = patch;
    const nextTitle =
      titlePatch !== undefined ? truncateConversationTitle(titlePatch) : undefined;

    let record = await readConversationRecord(workspace.id, conversationId);
    if (!record) {
      throw new Error(`Unknown conversation: ${conversationId}`);
    }

    const nextBackendId = configPatch.backendId
      ? this.resolveBackendId(configPatch.backendId)
      : record.config.backendId;
    this.assertRunnableBackend(nextBackendId);
    const backendChanged = nextBackendId !== record.config.backendId;
    const nextBackend = this.backends[nextBackendId];

    if (backendChanged) {
      await this.disposeRuntime(conversationId);
      record = await updateConversationRecord(workspace.id, conversationId, {
        ...record,
        ...(nextTitle !== undefined ? { title: nextTitle } : {}),
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
      this.warmConversationRuntime(workspace, record);
      return record;
    }

    record = await updateConversationRecord(workspace.id, conversationId, (current) =>
      this.applyConfigPatchToRecord(current, {
        configPatch,
        setConfigOption,
        setConfigOptions,
        nextTitle,
      })
    );

    const runtime = this.runtimes.get(conversationId);
    if (runtime) {
      await this.applyLiveConfig(runtime.handle, record, {
        ...configPatch,
        setConfigOption,
        setConfigOptions,
      });
      return (await readConversationRecord(workspace.id, conversationId)) ?? record;
    }
    return record;
  }

  async promptConversation(
    workspace: WorkspaceRecord,
    conversationId: string,
    text: string,
    attachments?: Array<{ mimeType: string; data: string; name?: string }>
  ): Promise<AgentConversationSnapshotHead> {
    const trimmed = text.trim();
    if (!trimmed && (!attachments || attachments.length === 0)) {
      throw new Error("Prompt text or attachments are required.");
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
        attachments,
      },
    ]);
    await updateConversationRecord(workspace.id, conversationId, (current) => ({
      ...current,
      status: "running",
      pendingPermission: null,
      lastError: null,
    }));

    const runtime = await this.ensureRuntime(workspace, record);
    void runtime.handle.prompt({ text: trimmed, userMessageId, attachments }).catch(() => undefined);
    const head = await readConversationSnapshotHead(workspace.id, conversationId);
    if (!head) {
      throw new Error("Conversation disappeared after prompt.");
    }
    return {
      ...head,
      conversation: this.withBackendDefaults(head.conversation),
    };
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

  private warmConversationRuntime(
    workspace: WorkspaceRecord,
    record: AgentConversationRecord
  ): void {
    void this.ensureRuntime(workspace, record).catch(async (error) => {
      await this.persistRuntimeFailure(workspace.id, record.id, error);
    });
  }

  private async withRuntimeEnsureQueue<T>(
    conversationId: string,
    run: () => Promise<T>
  ): Promise<T> {
    const previous = this.runtimeEnsureQueues.get(conversationId) ?? Promise.resolve();
    let release: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => {
      release = () => resolve();
    });
    const tail = previous.catch(() => undefined).then(() => gate);
    this.runtimeEnsureQueues.set(conversationId, tail);
    await previous.catch(() => undefined);
    try {
      return await run();
    } finally {
      if (release) {
        release();
      }
      if (this.runtimeEnsureQueues.get(conversationId) === tail) {
        this.runtimeEnsureQueues.delete(conversationId);
      }
    }
  }

  private async ensureRuntime(
    workspace: WorkspaceRecord,
    record: AgentConversationRecord
  ): Promise<ActiveRuntime> {
    return this.withRuntimeEnsureQueue(record.id, () =>
      this.ensureRuntimeImpl(workspace, record)
    );
  }

  private async ensureRuntimeImpl(
    workspace: WorkspaceRecord,
    record: AgentConversationRecord
  ): Promise<ActiveRuntime> {
    const latest = await readConversationRecord(workspace.id, record.id);
    if (!latest) {
      throw new Error(`Unknown conversation: ${record.id}`);
    }
    record = latest;

    const existing = this.runtimes.get(record.id);
    if (existing) {
      const disk = await readConversationRecord(workspace.id, record.id);
      if (!disk) {
        await this.disposeRuntime(record.id);
      } else if (existing.provider.backend.id !== disk.config.backendId) {
        await this.disposeRuntime(record.id);
      } else if (
        disk.providerSessionId !== null &&
        disk.providerSessionId !== existing.handle.sessionId
      ) {
        await this.disposeRuntime(record.id);
      } else {
        return existing;
      }
    }

    const provider = await this.createProviderFn(record.config.backendId);
    const callbacks = {
      workspace,
      conversation: record,
      appendEvents: (events: AgentEventInput[]) =>
        appendConversationEvents(workspace.id, record.id, events),
      readSnapshot: () => readConversationSnapshot(workspace.id, record.id),
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

  private applyConfigPatchToRecord(
    current: AgentConversationRecord,
    input: {
      configPatch: Partial<AgentConversationRecord["config"]>;
      setConfigOption?: AgentConversationConfigPatch["setConfigOption"];
      setConfigOptions?: AgentConversationConfigPatch["setConfigOptions"];
      nextTitle?: string;
    }
  ): AgentConversationRecord {
    const { configPatch, setConfigOption, setConfigOptions, nextTitle } = input;
    let nextOptions = current.configOptions;
    const nextConfig = {
      ...current.config,
      ...configPatch,
    };

    const allowCursorRaw = (configId: string) =>
      current.config.backendId === "cursor-acp" &&
      (findPrimaryModelConfigOption(nextOptions)?.id === configId ||
        findPrimaryModeConfigOption(nextOptions)?.id === configId);

    const touchOption = (configId: string, value: string) => {
      const target = nextOptions.find((o) => o.id === configId);
      if (!target) {
        return;
      }
      if (target.options.some((o) => o.value === value) || allowCursorRaw(configId)) {
        nextOptions = nextOptions.map((o) =>
          o.id === configId ? { ...o, currentValue: value } : o
        );
      }
    };

    if (setConfigOption) {
      touchOption(setConfigOption.configId, setConfigOption.value);
    }
    for (const sel of setConfigOptions ?? []) {
      touchOption(sel.configId, sel.value);
    }

    const modeOption = findPrimaryModeConfigOption(nextOptions);
    if (modeOption && nextConfig.mode) {
      const ok =
        modeOption.options.some((o) => o.value === nextConfig.mode) ||
        current.config.backendId === "cursor-acp";
      if (ok) {
        nextOptions = nextOptions.map((o) =>
          o.id === modeOption.id ? { ...o, currentValue: nextConfig.mode } : o
        );
      }
    }
    const modelOption = findPrimaryModelConfigOption(nextOptions);
    if (modelOption && nextConfig.modelId) {
      const ok =
        modelOption.options.some((o) => o.value === nextConfig.modelId) ||
        current.config.backendId === "cursor-acp";
      if (ok) {
        nextOptions = nextOptions.map((o) =>
          o.id === modelOption.id ? { ...o, currentValue: nextConfig.modelId } : o
        );
      }
    }

    return {
      ...current,
      ...(nextTitle !== undefined ? { title: nextTitle } : {}),
      config: nextConfig,
      configOptions: nextOptions,
    };
  }

  private async applyLiveConfig(
    handle: AgentSessionHandle,
    record: AgentConversationRecord,
    patch: AgentConversationConfigPatch
  ): Promise<void> {
    const modeOption = findPrimaryModeConfigOption(handle.configOptions);
    const modelOption = findPrimaryModelConfigOption(handle.configOptions);

    if (patch.mode && modeOption) {
      const patchKey = patch.mode.trim().toLowerCase();
      const value =
        modeOption.options.find((option) => option.value === patch.mode)?.value ??
        modeOption.options.find((option) => option.value.toLowerCase() === patchKey)?.value ??
        (patchKey === "agent" || patchKey === "code"
          ? modeOption.options.find((option) =>
              option.value === "agent" || option.value === "code"
            )?.value
          : patchKey === "plan"
            ? modeOption.options.find((option) =>
                option.value === "plan" || option.value === "ask"
              )?.value
            : patchKey === "ask"
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
      } else if (record.config.backendId === "cursor-acp" && patch.modelId) {
        await handle.setConfigOption(modelOption.id, patch.modelId);
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

    for (const selection of patch.setConfigOptions ?? []) {
      const target = handle.configOptions.find((option) => option.id === selection.configId);
      if (target && target.options.some((option) => option.value === selection.value)) {
        await handle.setConfigOption(selection.configId, selection.value);
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
