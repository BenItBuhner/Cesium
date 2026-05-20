import type { AgentProviderCapabilities } from "./types.js";

const cesiumCapabilities: AgentProviderCapabilities = {
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
};

export function getCesiumCapabilities(): AgentProviderCapabilities {
  return cesiumCapabilities;
}
