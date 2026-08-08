"use client";

import { clientKeyValueStore, USER_PREFERENCES_STORAGE_KEY } from "@cesium/client";
import { THEME_CONFIG_STORAGE_KEY } from "@/lib/theme-config";
import { THEME_STORAGE_KEY } from "@/lib/theme";

/**
 * Portable personalization payload: the local personalization surface
 * (preferences + theme) bundled into one JSON document for cloud sync, so a
 * fresh device looks and behaves like home the moment you sign in.
 */

const PAYLOAD_VERSION = 1;

type PersonalizationPayload = {
  version: number;
  preferences: string | null;
  theme: string | null;
  themeConfig: string | null;
};

const SYNCED_KEYS: Array<{ key: string; field: keyof Omit<PersonalizationPayload, "version"> }> = [
  { key: USER_PREFERENCES_STORAGE_KEY, field: "preferences" },
  { key: THEME_STORAGE_KEY, field: "theme" },
  { key: THEME_CONFIG_STORAGE_KEY, field: "themeConfig" },
];

export function collectPersonalizationPayload(): string {
  const store = clientKeyValueStore();
  const payload: PersonalizationPayload = {
    version: PAYLOAD_VERSION,
    preferences: null,
    theme: null,
    themeConfig: null,
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
  return changed;
}
