/**
 * Durable last-known-good mirror of the server-backed global settings blob.
 *
 * Global settings (home widgets, rail layout, theme, appearances, …) are owned
 * by the settings server: the client boots with factory defaults in memory and
 * replaces them after a successful GET. Without a local mirror, a boot while
 * the server is unreachable renders factory defaults — on mobile that reads as
 * "all my customizations reverted". This cache seeds the UI with the last
 * state confirmed by (or saved to) the server, keyed per settings server so
 * one server's blob can never bleed into another's.
 *
 * The cache is display/offline state only. `GlobalSettingsProvider` gates all
 * PUTs on a successful fetch for the current server, so cached (or default)
 * state that was never hydrated from the server is never written back over
 * the server's copy.
 */
import { clientKeyValueStore } from "./platform";
import {
  normalizeLoadedGlobalSettings,
  type GlobalSettingsState,
} from "./global-settings";

const GLOBAL_SETTINGS_CACHE_KEY_PREFIX = "opencursor.global-settings-cache.v1:";

export function globalSettingsCacheStorageKey(settingsServerId: string): string {
  return `${GLOBAL_SETTINGS_CACHE_KEY_PREFIX}${settingsServerId}`;
}

/**
 * Read the cached settings blob for a settings server. Returns `null` (never
 * defaults) when the entry is missing, unparseable, or from another schema, so
 * a bad cache can only fall through to normal boot behavior.
 */
export function readCachedGlobalSettings(
  settingsServerId: string
): GlobalSettingsState | null {
  if (!settingsServerId) {
    return null;
  }
  try {
    const raw = clientKeyValueStore().getItem(
      globalSettingsCacheStorageKey(settingsServerId)
    );
    if (!raw) {
      return null;
    }
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object") {
      return null;
    }
    if ((parsed as { schemaVersion?: unknown }).schemaVersion !== 1) {
      return null;
    }
    return normalizeLoadedGlobalSettings(parsed);
  } catch {
    return null;
  }
}

export function writeCachedGlobalSettings(
  settingsServerId: string,
  settings: GlobalSettingsState
): void {
  if (!settingsServerId) {
    return;
  }
  try {
    clientKeyValueStore().setItem(
      globalSettingsCacheStorageKey(settingsServerId),
      JSON.stringify(settings)
    );
  } catch {
    // Storage quota/serialization failures must never break settings flows.
  }
}
