import { randomUUID } from "node:crypto";
import {
  appendConversationEvents,
  createConversationId,
  readConversationRecord,
  readConversationSnapshot,
  readConversationSnapshotHead,
  readRecentConversationEvents,
  saveConversationRecord,
  updateConversationRecord,
  listWorkspaceConversationRecords,
} from "./session-store.js";
import {
  PROMPT_CONTEXT_LIMIT_EVENTS,
  PROMPT_CONTEXT_LIMIT_TURNS,
  generateTranscriptFromEvents,
} from "./event-log-read.js";
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
  AgentStoredEvent,
  AgentSessionHandle,
} from "./types.js";
import type { WorkspaceRecord } from "../workspace-registry.js";

function extractAssistantTextForMessage(
  events: AgentStoredEvent[],
  messageId: string,
  beforeSeq: number
): string {
  return events
    .filter(
      (
        event
      ): event is Extract<AgentStoredEvent, { kind: "assistant_message_chunk" }> =>
        event.seq < beforeSeq &&
        event.kind === "assistant_message_chunk" &&
        event.messageId === messageId
    )
    .sort((left, right) => left.seq - right.seq)
    .map((event) => event.text)
    .join("")
    .trim();
}

function resolvePendingHandoffContext(
  events: AgentStoredEvent[]
): { transcript: string; fromAgent: string; toAgent: string } | null {
  const ordered = [...events].sort((left, right) => left.seq - right.seq);
  let handoffEvent:
    | Extract<AgentStoredEvent, { kind: "agent_handoff" }>
    | undefined;
  for (let index = ordered.length - 1; index >= 0; index -= 1) {
    const event = ordered[index];
    if (event?.kind === "agent_handoff") {
      handoffEvent = event;
      break;
    }
  }
  if (!handoffEvent) {
    return null;
  }
  if (
    ordered.some(
      (event) => event.seq > handoffEvent.seq && event.kind === "user_message"
    )
  ) {
    return null;
  }

  let transcriptMessageId: string | undefined;
  for (let index = ordered.length - 1; index >= 0; index -= 1) {
    const event = ordered[index];
    if (!event || event.seq >= handoffEvent.seq) {
      continue;
    }
    if (event.kind === "assistant_message_end") {
      transcriptMessageId = event.messageId;
      break;
    }
    if (event.kind === "assistant_message_chunk") {
      transcriptMessageId = event.messageId;
      break;
    }
  }
  if (!transcriptMessageId) {
    return null;
  }

  const transcript = extractAssistantTextForMessage(
    ordered,
    transcriptMessageId,
    handoffEvent.seq
  );
  if (!transcript) {
    return null;
  }
  return {
    transcript,
    fromAgent: handoffEvent.fromAgent,
    toAgent: handoffEvent.toAgent,
  };
}

function buildPromptTextWithHandoffContext(input: {
  transcript: string;
  fromAgent: string;
  toAgent: string;
  userText: string;
  hasAttachments: boolean;
}): string {
  const trimmedUserText = input.userText.trim();
  const nextTurn = trimmedUserText || (input.hasAttachments ? "[User attached images without text.]" : "");
  return [
    `You are continuing a conversation that is being transferred from ${input.fromAgent} to ${input.toAgent}.`,
    "The transcript below is part of the current prompt. Treat it as authoritative context that the user has provided right now.",
    "If the next user message refers to earlier details, answer from the supplied transcript instead of saying the context is unavailable.",
    "",
    "<transferred_conversation>",
    input.transcript,
    "</transferred_conversation>",
    "",
    "<current_user_message>",
    nextTurn,
    "</current_user_message>",
    "",
    "Reply to the current user message directly.",
  ].join("\n");
}

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
    workspaceId: string,
    opts?: { limit?: number; cursor?: string | null }
  ): Promise<AgentConversationListResult> {
    const conversations = await listWorkspaceConversationRecords(workspaceId);
    const backends = await Promise.resolve(this.listBackendsFn());
    const enrichedBackends = backends.map((backend) => {
      const cachedModelCount = findPrimaryModelConfigOption(
        backend.cachedConfigOptions ?? []
      )?.options.length ?? 0;
      if (cachedModelCount > 0) {
        return backend;
      }
      const richestConversation = conversations
        .filter(
          (conversation) =>
            conversation.config.backendId === backend.id && conversation.configOptions.length > 0
        )
        .sort((left, right) => {
          const leftCount = findPrimaryModelConfigOption(left.configOptions)?.options.length ?? 0;
          const rightCount = findPrimaryModelConfigOption(right.configOptions)?.options.length ?? 0;
          return rightCount - leftCount;
        })[0];
      const richestModelCount = richestConversation
        ? findPrimaryModelConfigOption(richestConversation.configOptions)?.options.length ?? 0
        : 0;
      if (!richestConversation || richestModelCount <= cachedModelCount) {
        return backend;
      }
      return {
        ...backend,
        cachedConfigOptions: richestConversation.configOptions,
      };
    });

    // Paginate after backend enrichment so the richest configOptions are still
    // sampled from the full workspace pool, not just the first page window.
    // This keeps `backends` useful even when the client only asks for page 2.
    const limit = Math.max(1, Math.min(Math.floor(opts?.limit ?? 200), 500));
    const offset = Math.max(0, Number.parseInt(opts?.cursor ?? "0", 10) || 0);
    const page = conversations.slice(offset, offset + limit);
    const nextCursor =
      offset + page.length < conversations.length
        ? String(offset + page.length)
        : null;

    return {
      backends: enrichedBackends,
      conversations: page.map((conversation) =>
        this.withBackendDefaults(conversation)
      ),
      nextCursor,
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

  async handoffConversation(
    workspace: WorkspaceRecord,
    sourceConversationId: string,
    targetBackendId: AgentBackendId,
    messageLimit?: number
  ): Promise<{ newConversationId: string }> {
    const sourceRecord = await readConversationRecord(workspace.id, sourceConversationId);
    if (!sourceRecord) {
      throw new Error(`Unknown source conversation: ${sourceConversationId}`);
    }

    if (
      sourceRecord.status === "running" ||
      sourceRecord.status === "awaiting_permission"
    ) {
      throw new Error(
        "Wait for the current reply or cancel before handing off to another agent backend."
      );
    }

    const resolvedTargetBackendId = this.resolveBackendId(targetBackendId);
    this.assertRunnableBackend(resolvedTargetBackendId);
    if (sourceRecord.config.backendId === resolvedTargetBackendId) {
      return {
        newConversationId: sourceConversationId,
      };
    }

    const fromAgent = sourceRecord.config.backendId;
    const toAgent = resolvedTargetBackendId;

    const recentEvents = await readRecentConversationEvents(
      workspace.id,
      sourceConversationId,
      messageLimit
    );

    const transcript = generateTranscriptFromEvents(recentEvents);
    const targetBackend = this.backends[resolvedTargetBackendId];

    const transcriptMessageId = randomUUID();
    const handoffEventId = randomUUID();
    const now = Date.now();
    const handoffEvents: AgentEventInput[] = [];
    if (transcript.trim()) {
      handoffEvents.push(
        {
          eventId: randomUUID(),
          conversationId: sourceConversationId,
          kind: "assistant_message_chunk",
          messageId: transcriptMessageId,
          text: transcript,
          createdAt: now,
        },
        {
          eventId: transcriptMessageId,
          conversationId: sourceConversationId,
          kind: "assistant_message_end",
          messageId: transcriptMessageId,
          stopReason: "tool_call",
          createdAt: now,
        }
      );
    }
    handoffEvents.push({
      eventId: handoffEventId,
      conversationId: sourceConversationId,
      kind: "agent_handoff",
      fromAgent,
      toAgent,
      createdAt: now + 1,
    });
    await appendConversationEvents(workspace.id, sourceConversationId, handoffEvents);

    await this.disposeRuntime(sourceConversationId);
    const updatedRecord = await updateConversationRecord(
      workspace.id,
      sourceConversationId,
      (current) => ({
        ...current,
        config: {
          ...current.config,
          backendId: resolvedTargetBackendId,
          mode: targetBackend.defaultMode,
          modelId: targetBackend.defaultModelId,
          modelName: targetBackend.defaultModelName,
        },
        providerSessionId: null,
        configOptions: [],
        capabilities: targetBackend.capabilities,
        pendingPermission: null,
        status: "idle",
        experimental: Boolean(targetBackend.experimental),
        lastError: null,
      })
    );
    this.warmConversationRuntime(workspace, updatedRecord);

    return {
      newConversationId: sourceConversationId,
    };
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

    const pendingHandoffContext =
      record.lastEventSeq > 0
        ? resolvePendingHandoffContext(
            (await readConversationSnapshot(workspace.id, conversationId))?.events ?? []
          )
        : null;
    const runtimePromptText = pendingHandoffContext
      ? buildPromptTextWithHandoffContext({
          ...pendingHandoffContext,
          userText: trimmed,
          hasAttachments: Boolean(attachments?.length),
        })
      : trimmed;

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
    void runtime.handle
      .prompt({ text: runtimePromptText, userMessageId, attachments })
      .catch(() => undefined);
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
      readSnapshot: async () => {
        const head = await readConversationSnapshotHead(workspace.id, record.id, {
          limitTurns: PROMPT_CONTEXT_LIMIT_TURNS,
          limitEvents: PROMPT_CONTEXT_LIMIT_EVENTS,
        });
        if (!head) {
          return null;
        }
        return { conversation: head.conversation, events: head.events };
      },
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
