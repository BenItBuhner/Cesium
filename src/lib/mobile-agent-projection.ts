// Moved to @cesium/core (packages/core/src/mobile-agent-projection.ts). Re-export shim keeps @/lib/mobile-agent-projection imports stable.
export {
  deriveMobileAgentProjection,
  findMobilePullRequestUrl,
  formatMobileEditStats,
  getMobileAgentPhaseLabel,
  getMobileNotificationChip,
  isMobileAgentRunActive,
  summarizeMobileAssistantReply,
} from "@cesium/core";
export type {
  MobileAgentEditStats,
  MobileAgentPhase,
  MobileAgentProjection,
  MobilePendingIntervention,
} from "@cesium/core";
