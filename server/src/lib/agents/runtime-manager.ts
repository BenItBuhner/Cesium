import { randomUUID } from "node:crypto";
import {
  appendConversationEvents,
  appendConversationEventsAndPatchRecord,
  createConversationId,
  deleteConversationEvents,
  readConversationEvents,
  readConversationEventsUpToMessage,
  readConversationRecord,
  readConversationSnapshot,
  readConversationSnapshotHead,
  readConversationEventPrefix,
  readRecentConversationEvents,
  saveConversationRecord,
  updateConversationRecord,
  listWorkspaceConversationRecordPage,
} from "./session-store.js";
import { remapSourceEventsForFork } from "./fork-event-clone.js";
import { generateConversationTitle } from "./title-generator.js";
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
  AgentConversationMetadataPatch,
  AgentConversationRecord,
  AgentConversationSnapshot,
  AgentConversationSnapshotHead,
  AgentEventInput,
  AgentProvider,
  AgentQueuedChatPrompt,
  AgentStoredEvent,
  AgentSessionHandle,
} from "./types.js";
import type { WorkspaceRecord } from "../workspace-registry.js";

let lastConversationRankTimestamp = 0;

function nextConversationRankTimestamp(): number {
  const now = Date.now();
  lastConversationRankTimestamp = Math.max(now, lastConversationRankTimestamp + 1);
  return lastConversationRankTimestamp;
}

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

function resolvePendingForkContext(
  events: AgentStoredEvent[]
): { transcript: string; fromAgent: string; fromConversationId: string } | null {
  const ordered = [...events].sort((left, right) => left.seq - right.seq);
  let forkEvent: Extract<AgentStoredEvent, { kind: "chat_fork" }> | undefined;
  for (let index = ordered.length - 1; index >= 0; index -= 1) {
    const event = ordered[index];
    if (event?.kind === "chat_fork") {
      forkEvent = event;
      break;
    }
  }
  if (!forkEvent) {
    return null;
  }
  if (
    ordered.some(
      (event) =>
        event.seq > forkEvent!.seq &&
        event.kind === "user_message" &&
        !("inheritedInFork" in event && event.inheritedInFork)
    )
  ) {
    return null;
  }
  if (!forkEvent.transcript.trim()) {
    return null;
  }
  return {
    transcript: forkEvent.transcript,
    fromAgent: forkEvent.fromAgent,
    fromConversationId: forkEvent.fromConversationId,
  };
}

function buildPromptTextWithForkContext(input: {
  transcript: string;
  fromAgent: string;
  userText: string;
  hasAttachments: boolean;
}): string {
  const trimmedUserText = input.userText.trim();
  const nextTurn = trimmedUserText || (input.hasAttachments ? "[User attached images without text.]" : "");
  return [
    `You are continuing a conversation that was forked from another chat with ${input.fromAgent}.`,
    "The transcript below is part of the current prompt. Treat it as authoritative context that the user has provided right now.",
    "If the next user message refers to earlier details, answer from the supplied transcript instead of saying the context is unavailable.",
    "",
    "<forked_conversation>",
    input.transcript,
    "</forked_conversation>",
    "",
    "<current_user_message>",
    nextTurn,
    "</current_user_message>",
    "",
    "Reply to the current user message directly.",
  ].join("\n");
}

function buildPromptTextWithSessionRecoveryContext(input: {
  transcript: string;
  backendId: string;
  userPromptText: string;
  hasAttachments: boolean;
}): string {
  const trimmedUserText = input.userPromptText.trim();
  const nextTurn =
    trimmedUserText || (input.hasAttachments ? "[User attached images without text.]" : "");
  return [
    `The previous ${input.backendId} provider session could not be resumed.`,
    "You are running in a freshly started provider session.",
    "Use the transcript below as authoritative context from the previous session before replying.",
    "",
    "<recovered_conversation>",
    input.transcript,
    "</recovered_conversation>",
    "",
    "<current_user_message>",
    nextTurn,
    "</current_user_message>",
    "",
    "Reply to the current user message directly.",
  ].join("\n");
}

type ActiveRuntime = {
  workspaceId: string;
  provider: AgentProvider;
  handle: AgentSessionHandle;
  sessionRecoveryTranscript?: string;
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
    const limit = Math.max(1, Math.min(Math.floor(opts?.limit ?? 200), 500));
    const pageResult = await listWorkspaceConversationRecordPage(workspaceId, {
      limit,
      cursor: opts?.cursor,
      includeArchived: true,
    });
    const conversations = pageResult.records;
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

    return {
      backends: enrichedBackends,
      conversations: conversations.map((conversation) =>
        this.withBackendDefaults(conversation)
      ),
      nextCursor: pageResult.nextCursor,
    };
  }

  async createConversation(
    workspace: WorkspaceRecord,
    input: AgentConversationCreateInput
  ): Promise<AgentConversationRecord> {
    const backendId = this.resolveBackendId(input.backendId);
    this.assertRunnableBackend(backendId);
    const backend = this.backends[backendId];
    const now = nextConversationRankTimestamp();
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
      queuedPrompts: [],
    };
    await saveConversationRecord(record);
    this.warmConversationRuntime(workspace, record);
    return record;
  }

  async createConversationWithPrompt(
    workspace: WorkspaceRecord,
    input: AgentConversationCreateInput,
    prompt: {
      text: string;
      attachments?: Array<{ mimeType: string; data: string; name?: string }>;
      clientEventId?: string;
      clientMessageId?: string;
    }
  ): Promise<AgentConversationSnapshotHead> {
    const conversation = await this.createConversation(workspace, input);
    return this.promptConversation(
      workspace,
      conversation.id,
      prompt.text,
      prompt.attachments,
      {
        ...(prompt.clientEventId ? { clientEventId: prompt.clientEventId } : {}),
        ...(prompt.clientMessageId ? { clientMessageId: prompt.clientMessageId } : {}),
      }
    );
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
  const turnCount = recentEvents.filter((e) => e.kind === "user_message").length;
  const toolCallCount = recentEvents.filter((e) => e.kind === "tool_call").length;

  const supersededEventIds: string[] = [];
  {
    const allEvents = await readConversationEvents(workspace.id, sourceConversationId);
    const sorted = [...allEvents].sort((a, b) => a.seq - b.seq);
    const lastUserSeq = sorted.reduce(
      (max, e) => (e.kind === "user_message" && e.seq > max ? e.seq : max),
      -1
    );
    const trailing: Array<{
      eventId: string;
      transcriptMessageId: string | null;
    }> = [];
    for (let i = sorted.length - 1; i >= 0; i -= 1) {
      const event = sorted[i];
      if (event.kind === "agent_handoff" && event.seq > lastUserSeq) {
        let transcriptMessageId: string | null = null;
        for (let j = i - 1; j >= 0; j -= 1) {
          const prev = sorted[j];
          if (
            prev.kind === "assistant_message_end" &&
            prev.seq > lastUserSeq
          ) {
            transcriptMessageId = prev.messageId;
            break;
          }
          if (prev.kind === "user_message" || prev.seq <= lastUserSeq) {
            break;
          }
        }
        trailing.unshift({ eventId: event.eventId, transcriptMessageId });
      } else {
        break;
      }
    }
    for (const { eventId, transcriptMessageId } of trailing) {
      supersededEventIds.push(eventId);
      if (transcriptMessageId) {
        for (const e of sorted) {
          if (
            (e.kind === "assistant_message_chunk" || e.kind === "assistant_message_end") &&
            e.messageId === transcriptMessageId
          ) {
            supersededEventIds.push(e.eventId);
          }
        }
      }
    }
  }

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
    turnCount,
    toolCallCount,
    createdAt: now + 1,
  });
    if (supersededEventIds.length > 0) {
    await deleteConversationEvents(workspace.id, sourceConversationId, supersededEventIds);
  }
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

  async forkConversation(
    workspace: WorkspaceRecord,
    sourceConversationId: string,
    options?: { upToMessageId?: string }
  ): Promise<{ conversation: AgentConversationRecord }> {
    const sourceRecord = await readConversationRecord(workspace.id, sourceConversationId);
    if (!sourceRecord) {
      throw new Error(`Unknown source conversation: ${sourceConversationId}`);
    }
    if (
      sourceRecord.status === "running" ||
      sourceRecord.status === "awaiting_permission"
    ) {
      throw new Error(
        "Wait for the current reply or cancel before forking this conversation."
      );
    }

    const recentEvents = options?.upToMessageId
      ? await readConversationEventsUpToMessage(
          workspace.id,
          sourceConversationId,
          options.upToMessageId
        )
      : await readRecentConversationEvents(workspace.id, sourceConversationId);

    const transcript = generateTranscriptFromEvents(recentEvents);

    const newConversation = await this.createConversation(workspace, {
      backendId: sourceRecord.config.backendId,
      mode: sourceRecord.config.mode,
      modelId: sourceRecord.config.modelId,
      modelName: sourceRecord.config.modelName,
      title: `${sourceRecord.title} (fork)`,
    });

    const forkEventId = randomUUID();
    const forkMarker: AgentEventInput = {
      eventId: forkEventId,
      conversationId: newConversation.id,
      kind: "chat_fork",
      fromConversationId: sourceConversationId,
      fromAgent: sourceRecord.config.backendId,
      transcript,
      upToMessageId: options?.upToMessageId ?? null,
    };
    const inheritedEvents = remapSourceEventsForFork(recentEvents, newConversation.id);
    await appendConversationEvents(workspace.id, newConversation.id, [
      forkMarker,
      ...inheritedEvents,
    ]);

    return { conversation: newConversation };
  }

  async getConversationSnapshot(
    workspace: WorkspaceRecord,
    conversationId: string,
    options?: { hydrateRuntime?: boolean }
  ): Promise<AgentConversationSnapshot | null> {
    const record = await readConversationRecord(workspace.id, conversationId);
    if (!record) {
      return null;
    }
    if (options?.hydrateRuntime) {
      void this.ensureRuntime(workspace, record).catch(async (error) => {
        await this.persistRuntimeFailure(workspace.id, conversationId, error);
      });
    }
    const snapshot = await readConversationSnapshot(workspace.id, conversationId, record);
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
    const record = await readConversationRecord(workspace.id, conversationId);
    if (!record) {
      return null;
    }
    if (options?.hydrateRuntime) {
      void this.ensureRuntime(workspace, record).catch(async (error) => {
        await this.persistRuntimeFailure(workspace.id, conversationId, error);
      });
    }
    const head = await readConversationSnapshotHead(workspace.id, conversationId, {
      limitTurns: options?.limitTurns,
      limitEvents: options?.limitEvents,
      conversation: record,
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

  async updateConversationMetadata(
    workspace: WorkspaceRecord,
    conversationId: string,
    patch: AgentConversationMetadataPatch
  ): Promise<AgentConversationRecord> {
    return updateConversationRecord(workspace.id, conversationId, (current) => {
      let next: AgentConversationRecord = { ...current };
      if (patch.archived === true) {
        next = { ...next, archivedAt: Date.now() };
      } else if (patch.archived === false) {
        next = { ...next, archivedAt: null };
      }
      if (typeof patch.lastReadSeq === "number" && Number.isFinite(patch.lastReadSeq)) {
        const v = Math.floor(patch.lastReadSeq);
        next = {
          ...next,
          lastReadSeq: Math.max(0, Math.min(next.lastEventSeq, v)),
        };
      }
      return next;
    });
  }

  async promptConversation(
    workspace: WorkspaceRecord,
    conversationId: string,
    text: string,
    attachments?: Array<{ mimeType: string; data: string; name?: string }>,
    options?: {
      configOverride?: AgentQueuedChatPrompt["configOverride"];
      clientEventId?: string;
      clientMessageId?: string;
    }
  ): Promise<AgentConversationSnapshotHead> {
    const trimmed = text.trim();
    if (!trimmed && (!attachments || attachments.length === 0)) {
      throw new Error("Prompt text or attachments are required.");
    }

    const record = await readConversationRecord(workspace.id, conversationId);
    if (!record) {
      throw new Error(`Unknown conversation: ${conversationId}`);
    }
    const clientEventId = options?.clientEventId?.trim();
    const clientMessageId = options?.clientMessageId?.trim();
    if (clientEventId) {
      const existingEvents = await readConversationEvents(workspace.id, conversationId);
      if (existingEvents.some((event) => event.eventId === clientEventId)) {
        const head = await readConversationSnapshotHead(workspace.id, conversationId);
        if (!head) {
          throw new Error("Conversation disappeared after duplicate prompt lookup.");
        }
        return {
          ...head,
          conversation: this.withBackendDefaults(head.conversation),
        };
      }
    }
    if (record.status === "running" || record.status === "awaiting_permission") {
      if (
        clientEventId &&
        (record.queuedPrompts ?? []).some((queued) => queued.clientEventId === clientEventId)
      ) {
        const head = await readConversationSnapshotHead(workspace.id, conversationId);
        if (!head) {
          throw new Error("Conversation disappeared after duplicate queue lookup.");
        }
        return {
          ...head,
          conversation: this.withBackendDefaults(head.conversation),
        };
      }
      const entryId = randomUUID();
      const entry: AgentQueuedChatPrompt = {
        id: entryId,
        text: trimmed,
        ...(attachments && attachments.length > 0 ? { attachments } : {}),
        ...(clientEventId ? { clientEventId } : {}),
        ...(clientMessageId ? { clientMessageId } : {}),
        ...(options?.configOverride && Object.keys(options.configOverride).length > 0
          ? { configOverride: options.configOverride }
          : {}),
      };
      await updateConversationRecord(workspace.id, conversationId, (current) => ({
        ...current,
        queuedPrompts:
          clientEventId &&
          (current.queuedPrompts ?? []).some((queued) => queued.clientEventId === clientEventId)
            ? (current.queuedPrompts ?? [])
            : [...(current.queuedPrompts ?? []), entry],
      }));
      const head = await readConversationSnapshotHead(workspace.id, conversationId);
      if (!head) {
        throw new Error("Conversation disappeared after queueing prompt.");
      }
      return {
        ...head,
        conversation: this.withBackendDefaults(head.conversation),
      };
    }

    if (record.title === "New chat" || record.lastEventSeq === 0) {
      void generateConversationTitle(workspace.id, conversationId, trimmed);
    }

    const recentContextEvents =
      record.lastEventSeq > 0
        ? await readRecentConversationEvents(workspace.id, conversationId, 100)
        : [];
    const prefixContextEvents =
      record.lastEventSeq > 0
        ? await readConversationEventPrefix(workspace.id, conversationId, 32)
        : [];
    const promptContextEvents = [
      ...new Map(
        [...prefixContextEvents, ...recentContextEvents]
          .sort((left, right) => left.seq - right.seq)
          .map((event) => [event.eventId, event])
      ).values(),
    ];
    const pendingHandoffContext =
      promptContextEvents.length > 0
        ? resolvePendingHandoffContext(promptContextEvents)
        : null;
    const pendingForkContext =
      !pendingHandoffContext && promptContextEvents.length > 0
        ? resolvePendingForkContext(promptContextEvents)
        : null;
    const runtimePromptText = pendingHandoffContext
      ? buildPromptTextWithHandoffContext({
          ...pendingHandoffContext,
          userText: trimmed,
          hasAttachments: Boolean(attachments?.length),
        })
      : pendingForkContext
        ? buildPromptTextWithForkContext({
            ...pendingForkContext,
            userText: trimmed,
            hasAttachments: Boolean(attachments?.length),
          })
        : trimmed;

    const userMessageId = clientMessageId || randomUUID();
    const designMatch = trimmed.match(/`design:([^`]+)`/);
    const displayContent = designMatch
      ? `Design: ${designMatch[1]!.slice(0, 160)}${designMatch[1]!.length > 160 ? "…" : ""}`
      : undefined;
    const appended = await appendConversationEventsAndPatchRecord(
      workspace.id,
      conversationId,
      [
        {
          eventId: clientEventId || randomUUID(),
          conversationId,
          kind: "user_message",
          messageId: userMessageId,
          content: trimmed,
          displayContent,
          attachments,
        },
      ],
      {
        status: "running",
        pendingPermission: null,
        lastError: null,
      }
    );
    const appendedEvents = appended.events;
    const updatedRecord = appended.conversation;

    void (async () => {
      try {
        const runtime = await this.ensureRuntime(workspace, record);
        const runtimeText =
          runtime.sessionRecoveryTranscript && runtimePromptText.trim().length > 0
            ? buildPromptTextWithSessionRecoveryContext({
                transcript: runtime.sessionRecoveryTranscript,
                backendId: record.config.backendId,
                userPromptText: runtimePromptText,
                hasAttachments: Boolean(attachments?.length),
              })
            : runtimePromptText;
        if (runtime.sessionRecoveryTranscript) {
          delete runtime.sessionRecoveryTranscript;
        }
        await runtime.handle.prompt({ text: runtimeText, userMessageId, attachments });
      } catch (error) {
        await this.persistRuntimeFailure(workspace.id, conversationId, error);
      }
    })();
    return {
      conversation: this.withBackendDefaults(updatedRecord),
      events: appendedEvents,
      window: {
        oldestSeq: appendedEvents[0]?.seq ?? updatedRecord.lastEventSeq,
        newestSeq:
          appendedEvents[appendedEvents.length - 1]?.seq ?? updatedRecord.lastEventSeq,
        hasOlder: record.lastEventSeq > 0,
      },
    };
  }

  async removeQueuedPrompt(
    workspace: WorkspaceRecord,
    conversationId: string,
    itemId: string
  ): Promise<AgentConversationRecord> {
    return updateConversationRecord(workspace.id, conversationId, (current) => ({
      ...current,
      queuedPrompts: (current.queuedPrompts ?? []).filter((q) => q.id !== itemId),
    }));
  }

  /**
   * Pops the next server-side queued prompt and starts it. Caller must only
   * invoke when the conversation is idle; errors re-insert the item at the front.
   */
  async drainOneQueuedPrompt(
    workspace: WorkspaceRecord,
    conversationId: string
  ): Promise<void> {
    const record = await readConversationRecord(workspace.id, conversationId);
    if (!record || record.status !== "idle" || !record.queuedPrompts.length) {
      return;
    }
    const [head, ...rest] = record.queuedPrompts;
    await updateConversationRecord(workspace.id, conversationId, (current) => ({
      ...current,
      queuedPrompts: rest,
    }));

    const reinsertHead = async (): Promise<void> => {
      await updateConversationRecord(workspace.id, conversationId, (current) => ({
        ...current,
        queuedPrompts: [head, ...(current.queuedPrompts ?? [])],
      }));
    };

    try {
      const override = head.configOverride;
      if (override) {
        const rec = (await readConversationRecord(workspace.id, conversationId)) ?? record;
        if (override.backendId && override.backendId !== rec.config.backendId) {
          await this.handoffConversation(
            workspace,
            conversationId,
            this.resolveBackendId(override.backendId)
          );
        }
        if (override.mode || override.modelId || override.setConfigOptions) {
          const patch: AgentConversationConfigPatch = {};
          if (override.mode) patch.mode = override.mode;
          if (override.modelId) {
            patch.modelId = override.modelId;
            patch.modelName = override.modelName;
          }
          if (override.setConfigOptions) {
            patch.setConfigOptions = override.setConfigOptions;
          }
          if (Object.keys(patch).length > 0) {
            await this.updateConversationConfig(workspace, conversationId, patch);
          }
        }
      }
      await this.promptConversation(workspace, conversationId, head.text, head.attachments, {
        ...(head.clientEventId ? { clientEventId: head.clientEventId } : {}),
        ...(head.clientMessageId ? { clientMessageId: head.clientMessageId } : {}),
      });
    } catch (error) {
      console.error("[agent] drainOneQueuedPrompt failed; restoring queue head:", error);
      await reinsertHead();
    }
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
    const buildRecoveryTranscript = async (): Promise<string> => {
      if (record.lastEventSeq <= 0) {
        return "";
      }
      const recentEvents = await readRecentConversationEvents(workspace.id, record.id);
      return generateTranscriptFromEvents(recentEvents).trim();
    };

    const latest = await readConversationRecord(workspace.id, record.id);
    if (!latest) {
      throw new Error(`Unknown conversation: ${record.id}`);
    }
    record = latest;

    const existing = this.runtimes.get(record.id);
    if (existing) {
      if (existing.workspaceId !== workspace.id) {
        await this.disposeRuntime(record.id);
      } else {
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
    }

    let provider = await this.createProviderFn(record.config.backendId);
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
        const resumeErrorMessage =
          error instanceof Error ? error.message : "Failed to resume ACP session.";
        let retriedHandle: AgentSessionHandle | null = null;
        let secondAttemptErrorMessage: string | null = null;
        try {
          provider = await this.createProviderFn(record.config.backendId);
          retriedHandle = await provider.loadSession(callbacks, record.providerSessionId);
        } catch (retryError) {
          secondAttemptErrorMessage =
            retryError instanceof Error ? retryError.message : "Failed to resume ACP session.";
        }

        if (retriedHandle) {
          handle = retriedHandle;
          await appendConversationEvents(workspace.id, record.id, [
            {
              eventId: randomUUID(),
              conversationId: record.id,
              kind: "system",
              level: "warning",
              text: `Recovered provider session resume after retry. ${
                secondAttemptErrorMessage ?? resumeErrorMessage
              }`,
            },
          ]);
        } else {
          const recoveredTranscript = await buildRecoveryTranscript();
          const fallbackReason = secondAttemptErrorMessage ?? resumeErrorMessage;
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
              text: `Could not resume the previous provider session after retry. Restarting provider session and preserving context from transcript fallback. ${fallbackReason}`,
            },
            ...(recoveredTranscript
              ? [
                  {
                    eventId: randomUUID(),
                    conversationId: record.id,
                    kind: "chat_fork" as const,
                    fromConversationId: record.id,
                    fromAgent: record.config.backendId,
                    transcript: recoveredTranscript,
                    upToMessageId: null,
                  },
                ]
              : []),
          ]);
          handle = await provider.startSession(callbacks);
          const runtime: ActiveRuntime = {
            workspaceId: workspace.id,
            provider,
            handle,
            ...(recoveredTranscript ? { sessionRecoveryTranscript: recoveredTranscript } : {}),
          };
          this.runtimes.set(record.id, runtime);
          return runtime;
        }
      }
    } else {
      handle = await provider.startSession(callbacks);
      const recoveredTranscript = await buildRecoveryTranscript();
      if (recoveredTranscript) {
        const runtime: ActiveRuntime = {
          workspaceId: workspace.id,
          provider,
          handle,
          sessionRecoveryTranscript: recoveredTranscript,
        };
        this.runtimes.set(record.id, runtime);
        return runtime;
      }
    }

    const runtime: ActiveRuntime = {
      workspaceId: workspace.id,
      provider,
      handle,
    };
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
      (current.config.backendId === "cursor-acp" || current.config.backendId === "cursor-sdk") &&
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
        current.config.backendId === "cursor-acp" ||
        current.config.backendId === "cursor-sdk";
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
        current.config.backendId === "cursor-acp" ||
        current.config.backendId === "cursor-sdk";
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
      } else if (
        (record.config.backendId === "cursor-acp" || record.config.backendId === "cursor-sdk") &&
        patch.modelId
      ) {
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
