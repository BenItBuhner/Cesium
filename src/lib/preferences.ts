// Moved to @cesium/client (packages/client/src/preferences.ts). Re-export shim keeps existing imports stable.
export {
  DEFAULT_USER_PREFERENCES,
  USER_PREFERENCES_STORAGE_KEY,
  parseUserPreferences,
  serializeUserPreferences,
} from "@cesium/client";
export type {
  UserPreferences,
} from "@cesium/client";
