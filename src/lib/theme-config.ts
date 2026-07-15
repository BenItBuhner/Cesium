// Moved to @cesium/client (packages/client/src/theme-config.ts). Re-export shim keeps existing imports stable.
export {
  THEME_CONFIG_STORAGE_KEY,
  THEME_STORAGE_KEY,
  TOOL_CALL_DROPDOWN_MAX_HEIGHT_DEFAULT_PX,
  TOOL_CALL_DROPDOWN_MAX_HEIGHT_MAX_PX,
  TOOL_CALL_DROPDOWN_MAX_HEIGHT_MIN_PX,
  createDefaultThemeConfig,
  loadThemeConfigFromStorage,
  normalizeThemeConfig,
  normalizeToolCallDropdownMaxHeightPx,
  persistThemeConfigToStorage,
  serializeThemeConfig,
} from "@cesium/client";
export type {
  CustomThemeEntry,
  EditDiffRenderingMode,
  ThemeConfig,
} from "@cesium/client";
