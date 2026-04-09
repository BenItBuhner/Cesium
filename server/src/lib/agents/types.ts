import type { WorkspaceRecord } from "../workspace-registry.js";

export type AgentConversationMode =
  | "agent"
  | "plan"
  | "debug"
  | "ask"
  | (string & {});

export type AgentBackendId =
  | "cursor-acp"
  | "opencode-acp"
  | "codex-adapter"
  | "claude-adapter";

export type AgentConversationStatus =
  | "idle"
  | "running"
  | "awaiting_permission"
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

export type AgentPermissionOption = {
  optionId: string;
  name: string;
  kind: AgentPermissionOptionKind;
};

export type AgentPendingPermission = {
  requestId: string;
  requestedAt: number;
  toolCallId?: string;
  title?: string;
  /** Human-readable context from the provider (tool summary, CLI text, etc.). */
  detail?: string;
  options: AgentPermissionOption[];
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

export type AgentPlanEntry = {
  id: string;
  content: string;
  priority?: string;
  status: "pending" | "in_progress" | "completed";
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
      attachments?: Array<{ mimeType: string; data: string; name?: string }>;
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
  lastError: string | null;
  experimental: boolean;
  archivedAt: number | null;
  lastReadSeq: number;
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

export type AgentConversationCreateInput = Partial<AgentConversationConfig> & {
  title?: string;
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
  }) => Promise<void>;
  cancel: () => Promise<void>;
  setConfigOption: (configId: string, value: string) => Promise<void>;
  answerPermission: (input: {
    requestId: string;
    optionId?: string;
    cancelled?: boolean;
  }) => Promise<void>;
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
      conversationId: string;
      events: AgentStoredEvent[];
      window: AgentConversationEventWindow;
    }
  | { type: "event"; conversationId: string; event: AgentStoredEvent }
  | { type: "pong" }
  | { type: "error"; message: string };

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
  };
}
