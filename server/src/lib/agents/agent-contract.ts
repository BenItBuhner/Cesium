import type {
  AgentBackendId,
  AgentProviderCapabilities,
} from "./types.js";

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

/**
 * Single source of truth for each backend's advertised capabilities. Kept in
 * `agent-contract.ts` (which only imports types) so `providers.ts` and the
 * individual provider modules can read static metadata without pulling in the
 * heavy provider SDKs at process load.
 */
export const AGENT_CAPABILITIES: Record<AgentBackendId, AgentProviderCapabilities> = {
  "cesium-agent": {
    supportsLoadSession: true,
    supportsModeSelection: true,
    supportsModelSelection: true,
    supportsSlashCommands: false,
    supportsPermissions: true,
    supportsToolCalls: true,
    supportsStructuredPlans: true,
    supportsTodos: true,
    supportsSessionResume: true,
    supportsPromptImages: true,
    supportsInlineReasoning: true,
    supportsCompletionRetry: true,
  },
  "cursor-sdk": {
    supportsLoadSession: true,
    supportsModeSelection: true,
    supportsModelSelection: true,
    supportsSlashCommands: false,
    supportsPermissions: true,
    supportsToolCalls: true,
    supportsStructuredPlans: true,
    supportsTodos: true,
    supportsSessionResume: true,
    supportsPromptImages: true,
    supportsInlineReasoning: true,
    supportsCompletionRetry: false,
  },
  "opencode-server": {
    supportsLoadSession: true,
    supportsModeSelection: true,
    supportsModelSelection: true,
    supportsSlashCommands: true,
    supportsPermissions: true,
    supportsToolCalls: true,
    supportsStructuredPlans: true,
    supportsTodos: true,
    supportsSessionResume: true,
    supportsPromptImages: true,
    supportsInlineReasoning: true,
    supportsCompletionRetry: false,
  },
  "devin-acp": {
    supportsLoadSession: true,
    supportsModeSelection: true,
    supportsModelSelection: true,
    supportsSlashCommands: true,
    supportsPermissions: true,
    supportsToolCalls: true,
    supportsStructuredPlans: true,
    supportsTodos: true,
    supportsSessionResume: true,
    supportsPromptImages: true,
    supportsInlineReasoning: true,
    supportsCompletionRetry: false,
  },
  "codex-app-server": {
    supportsLoadSession: true,
    supportsModeSelection: true,
    supportsModelSelection: true,
    supportsSlashCommands: true,
    supportsPermissions: true,
    supportsToolCalls: true,
    supportsStructuredPlans: true,
    supportsTodos: true,
    supportsSessionResume: true,
    supportsPromptImages: true,
    supportsInlineReasoning: true,
    supportsCompletionRetry: false,
  },
  "claude-code-sdk": {
    supportsLoadSession: true,
    supportsModeSelection: true,
    supportsModelSelection: true,
    supportsSlashCommands: true,
    supportsPermissions: true,
    supportsToolCalls: true,
    supportsStructuredPlans: true,
    supportsTodos: true,
    supportsSessionResume: true,
    supportsPromptImages: false,
    supportsInlineReasoning: true,
    supportsCompletionRetry: false,
  },
  "pi-agent": {
    supportsLoadSession: true,
    supportsModeSelection: false,
    supportsModelSelection: true,
    supportsSlashCommands: true,
    supportsPermissions: false,
    supportsToolCalls: true,
    supportsStructuredPlans: false,
    supportsTodos: false,
    supportsSessionResume: true,
    supportsPromptImages: true,
    supportsInlineReasoning: true,
    supportsCompletionRetry: false,
  },
  "google-antigravity-cli": {
    supportsLoadSession: true,
    supportsModeSelection: true,
    supportsModelSelection: true,
    supportsSlashCommands: true,
    supportsPermissions: true,
    supportsToolCalls: true,
    supportsStructuredPlans: true,
    supportsTodos: true,
    supportsSessionResume: true,
    supportsPromptImages: false,
    supportsInlineReasoning: true,
    supportsCompletionRetry: false,
  },
};

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

export type BackendHarnessExpectation = {
  /**
   * Canonical event kinds the backend is expected to be able to emit when its
   * advertised capabilities are exercised. This is intentionally broader than a
   * single smoke turn and is used as a fixture checklist for provider sweeps.
   */
  expectedEventKinds: AgentStoredEventKind[];
  notes?: string;
};

const textTurnEvents = [
  "user_message",
  "assistant_message_chunk",
  "assistant_message_end",
  "status",
] as const satisfies readonly AgentStoredEventKind[];

const toolEvents = [
  "tool_call",
  "tool_call_update",
] as const satisfies readonly AgentStoredEventKind[];

const permissionEvents = [
  "permission_request",
  "permission_resolved",
] as const satisfies readonly AgentStoredEventKind[];

export const BACKEND_HARNESS_EXPECTATIONS: Record<
  AgentBackendId,
  BackendHarnessExpectation
> = {
  "cesium-agent": {
    expectedEventKinds: [
      ...textTurnEvents,
      "system_reminder",
      "reasoning",
      ...toolEvents,
      "plan",
      "plan_file",
      "question",
      "compression_summary",
      ...permissionEvents,
      "system",
      "agent_handoff",
      "chat_fork",
    ],
  },
  "cursor-sdk": {
    expectedEventKinds: [
      ...textTurnEvents,
      "reasoning",
      ...toolEvents,
      "plan",
      "plan_file",
      "question",
      ...permissionEvents,
      "system",
    ],
    notes: "Question and plan approval support must be verified against the installed SDK.",
  },
  "opencode-server": {
    expectedEventKinds: [
      ...textTurnEvents,
      "reasoning",
      ...toolEvents,
      "plan",
      "subagent",
      ...permissionEvents,
      "system",
    ],
    notes: "Subagent events depend on global/child SSE routing.",
  },
  "devin-acp": {
    expectedEventKinds: [
      ...textTurnEvents,
      "reasoning",
      ...toolEvents,
      "plan",
      ...permissionEvents,
      "system",
    ],
    notes: "Devin CLI ACP (`devin acp`); richer CLI-only interactions may not surface over ACP.",
  },
  "codex-app-server": {
    expectedEventKinds: [
      ...textTurnEvents,
      "reasoning",
      ...toolEvents,
      "plan",
      "plan_file",
      "subagent",
      ...permissionEvents,
      "system",
    ],
    notes: "plan_file is produced by the OpenCursor mirroring layer, not Codex itself.",
  },
  "claude-code-sdk": {
    expectedEventKinds: [
      ...textTurnEvents,
      "reasoning",
      ...toolEvents,
      "plan",
      "plan_file",
      "question",
      ...permissionEvents,
      "system",
    ],
    notes: "plan_file/question events require the shared plan and AskUserQuestion bridge.",
  },
  "pi-agent": {
    expectedEventKinds: [
      ...textTurnEvents,
      "reasoning",
      ...toolEvents,
      "plan",
      "question",
      ...permissionEvents,
      "system",
    ],
  },
  "google-antigravity-cli": {
    expectedEventKinds: [
      ...textTurnEvents,
      "reasoning",
      ...toolEvents,
      "plan",
      "plan_file",
      "subagent",
      "question",
      ...permissionEvents,
      "system",
    ],
    notes:
      "Plan/todo events are mirrored from manage_task; MCP and prompt attachments are limited by Antigravity workspace config and CLI support.",
  },
};
