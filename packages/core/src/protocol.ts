import type { QueuedChatPrompt, WorkspaceRecord } from "./types";

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
  | "cursor-acp"
  | "opencode-server"
  | "opencode-v2-beta"
  | "devin-acp"
  | "grok-build"
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

export type AgentModelParameterValue = {
  /** Provider-defined parameter id; never inferred from the display name. */
  id: string;
  name?: string;
  value: string;
  valueName?: string;
};

export type AgentConfigOptionValue = {
  value: string;
  name: string;
  description?: string;
  metadata?: Record<string, string | string[]>;
  /** Stable identity/display name shared by parameter variants of one model. */
  modelGroupId?: string;
  modelGroupName?: string;
  /**
   * Effective model parameter values for this exact catalog row. Keeping
   * these structured prevents distinct controls (for example effort and
   * thinking) from being collapsed by display-name parsing.
   */
  modelParameters?: AgentModelParameterValue[];
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

/** Live CLI detection details for a harness-backed agent backend. */
export type AgentBackendRuntimeInfo = {
  executablePath: string;
  source: "env" | "path" | "well-known";
  version: string | null;
};

export type AgentBackendInfo = {
  id: AgentBackendId;
  label: string;
  description: string;
  commandPreview?: string;
  experimental?: boolean;
  available: boolean;
  /**
   * Whether Settings → Agents currently exposes this harness in the composer
   * picker. Disabled harnesses stay usable for existing chats.
   */
  enabled?: boolean;
  defaultMode: AgentConversationMode;
  defaultModelId: string;
  defaultModelName: string;
  capabilities: AgentProviderCapabilities;
  cachedConfigOptions?: AgentConfigOption[];
  /** Detected CLI installation (path, discovery source, version) when applicable. */
  runtime?: AgentBackendRuntimeInfo | null;
};

export type AgentConversationConfig = {
  backendId: AgentBackendId;
  mode: AgentConversationMode;
  modelId: string;
  modelName: string;
  /** Cesium capability profile id ("code", "work", or a custom profile id). */
  profileId?: string;
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
      displayContent?: string;
      hidden?: boolean;
      attachments?: Array<{
        mimeType: string;
        data: string;
        name?: string;
        kind?: "image" | "file";
        savedPath?: string;
        size?: number;
      }>;
      inheritedInFork?: boolean;
    }
  | {
      seq: number;
      eventId: string;
      conversationId: string;
      createdAt: number;
      kind: "system_reminder";
      reminderId: string;
      targetMessageId?: string;
      reason: "mode" | "plan_handoff" | "compaction" | "goal" | "burn" | "attachments" | "other";
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
      /** OpenCode global SSE: tool ran in this child session (not the ACP root session). */
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
  kind: "agent_handoff";
  fromAgent: string;
  toAgent: string;
  handoffMessageId?: string;
  turnCount?: number;
  toolCallCount?: number;
  /**
   * Set when the handoff returns to the harness the conversation was imported
   * from and natively resumes the original session instead of transferring a
   * transcript. The prompt path must not wrap the next turn in handoff context.
   */
  resumeNativeSession?: boolean;
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

/**
 * Where a conversation was triggered from. Conversations started from external
 * sources (Linear/GitHub/Slack via Cloud Agents) are normal conversations in
 * every way — this only records provenance for rail badges and filtering.
 */
export type AgentConversationOrigin =
  | {
      kind: "cloud";
      providerId: "linear" | "github" | "slack" | "manual";
      /** Cloud Agents task id linking back to the external assignment. */
      taskId?: string;
      /** Short human label, e.g. "owner/repo#42" or "OSP-67". */
      label?: string;
      /** Deep link to the source issue/message. */
      url?: string;
    }
  | {
      kind: "import";
      /** Cesium backend id of the harness the session was imported from. */
      backendId: AgentBackendId;
      /** Harness-native session/conversation/thread id, preserved verbatim. */
      externalSessionId: string;
      /** Absolute path of the source artifact the session was read from. */
      sourcePath?: string;
      /** Original working directory of the harness session, when known. */
      sourceCwd?: string;
      /** ISO timestamp of the source session start, when known. */
      sourceStartedAt?: string;
      /** Source-side last-activity timestamp at the moment of the last sync. */
      sourceUpdatedAt?: number | null;
      /** When the session was last (re-)imported into Cesium. */
      importedAt: number;
    }
  | {
      kind: "cloud-snapshot";
      /** Cloud Context snapshot key (origin conversation id on the source engine). */
      snapshotKey: string;
      /** Human labels captured when the snapshot was pushed. */
      sourceServerName?: string | null;
      sourceWorkspaceName?: string | null;
      /** Source-side last-activity timestamp when the snapshot was pushed. */
      sourceUpdatedAt?: number | null;
      /** When the snapshot was last materialized on this engine. */
      importedAt: number;
    }
  | {
      kind: "trigger";
      /** Scheduled trigger that spawned this conversation. */
      triggerId: string;
      /** Trigger display name at fire time. */
      triggerName?: string;
      /** When the trigger fired. */
      firedAt: number;
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
  /** Server-owned archive flag; null = visible in the default rail. */
  archivedAt: number | null;
  /**
   * Server-owned "settled" flag. Settled conversations sink to the bottom of
   * the rail; a new user prompt automatically clears the flag ("unsettles").
   */
  settledAt?: number | null;
  lastReadSeq: number;
  /** FIFO follow-up prompts while a turn is running; owned by the server. */
  queuedPrompts: QueuedChatPrompt[];
  /** Set when the conversation was triggered from an external source. */
  origin?: AgentConversationOrigin | null;
};

export type AgentConversationSnapshot = {
  conversation: AgentConversationRecord;
  events: AgentStoredEvent[];
};

export type AgentConversationEventWindow = {
  oldestSeq: number;
  newestSeq: number;
  hasOlder: boolean;
};

/** Paginated tail snapshot (default from API and WebSocket). */
export type AgentConversationSnapshotHead = {
  conversation: AgentConversationRecord;
  events: AgentStoredEvent[];
  window: AgentConversationEventWindow;
};

export type AgentConversationCreateInput = Partial<AgentConversationConfig> & {
  title?: string;
  archived?: boolean;
  /** Provenance for conversations triggered from external sources. */
  origin?: AgentConversationOrigin | null;
};

/** One harness's import capability as reported by GET /api/agents/imports/sources. */
export type AgentImportSourceInfo = {
  backendId: AgentBackendId;
  label: string;
  /** Stable key of the harness family providing local storage, when importable. */
  harnessKey: string | null;
  available: boolean;
  /** Why import is unavailable (or extra context) — shown greyed out in the UI. */
  reason?: string;
  storageRoot?: string | null;
  sessionCount: number;
};

/** One harness-native session as reported by GET /api/agents/imports/:backendId/sessions. */
export type AgentImportSessionSummary = {
  /** Harness-native session id, preserved verbatim through import + resume. */
  id: string;
  title: string;
  cwd?: string;
  createdAt: number | null;
  updatedAt: number | null;
  messageCount: number;
  sourcePath: string;
  preview?: string;
  /** Set when this session was already imported into the current workspace. */
  importedConversationId?: string | null;
};

/** Response of POST /api/agents/imports/:backendId/import. */
export type AgentImportResult = {
  conversationId: string;
  /** True when a new conversation was created; false when re-synced in place. */
  created: boolean;
  eventCount: number;
  providerSessionId: string | null;
  title: string;
  backendId: AgentBackendId;
};

export type AgentConversationConfigPatch = Partial<AgentConversationConfig> & {
  title?: string;
  setConfigOption?: { configId: string; value: string };
  setConfigOptions?: Array<{ configId: string; value: string }>;
};

export type AgentConversationMetadataPatch = {
  archived?: boolean;
  /** Toggle the user-facing "settled" state; sending a prompt auto-clears it. */
  settled?: boolean;
  lastReadSeq?: number;
};

export type AgentConversationListResult = {
  backends: AgentBackendInfo[];
  conversations: AgentConversationRecord[];
  /** Opaque pagination cursor. Present when there are more pages; `null` when exhausted. */
  nextCursor?: string | null;
};

export type AgentRailConversationSummary = Pick<
  AgentConversationRecord,
  | "id"
  | "workspaceId"
  | "title"
  | "createdAt"
  | "updatedAt"
  | "lastEventSeq"
  | "status"
  | "archivedAt"
> & {
  backendId: AgentBackendId;
  mode: AgentConversationMode;
  experimental: boolean;
  hasPendingPermission: boolean;
  /** Optional: older servers omit these richer status fields. */
  hasPendingQuestion?: boolean;
  /** Set when the user marked the conversation as settled; a new prompt clears it. */
  settledAt?: number | null;
  /** Short human title of the pending permission request (e.g. "Run terminal command"). */
  pendingPermissionTitle?: string | null;
  /** First line of the last error, truncated for rail display. */
  lastErrorSummary?: string | null;
  origin?: AgentConversationOrigin | null;
  serverId?: string;
  serverLabel?: string;
  workspaceKey?: string;
  conversationKey?: string;
  repositoryKey?: string;
  repository?: AgentRailRepositoryInfo;
};

export type AgentRailRepositoryInfo = {
  isGitRepo: boolean;
  repoRoot?: string;
  repoKey?: string;
  /** Canonical network remote identity shared by clones on different machines. */
  repositoryId?: string;
  currentBranch?: string | null;
  worktreeBaseRoot?: string;
};

export type AgentConversationGroup = {
  workspace: WorkspaceRecord;
  conversations: AgentRailConversationSummary[];
  serverId?: string;
  serverLabel?: string;
  /** Source machines represented after repository/server regrouping. */
  serverIds?: string[];
  workspaceKey?: string;
  repositoryKey?: string;
  repository?: AgentRailRepositoryInfo;
  serverAuthRequired?: boolean;
};

export type AgentConversationGroupsResult = {
  backends: AgentBackendInfo[];
  groups: AgentConversationGroup[];
  /** Opaque pagination cursor. Present when there are more pages; `null` when exhausted. */
  nextCursor?: string | null;
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

export type AgentSocketClientMessage =
  | {
      type: "subscribe";
      conversationIds: string[];
      sinceByConversationId?: Record<string, number>;
    }
  | {
      type: "request_history";
      conversationId: string;
      beforeSeq: number;
      limitTurns?: number;
      limitEvents?: number;
    }
  | {
      /**
       * Gap recovery: replay events after `sinceSeq` for a subscribed
       * conversation. Sent when the client detects a sequence gap in the live
       * stream or when a pushed record's `lastEventSeq` runs ahead of the
       * local log (stream frames are droppable under backpressure by design —
       * this is the heal path).
       */
      type: "request_events_since";
      conversationId: string;
      sinceSeq: number;
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
  | {
      type: "event_batch";
      workspaceId: string;
      conversationId: string;
      events: AgentStoredEvent[];
    }
  /**
   * Broadcast to every client on the workspace channel when a conversation's
   * metadata (title, updatedAt, status, backendId, etc.) changes. Clients use
   * this to invalidate their in-memory conversation list without having to
   * refetch on `visibilitychange`.
   */
  | {
      type: "conversation_upserted";
      conversation: AgentConversationRecord;
    }
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
      conversationId?: string;
      op?: "request_history" | "request_events_since";
    };

/**
 * Legacy exports preserved from the original packages/core protocol module.
 * Server-side contract tests and tooling reference these constants.
 */
export const AGENT_CAPABILITY_KEYS = [
  "supportsLoadSession",
  "supportsModeSelection",
  "supportsModelSelection",
  "supportsSlashCommands",
  "supportsPermissions",
  "supportsToolCalls",
  "supportsStructuredPlans",
  "supportsTodos",
  "supportsSessionResume",
  "supportsPromptImages",
  "supportsInlineReasoning",
  "supportsCompletionRetry",
] as const satisfies readonly (keyof AgentProviderCapabilities)[];

export const AGENT_STORED_EVENT_KINDS = [
  "user_message",
  "system_reminder",
  "assistant_message_chunk",
  "assistant_message_end",
  "reasoning",
  "tool_call",
  "tool_call_update",
  "plan",
  "plan_file",
  "subagent",
  "question",
  "compression_summary",
  "permission_request",
  "permission_resolved",
  "system",
  "status",
  "agent_handoff",
  "chat_fork",
] as const;

export type AgentStoredEventKind = (typeof AGENT_STORED_EVENT_KINDS)[number];

export type AgentStoredEventBase = {
  seq: number;
  eventId: string;
  conversationId: string;
  createdAt: number;
  raw?: unknown;
};
