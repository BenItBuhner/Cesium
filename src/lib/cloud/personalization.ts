"use client";

import {
  APP_SETTINGS_STORAGE_KEY,
  clientKeyValueStore,
  notifyAppSettingsChanged,
  THEME_CONFIG_STORAGE_KEY,
  THEME_STORAGE_KEY,
  USER_PREFERENCES_STORAGE_KEY,
} from "@cesium/client";

/**
 * Portable personalization payload: the client-owned personalization surface
 * bundled into one JSON document for cloud sync, so a fresh device looks and
 * behaves like home the moment you sign in.
 *
 * v2 carries the full client-first app settings document (theme config,
 * keyboard shortcuts, layout/rail preferences, agent UI toggles, features)
 * alongside the original v1 keys. v1 payloads still apply cleanly.
 */

const PAYLOAD_VERSION = 2;

type PersonalizationPayload = {
  version: number;
  preferences: string | null;
  theme: string | null;
  themeConfig: string | null;
  /** v2+: serialized client-owned `GlobalSettingsState` document. */
  appSettings: string | null;
};

const SYNCED_KEYS: Array<{ key: string; field: keyof Omit<PersonalizationPayload, "version"> }> = [
  { key: USER_PREFERENCES_STORAGE_KEY, field: "preferences" },
  { key: THEME_STORAGE_KEY, field: "theme" },
  { key: THEME_CONFIG_STORAGE_KEY, field: "themeConfig" },
  { key: APP_SETTINGS_STORAGE_KEY, field: "appSettings" },
];

export function collectPersonalizationPayload(): string {
  const store = clientKeyValueStore();
  const payload: PersonalizationPayload = {
    version: PAYLOAD_VERSION,
    preferences: null,
    theme: null,
    themeConfig: null,
    appSettings: null,
  };
  for (const { key, field } of SYNCED_KEYS) {
    payload[field] = store.getItem(key);
  }
  return JSON.stringify(payload);
}

/**
 * Apply a cloud payload to local storage. Returns true when anything changed
 * (callers reload theme-affecting UI in that case). Settings consumers are
 * notified so the client-first settings provider re-reads its store.
 */
export function applyPersonalizationPayload(raw: string): boolean {
  let parsed: PersonalizationPayload;
  try {
    parsed = JSON.parse(raw) as PersonalizationPayload;
  } catch {
    return false;
  }
  if (!parsed || typeof parsed !== "object") {
    return false;
  }
  const store = clientKeyValueStore();
  let changed = false;
  let appSettingsChanged = false;
  for (const { key, field } of SYNCED_KEYS) {
    const value = parsed[field];
    if (typeof value !== "string") {
      continue;
    }
    if (store.getItem(key) !== value) {
      store.setItem(key, value);
      changed = true;
      if (key === APP_SETTINGS_STORAGE_KEY) {
        appSettingsChanged = true;
      }
    }
  }
  if (appSettingsChanged) {
    notifyAppSettingsChanged();
  }
  return changed;
}
