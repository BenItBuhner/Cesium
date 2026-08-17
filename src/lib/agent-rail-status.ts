// Lives in @cesium/client (packages/client/src/agent-rail-status.ts). Re-export shim keeps app imports stable.
export {
  AGENT_RAIL_PRIORITY_BUCKETS,
  AGENT_RAIL_PRIORITY_BUCKET_LABELS,
  AGENT_RAIL_ROW_DETAIL_MODES,
  agentRailConversationIsSettled,
  agentRailConversationNeedsAttention,
  compareAgentRailByStatusPriority,
  formatAgentRailRelativeTime,
  getAgentRailPriorityBucket,
  getAgentRailStatusInfo,
  getAgentRailStatusKind,
  isAgentRailRowDetailMode,
} from "@cesium/client";
export type {
  AgentRailPriorityBucket,
  AgentRailRowDetailMode,
  AgentRailStatusContext,
  AgentRailStatusInfo,
  AgentRailStatusKind,
  AgentRailStatusTone,
} from "@cesium/client";
