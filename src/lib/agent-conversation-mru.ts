// Moved to @cesium/client (packages/client/src/agent-conversation-mru.ts). Re-export shim keeps existing imports stable.
export {
  AGENT_CONVERSATION_MRU_MAX,
  buildAgentSwitcherList,
  bumpAgentConversationMru,
  initialAgentSwitcherIndex,
  isValidAgentConversationMruId,
  nextAgentSwitcherIndex,
  normalizeAgentConversationMruByServer,
  seedAgentConversationMruFromCandidates,
} from "@cesium/client";
export type {
  AgentSwitcherCandidate,
} from "@cesium/client";
