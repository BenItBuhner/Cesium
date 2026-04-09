import type { WorkspaceRecord } from "./types";

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
};

export type AgentConversationConfigPatch = Partial<AgentConversationConfig> & {
  title?: string;
  setConfigOption?: { configId: string; value: string };
  setConfigOptions?: Array<{ configId: string; value: string }>;
};

export type AgentConversationListResult = {
  backends: AgentBackendInfo[];
  conversations: AgentConversationRecord[];
};

export type AgentRailConversationSummary = Pick<
  AgentConversationRecord,
  "id" | "workspaceId" | "title" | "createdAt" | "updatedAt" | "lastEventSeq" | "status"
> & {
  backendId: AgentBackendId;
  mode: AgentConversationMode;
  experimental: boolean;
  hasPendingPermission: boolean;
};

export type AgentConversationGroup = {
  workspace: WorkspaceRecord;
  conversations: AgentRailConversationSummary[];
};

export type AgentConversationGroupsResult = {
  backends: AgentBackendInfo[];
  groups: AgentConversationGroup[];
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
