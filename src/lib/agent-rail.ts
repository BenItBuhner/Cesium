// Moved to @cesium/client (packages/client/src/agent-rail.ts). Re-export shim keeps existing imports stable.
export {
  AGENT_RAIL_FILTER_PRESETS,
  AGENT_RAIL_FILTER_TOGGLE_KEYS,
  defaultAgentRailFilterToggles,
  isAgentRailFilterActive,
  isAgentRailFilterPreset,
  isPlaceholderAgentRailConversation,
  isRenderableAgentRailConversation,
  matchesAgentRailMultiFilter,
  normalizeAgentRailFilterToggles,
} from "@cesium/client";
export type {
  AgentRailFilterMatchContext,
  AgentRailFilterPreset,
  AgentRailFilterToggleKey,
  AgentRailFilterToggleState,
} from "@cesium/client";
