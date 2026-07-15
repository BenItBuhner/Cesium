// Moved to @cesium/core (packages/core/src/agent-completion-error.ts). Re-export shim keeps @/lib/agent-completion-error imports stable.
export {
  COMPLETION_AUTO_RETRY_MAX_ATTEMPTS,
  COMPLETION_RETRY_DELAYS_MS,
  COMPLETION_RETRY_MIN_BUSY_MS,
  COMPRESSING_CONTEXT_STATUS_PREFIX,
  TAKING_LONGER_STATUS_PREFIX,
  completionErrorDismissKey,
  computeCompletionAutoRetryActive,
  computeCompletionRetriesRemaining,
  computeCompletionRetryDelayMs,
  computeRetryCountdownProgress,
  conversationHasCompletionFailure,
  deriveConversationCompletionError,
  isAgentComposerBusy,
  isCesiumFailureAssistantChunk,
  isCompletionFailureThreadContent,
  isCompressingContextStatusDetail,
  isRetryableError,
  isTakingLongerStatusDetail,
  normalizeCompletionFailureText,
  parseAgentCompletionError,
  shouldHideCompletionFailureInThread,
} from "@cesium/core";
export type {
  AgentCompletionErrorViewModel,
} from "@cesium/core";
