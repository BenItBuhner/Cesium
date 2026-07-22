import type { WorkspaceRecord } from "../workspace-registry.js";

export type AgentConversationMode =
  | "agent"
  | "plan"
  | "debug"
  | "ask"
  | "goal"
  | (string & {});

export type AgentBackendId =
  | "cesium-agent"
  | "cursor-sdk"
  | "opencode-server"
  | "opencode-v2-beta"
  | "devin-acp"
  | "codex-app-server"
  | "claude-code-sdk"
  | "pi-agent"
  | "google-antigravity-cli";

export type AgentConversationStatus =
  | "idle"
  | "running"
  | "pause_requested"
  | "pausing"
  | "paused"
  | "awaiting_permission"
  | "awaiting_question"
  | "cancelled"
  | "failed"
  | "interrupted";

export type AgentToolCallStatus =
  | "pending"
  | "in_progress"
  | "completed"
  | "failed"
  | "cancelled";

export type AgentConfigOptionCategory =
  | "mode"
  | "model"
  | "thought_level"
  | "permission"
  | "other";

export type AgentConfigOptionValue = {
  value: string;
  name: string;
  description?: string;
  metadata?: Record<string, string | string[]>;
};

export type AgentConfigOption = {
  id: string;
  name: string;
  description?: string;
  category: AgentConfigOptionCategory;
  currentValue: string;
  options: AgentConfigOptionValue[];
};

export type AgentPermissionOptionKind =
  | "allow_once"
  | "allow_always"
  | "reject_once"
  | "reject_always";

/** Shared permission categories across Cesium tool gates and remembered auto-allow rules. */
export type AgentPermissionCategory =
  | "editFile"
  | "terminal"
  | "mcpCall"
  | "switchMode";

/** How a remembered permission rule matches future tool calls. */
export type RememberedAgentPermissionMatchStyle = "exact" | "category";

export type AgentPermissionOption = {
  optionId: string;
  name: string;
  kind: AgentPermissionOptionKind;
};

export type AgentPendingPermission = {
  requestId: string;
  requestedAt: number;
  toolCallId?: string;
  permission?: AgentPermissionCategory;
  title?: string;
  /** Human-readable context from the provider (tool summary, CLI text, etc.). */
  detail?: string;
  options: AgentPermissionOption[];
};

export type AgentPendingQuestion = {
  questionId: string;
  requestedAt: number;
};

export type AgentProviderCapabilities = {
  supportsLoadSession: boolean;
  supportsModeSelection: boolean;
  supportsModelSelection: boolean;
  supportsSlashCommands: boolean;
  supportsPermissions: boolean;
  supportsToolCalls: boolean;
  supportsStructuredPlans: boolean;
  supportsTodos: boolean;
  supportsSessionResume: boolean;
  supportsPromptImages: boolean;
  supportsInlineReasoning: boolean;
  supportsCompletionRetry: boolean;
};

export type AgentBackendInfo = {
  id: AgentBackendId;
  label: string;
  description: string;
  commandPreview?: string;
  experimental?: boolean;
  available: boolean;
  defaultMode: AgentConversationMode;
  defaultModelId: string;
  defaultModelName: string;
  capabilities: AgentProviderCapabilities;
  cachedConfigOptions?: AgentConfigOption[];
};

export type AgentConversationConfig = {
  backendId: AgentBackendId;
  mode: AgentConversationMode;
  modelId: string;
  modelName: string;
};

export type AgentToolLocation = {
  path: string;
  line?: number;
};

export type AgentToolEditPreviewLine = {
  kind: "context" | "add" | "remove" | "gap";
  text: string;
  oldLineNumber?: number;
  newLineNumber?: number;
};

export type AgentToolEditPreview = {
  path?: string;
  source: "before_after" | "patch" | "replace";
  addedLines: number;
  removedLines: number;
  truncated?: boolean;
  lines: AgentToolEditPreviewLine[];
};

export type AgentPlanEntry = {
  id: string;
  content: string;
  priority?: string;
  status: "pending" | "in_progress" | "blocked" | "completed";
};

export type AgentStoredEvent =
  | {
      seq: number;
      eventId: string;
      conversationId: string;
      createdAt: number;
      kind: "user_message";
      messageId: string;
      content: string;
      /** Shorter label for chat bubbles; full `content` is still sent to the model. */
      displayContent?: string;
      /** Runtime-owned prompt context that should be sent to the model but hidden from normal chat UI. */
      hidden?: boolean;
      attachments?: Array<{ mimeType: string; data: string; name?: string }>;
      /**
       * `true` for events materialized from a source conversation when forking. Ignored
       * when resolving the first *new* post-fork prompt (seed context) vs inherited rows.
       */
      inheritedInFork?: boolean;
      raw?: unknown;
    }
  | {
      seq: number;
      eventId: string;
      conversationId: string;
      createdAt: number;
      kind: "system_reminder";
      reminderId: string;
      targetMessageId?: string;
      reason: "mode" | "plan_handoff" | "compaction" | "goal" | "burn" | "other";
      text: string;
      raw?: unknown;
    }
  | {
      seq: number;
      eventId: string;
      conversationId: string;
      createdAt: number;
      kind: "assistant_message_chunk";
      messageId: string;
      text: string;
      raw?: unknown;
    }
  | {
      seq: number;
      eventId: string;
      conversationId: string;
      createdAt: number;
      kind: "assistant_message_end";
      messageId: string;
      stopReason?: string;
      raw?: unknown;
    }
  | {
      seq: number;
      eventId: string;
      conversationId: string;
      createdAt: number;
      kind: "reasoning";
      messageId: string;
      text: string;
      raw?: unknown;
    }
  | {
      seq: number;
      eventId: string;
      conversationId: string;
      createdAt: number;
      kind: "tool_call";
      toolCallId: string;
      title: string;
      toolKind: string;
      status: AgentToolCallStatus;
      detail?: string;
      locations?: AgentToolLocation[];
      editPreview?: AgentToolEditPreview;
      pluginId?: string;
      pluginName?: string;
      pluginIconUrl?: string;
      openCodeSubagentSessionId?: string;
      raw?: unknown;
    }
  | {
      seq: number;
      eventId: string;
      conversationId: string;
      createdAt: number;
      kind: "tool_call_update";
      toolCallId: string;
      title?: string;
      toolKind?: string;
      status: AgentToolCallStatus;
      detail?: string;
      locations?: AgentToolLocation[];
      editPreview?: AgentToolEditPreview;
      pluginId?: string;
      pluginName?: string;
      pluginIconUrl?: string;
      openCodeSubagentSessionId?: string;
      raw?: unknown;
    }
  | {
      seq: number;
      eventId: string;
      conversationId: string;
      createdAt: number;
      kind: "plan";
      planId: string;
      entries: AgentPlanEntry[];
      raw?: unknown;
    }
  | {
      seq: number;
      eventId: string;
      conversationId: string;
      createdAt: number;
      kind: "plan_file";
      path: string;
      title?: string;
      previewMode?: "preview" | "source";
      raw?: unknown;
    }
  | {
      seq: number;
      eventId: string;
      conversationId: string;
      createdAt: number;
      kind: "subagent";
      subagentId: string;
      title: string;
      meta?: string;
      status: "running" | "completed" | "failed";
      transcript: AgentStoredEvent[];
      recentActivity?: string;
      raw?: unknown;
    }
  | {
      seq: number;
      eventId: string;
      conversationId: string;
      createdAt: number;
      kind: "question";
      questionId: string;
      prompt: string;
      options: Array<{ id: string; label: string }>;
      questions?: Array<{
        id: string;
        prompt: string;
        options: Array<{ id: string; label: string }>;
        allowMultiple?: boolean;
      }>;
      allowMultiple?: boolean;
      status: "pending" | "answered" | "cancelled";
      answer?: string | string[];
      raw?: unknown;
    }
  | {
      seq: number;
      eventId: string;
      conversationId: string;
      createdAt: number;
      kind: "compression_summary";
      messageId: string;
      summary: string;
      retainedTurnCount: number;
      compressedTurnCount: number;
      sourceRange?: { fromSeq: number; toSeq: number };
      estimatedTokensBefore?: number;
      estimatedTokensAfter?: number;
      generation?: number;
      raw?: unknown;
    }
  | {
      seq: number;
      eventId: string;
      conversationId: string;
      createdAt: number;
      kind: "permission_request";
      requestId: string;
      title?: string;
      detail?: string;
      toolCallId?: string;
      options: AgentPermissionOption[];
      raw?: unknown;
    }
  | {
      seq: number;
      eventId: string;
      conversationId: string;
      createdAt: number;
      kind: "permission_resolved";
      requestId: string;
      outcome: "selected" | "cancelled";
      optionId?: string;
      raw?: unknown;
    }
  | {
      seq: number;
      eventId: string;
      conversationId: string;
      createdAt: number;
      kind: "system";
      level: "info" | "warning" | "error";
      text: string;
      raw?: unknown;
    }
  | {
      seq: number;
      eventId: string;
      conversationId: string;
      createdAt: number;
      kind: "status";
      status: AgentConversationStatus;
      detail?: string;
      raw?: unknown;
    }
| {
  seq: number;
  eventId: string;
  conversationId: string;
  createdAt: number;
  kind: "agent_handoff";
  fromAgent: string;
  toAgent: string;
  /** When set, the following user turn with this message id is styled as the handoff message. */
  handoffMessageId?: string;
  /** Number of user turns included in the handoff transcript. */
  turnCount?: number;
  /** Number of tool calls included in the handoff transcript. */
  toolCallCount?: number;
  raw?: unknown;
}
| {
  seq: number;
  eventId: string;
  conversationId: string;
  createdAt: number;
  kind: "chat_fork";
  fromConversationId: string;
  fromAgent: string;
  transcript: string;
  upToMessageId: string | null;
};

/** Follow-up user prompt waiting while the turn is still running; persisted on the server. */
export type AgentQueuedChatPrompt = {
  id: string;
  text: string;
  delivery?: "normal" | "steer";
  attachments?: Array<{ mimeType: string; data: string; name?: string }>;
  clientEventId?: string;
  clientMessageId?: string;
  configOverride?: Partial<AgentConversationConfig> & {
    backendId?: AgentBackendId;
    setConfigOptions?: Array<{ configId: string; value: string }>;
  };
  planHandoff?: {
    planPath: string;
    planTitle?: string;
    targetMode?: AgentConversationMode;
    targetModelId?: string;
    targetModelName?: string;
  };
  hidden?: boolean;
};

/**
 * Where a conversation was triggered from. Conversations started from external
 * sources (Linear/GitHub/Slack via Cloud Agents) are normal conversations in
 * every way — this only records provenance for rail badges and filtering.
 */
export type AgentConversationOrigin = {
  kind: "cloud";
  providerId: "linear" | "github" | "slack" | "manual";
  /** Cloud Agents task id linking back to the external assignment. */
  taskId?: string;
  /** Short human label, e.g. "owner/repo#42" or "OSP-67". */
  label?: string;
  /** Deep link to the source issue/message. */
  url?: string;
};

export type AgentConversationRecord = {
  schemaVersion: 1;
  id: string;
  workspaceId: string;
  title: string;
  createdAt: number;
  updatedAt: number;
  lastEventSeq: number;
  status: AgentConversationStatus;
  config: AgentConversationConfig;
  providerSessionId: string | null;
  configOptions: AgentConfigOption[];
  capabilities: AgentProviderCapabilities;
  pendingPermission: AgentPendingPermission | null;
  pendingQuestion: AgentPendingQuestion | null;
  lastError: string | null;
  experimental: boolean;
  archivedAt: number | null;
  lastReadSeq: number;
  /** Set when the conversation was triggered from an external source. */
  origin?: AgentConversationOrigin | null;
  /** FIFO queue; applied automatically when the conversation becomes idle. */
  queuedPrompts: AgentQueuedChatPrompt[];
};

export type AgentConversationSnapshot = {
  conversation: AgentConversationRecord;
  events: AgentStoredEvent[];
};

/** Window metadata for paginated client sync (tail or history page). */
export type AgentConversationEventWindow = {
  oldestSeq: number;
  newestSeq: number;
  hasOlder: boolean;
};

/** Partial snapshot: bounded event array plus cursor metadata for loading older pages. */
export type AgentConversationSnapshotHead = {
  conversation: AgentConversationRecord;
  events: AgentStoredEvent[];
  window: AgentConversationEventWindow;
};

export type AgentContextUsageCategoryId =
  | "system_prompt"
  | "tool_definitions"
  | "mcp"
  | "summarized_conversation"
  | "conversation";

export type AgentContextUsageCategory = {
  id: AgentContextUsageCategoryId;
  label: string;
  tokens: number;
  colorKey: string;
};

export type AgentContextUsageSnapshot = {
  supported: boolean;
  limitTokens: number;
  usedTokens: number;
  percentFull: number;
  categories: AgentContextUsageCategory[];
  approximate?: boolean;
};

export type AgentConversationCreateInput = Partial<AgentConversationConfig> & {
  title?: string;
  archived?: boolean;
  /** Provenance for conversations triggered from external sources. */
  origin?: AgentConversationOrigin | null;
};

export type AgentConversationConfigPatch = Partial<AgentConversationConfig> & {
  /** Conversation display title (always patchable; independent of backend/mode lock). */
  title?: string;
  /** Set a single ACP config option (reasoning effort, speed, context, etc.). */
  setConfigOption?: { configId: string; value: string };
  /** Set multiple provider config options atomically when a UI choice maps to a model + variant. */
  setConfigOptions?: Array<{ configId: string; value: string }>;
};

export type AgentConversationMetadataPatch = {
  archived?: boolean;
  lastReadSeq?: number;
};

export type AgentConversationListResult = {
  backends: AgentBackendInfo[];
  conversations: AgentConversationRecord[];
  /** Opaque pagination cursor. Present when more pages exist; `null` when exhausted. */
  nextCursor?: string | null;
};

export type AgentManagerEvent =
  | { type: "conversation"; conversation: AgentConversationRecord }
  | { type: "conversation_deleted"; workspaceId: string; conversationId: string }
  | { type: "event"; workspaceId: string; conversationId: string; event: AgentStoredEvent };

type AgentEventInputOf<T extends AgentStoredEvent> = Omit<T, "seq" | "createdAt"> & {
  createdAt?: number;
};

export type AgentEventInput = AgentStoredEvent extends infer T
  ? T extends AgentStoredEvent
    ? AgentEventInputOf<T>
    : never
  : never;

export interface AgentRuntimeCallbacks {
  workspace: WorkspaceRecord;
  conversation: AgentConversationRecord;
  appendEvents: (events: AgentEventInput[]) => Promise<AgentStoredEvent[]>;
  readSnapshot: () => Promise<AgentConversationSnapshot | null>;
  markRuntimeStale?: () => void;
  updateConversation: (
    patch:
      | Partial<AgentConversationRecord>
      | ((current: AgentConversationRecord) => AgentConversationRecord)
  ) => Promise<AgentConversationRecord>;
}

export interface AgentSessionHandle {
  sessionId: string;
  configOptions: AgentConfigOption[];
  capabilities: AgentProviderCapabilities;
  prompt: (input: {
    text: string;
    userMessageId: string;
    attachments?: Array<{ mimeType: string; data: string; name?: string }>;
    isRetry?: boolean;
    planHandoff?: AgentQueuedChatPrompt["planHandoff"];
  }) => Promise<void>;
  cancel: () => Promise<void>;
  pause?: () => Promise<void>;
  resume?: () => Promise<void>;
  setConfigOption: (configId: string, value: string) => Promise<void>;
  answerPermission: (input: {
    requestId: string;
    optionId?: string;
    cancelled?: boolean;
  }) => Promise<void>;
  answerQuestion?: (input: { questionId: string; answer: string }) => Promise<void>;
  dispose: () => Promise<void>;
}

export interface AgentProvider {
  backend: AgentBackendInfo;
  startSession: (callbacks: AgentRuntimeCallbacks) => Promise<AgentSessionHandle>;
  loadSession: (
    callbacks: AgentRuntimeCallbacks,
    providerSessionId: string
  ) => Promise<AgentSessionHandle>;
}

export type AgentSocketClientMessage =
  | {
      type: "subscribe";
      conversationIds: string[];
      sinceByConversationId?: Record<string, number>;
    }
  | {
      type: "request_history";
      conversationId: string;
      /** Load events strictly before this seq (exclusive). */
      beforeSeq: number;
      limitTurns?: number;
      limitEvents?: number;
    }
  | { type: "ping" };

export type AgentSocketServerMessage =
  | { type: "connected" }
  | { type: "conversation"; conversation: AgentConversationRecord }
  | { type: "snapshot"; snapshot: AgentConversationSnapshot }
  | { type: "snapshot_head"; snapshot: AgentConversationSnapshotHead }
  | {
      type: "history_page";
      workspaceId: string;
      conversationId: string;
      events: AgentStoredEvent[];
      window: AgentConversationEventWindow;
    }
  | {
      type: "event";
      workspaceId: string;
      conversationId: string;
      event: AgentStoredEvent;
    }
  /** Batched `event` for lower JS parse/Redux churn; always preferred when multiple rows arrived. */
  | {
      type: "event_batch";
      workspaceId: string;
      conversationId: string;
      events: AgentStoredEvent[];
    }
  /**
   * Broadcast to every client on the workspace channel when a conversation's
   * metadata changes (title, updatedAt, status, backendId, etc.). Clients use
   * this to invalidate their in-memory conversation list without a
   * visibilitychange refetch.
   */
  | { type: "conversation_upserted"; conversation: AgentConversationRecord }
  /** Same broadcast semantics as `conversation_upserted` but for deletion. */
  | {
      type: "conversation_deleted";
      conversationId: string;
      workspaceId: string;
    }
  | { type: "pong" }
  | {
      type: "error";
      message: string;
      /** Set for targeted failures (e.g. history) so the client can clear a single load gate. */
      conversationId?: string;
      op?: "request_history";
    };

export function createUnavailableCapabilities(): AgentProviderCapabilities {
  return {
    supportsLoadSession: false,
    supportsModeSelection: false,
    supportsModelSelection: false,
    supportsSlashCommands: false,
    supportsPermissions: false,
    supportsToolCalls: false,
    supportsStructuredPlans: false,
    supportsTodos: false,
    supportsSessionResume: false,
    supportsPromptImages: false,
    supportsInlineReasoning: false,
    supportsCompletionRetry: false,
  };
}
