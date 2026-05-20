import type { AgentProviderCapabilities } from "./types.js";

const claudeCodeSdkCapabilities: AgentProviderCapabilities = {
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
};

export function getClaudeCodeSdkCapabilities(): AgentProviderCapabilities {
  return claudeCodeSdkCapabilities;
}
