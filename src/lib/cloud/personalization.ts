"use client";

import {
  CLIENT_SETTINGS_STORAGE_KEY,
  clientKeyValueStore,
  parseClientSettingsPayload,
  USER_PREFERENCES_STORAGE_KEY,
  writeClientSettings,
} from "@cesium/client";
import { THEME_CONFIG_STORAGE_KEY } from "@/lib/theme-config";
import { THEME_STORAGE_KEY } from "@/lib/theme";

/**
 * Portable personalization payload: the local personalization surface
 * (preferences + theme + client-owned workbench settings) bundled into one
 * JSON document for cloud sync, so a fresh sign-in looks like home.
 */

const PAYLOAD_VERSION = 2;

type PersonalizationPayload = {
  version: number;
  preferences: string | null;
  theme: string | null;
  themeConfig: string | null;
  clientSettings: string | null;
};

const SYNCED_KEYS: Array<{
  key: string;
  field: keyof Omit<PersonalizationPayload, "version">;
}> = [
  { key: USER_PREFERENCES_STORAGE_KEY, field: "preferences" },
  { key: THEME_STORAGE_KEY, field: "theme" },
  { key: THEME_CONFIG_STORAGE_KEY, field: "themeConfig" },
  { key: CLIENT_SETTINGS_STORAGE_KEY, field: "clientSettings" },
];

export function collectPersonalizationPayload(): string {
  const store = clientKeyValueStore();
  const payload: PersonalizationPayload = {
    version: PAYLOAD_VERSION,
    preferences: null,
    theme: null,
    themeConfig: null,
    clientSettings: null,
  };
  for (const { key, field } of SYNCED_KEYS) {
    payload[field] = store.getItem(key);
  }
  return JSON.stringify(payload);
}

/**
 * Apply a cloud payload to local storage. Returns true when anything changed
 * (callers reload theme-affecting UI in that case).
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
  for (const { key, field } of SYNCED_KEYS) {
    const value = parsed[field];
    if (typeof value !== "string") {
      continue;
    }
    if (store.getItem(key) !== value) {
      store.setItem(key, value);
      changed = true;
    }
  }
  if (typeof parsed.clientSettings === "string") {
    const next = parseClientSettingsPayload(parsed.clientSettings);
    if (next) {
      writeClientSettings(next);
    }
  }
  return changed;
}
