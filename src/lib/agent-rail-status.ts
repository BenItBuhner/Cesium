// Lives in @cesium/client (packages/client/src/agent-rail-status.ts). Re-export shim keeps app imports stable.
export {
  AGENT_RAIL_ROW_DETAIL_MODES,
  agentRailConversationNeedsAttention,
  compareAgentRailByStatusPriority,
  formatAgentRailRelativeTime,
  getAgentRailStatusInfo,
  getAgentRailStatusKind,
  isAgentRailRowDetailMode,
} from "@cesium/client";
export type {
  AgentRailRowDetailMode,
  AgentRailStatusContext,
  AgentRailStatusInfo,
  AgentRailStatusKind,
  AgentRailStatusTone,
} from "@cesium/client";
