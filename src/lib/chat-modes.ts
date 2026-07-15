// Moved to @cesium/core (packages/core/src/chat-modes.ts). Re-export shim keeps @/lib/chat-modes imports stable.
export {
  DEFAULT_MODE_OPTIONS,
  coerceUnavailableGoalMode,
  ensureCurrentModeOption,
  filterGoalModeOptions,
  formatModeLabel,
  getModeTone,
  isBurnMode,
  isGoalMode,
  isOrchestrationMode,
  isOrchestrationModeLocked,
  resolveCanonicalModeId,
} from "@cesium/core";
