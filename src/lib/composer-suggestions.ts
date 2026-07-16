// Moved to @cesium/core. Re-export shim keeps @/lib/composer-suggestions imports stable.
export {
  SLASH_MENU_MAX_VISIBLE_ITEMS,
  applyComposerDirectives,
  filterAtSuggestions,
  filterSlashMenuSections,
  filterSlashMenuSectionsForDisplay,
  flattenSlashMenuSections,
  getActiveSlashQuery,
  getAllAtSuggestions,
  getSlashMenuSections,
  type AtSuggestion,
  type ComposerDirectiveHandlers,
  type SlashMenuAction,
  type SlashMenuFilterResult,
  type SlashMenuItem,
  type SlashMenuSection,
} from "@cesium/core";
