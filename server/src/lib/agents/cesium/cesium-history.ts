import type { CesiumAdapterResult } from "./cesium-types.js";

export {
  CESIUM_TURN_CONTEXT_REMINDER_REASON,
  estimateHistoryTokens,
  isTurnReminder,
  latestContextReminderBaseline,
  latestReportedUsage,
  normalizeCesiumToolResultForModel,
  normalizeEventsToHistory,
  prunedToolCallIds,
  prunedToolResultStub,
  repairOpenAiMessageSequence,
  reportedContextTokens,
  satisfyOpenAiToolProtocol,
  selectHistoryWindow,
  selectTargetedReminders,
  summarizeForCompression,
} from "@cesium/core/cesium-history";

export {
  CESIUM_TIME_GAP_REMINDER_MS,
  cesiumEnvironmentChangeNotice,
  cesiumEnvironmentReminderSnapshot,
  cesiumRelocationChangeNotice,
  formatCesiumDateLabel,
  formatCesiumTimeGapDuration,
  latestCesiumEnvironmentReminderSnapshot,
  latestMcpReminderSnapshot,
  mcpReminderChangeNotice,
  mcpReminderSnapshot,
  previousUserMessageCreatedAt,
  type CesiumEnvironmentReminderSnapshot,
  type McpReminderSnapshot,
} from "./cesium-environment-reminders.js";

export function isEmptyCesiumAdapterResult(result: CesiumAdapterResult): boolean {
  return result.text.trim().length === 0 && result.toolRequests.length === 0;
}
