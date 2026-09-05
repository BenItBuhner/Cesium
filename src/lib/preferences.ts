// Moved to @cesium/client (packages/client/src/preferences.ts). Re-export shim keeps existing imports stable.
export {
  DEFAULT_USER_PREFERENCES,
  FEATURES_BOOT_CACHE_STORAGE_KEY,
  LEGACY_USER_PREFERENCES_STORAGE_KEY,
  USER_PREFERENCES_CHANGED_EVENT,
  mergeLegacyUserPreferences,
  parseUserPreferences,
  readFeaturesBootCache,
  serializeUserPreferences,
  userPreferencesEqual,
  writeFeaturesBootCache,
} from "@cesium/client";
export type {
  UserPreferences,
} from "@cesium/client";
