export type AgentConversationMode =
  | "agent"
  | "plan"
  | "debug"
  | "ask"
  | (string & {});

export type AgentBackendId =
  | "cesium-agent"
  | "cursor-sdk"
  | "opencode-server"
  | "gemini-acp"
  | "codex-app-server"
  | "claude-code-sdk";

export type AgentConversationStatus =
  | "idle"
  | "running"
  | "pause_requested"
  | "pausing"
  | "paused"
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
  supportsPromptImages?: boolean;
  supportsInlineReasoning?: boolean;
};

export type AgentConversationConfig = {
  backendId: AgentBackendId;
  mode: AgentConversationMode;
  modelId: string;
  modelName: string;
};

export type AgentStoredEventBase = {
  seq: number;
  eventId: string;
  conversationId: string;
  createdAt: number;
  raw?: unknown;
};

export type AgentStoredEvent =
  | (AgentStoredEventBase & {
      kind: "user_message";
      messageId: string;
      content: string;
      displayContent?: string;
      attachments?: Array<{ mimeType: string; data: string; name?: string }>;
      inheritedInFork?: boolean;
    })
  | (AgentStoredEventBase & {
      kind: "assistant_message_chunk" | "reasoning";
      messageId: string;
      text: string;
    })
  | (AgentStoredEventBase & {
      kind: "assistant_message_end";
      messageId: string;
      stopReason?: string;
    })
  | (AgentStoredEventBase & {
      kind: "tool_call" | "tool_call_update";
      toolCallId: string;
      title?: string;
      toolKind?: string;
      status: AgentToolCallStatus;
      detail?: string;
      locations?: Array<{ path: string; line?: number }>;
      editPreview?: unknown;
      openCodeSubagentSessionId?: string;
    })
  | (AgentStoredEventBase & {
      kind: "status";
      status: AgentConversationStatus;
      message?: string;
    });
