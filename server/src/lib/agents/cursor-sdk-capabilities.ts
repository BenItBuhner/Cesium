import type { AgentProviderCapabilities } from "./types.js";

/** Static metadata only — keeps `providers.ts` from importing `@cursor/sdk` at process load. */
const cursorSdkCapabilities: AgentProviderCapabilities = {
  supportsLoadSession: true,
  supportsModeSelection: true,
  supportsModelSelection: true,
  supportsSlashCommands: false,
  supportsPermissions: false,
  supportsToolCalls: true,
  supportsStructuredPlans: true,
  supportsTodos: true,
  supportsSessionResume: true,
  supportsPromptImages: true,
  supportsInlineReasoning: true,
  supportsCompletionRetry: false,
};

export function getCursorSdkCapabilities(): AgentProviderCapabilities {
  return cursorSdkCapabilities;
}
