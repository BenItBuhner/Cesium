// Moved to @cesium/client (packages/client/src/global-settings.ts). Re-export shim keeps existing imports stable.
export {
  DEFAULT_CMD_TAGS,
  DEFAULT_MODE_TAGS,
  createDefaultGlobalSettings,
  normalizeLoadedGlobalSettings,
  applyAgentRailViewPreset,
  matchingAgentRailViewPreset,
} from "@cesium/client";
export type {
  AgentRailGroupByMode,
  AgentRailScope,
  AgentRailSectionId,
  AgentRailSettingsState,
  AgentRailViewPreset,
  AgentsSettingsState,
  ChatFolderState,
  FeaturesSettingsState,
  GeneralSettingsState,
  GlobalAppSettingsSlice,
  GlobalSettingsState,
  ModelToggleState,
  ModelsSettingsState,
  NewChatWidgetId,
  NewChatWidgetsState,
  RememberedAgentPermissionRule,
  ServerRailAppearance,
  ToolsSettingsState,
  WorkspaceRailAppearance,
  WorkspaceSortMode,
} from "@cesium/client";
export {
  AGENT_RAIL_SECTION_IDS,
  AGENT_RAIL_VIEW_PRESETS,
  NEW_CHAT_WIDGET_IDS,
  createDefaultNewChatWidgetsState,
  isNewChatWidgetId,
  normalizeNewChatWidgetsState,
} from "@cesium/client";
export {
  AURORA_MAX_CUSTOM_COLORS,
  AURORA_MIN_CUSTOM_COLORS,
  AURORA_PLACEMENT_IDS,
  AURORA_PLACEMENT_LABELS,
  AURORA_PRESET_CATALOG,
  AURORA_PRESET_IDS,
  DEFAULT_AURORA_PRESET_ID,
  createDefaultAuroraSettings,
  isAuroraPlacementId,
  isAuroraPresetId,
  normalizeAuroraSettings,
  resolveAuroraColors,
} from "@cesium/client";
export type {
  AuroraPlacementId,
  AuroraPresetDefinition,
  AuroraPresetId,
  AuroraSettingsState,
} from "@cesium/client";
