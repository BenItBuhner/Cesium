"use client";

import {
  createDefaultGlobalSettings,
  normalizeLoadedGlobalSettings,
  type GlobalSettingsState,
} from "./global-settings";
import { clientKeyValueStore, getClientPlatform } from "./platform";

/**
 * Client-first app settings store.
 *
 * The client (localStorage, or the platform key-value store on native) is the
 * source of truth for all personalization and customization: theme config,
 * keyboard shortcuts, layout/rail preferences, agent UI toggles, and feature
 * flags. Signed-in users get this document mirrored to their cloud account;
 * guests keep it on-device. Engines no longer store client preferences.
 *
 * A small set of fields remains engine-owned because the engine itself
 * consumes them at run time (permission enforcement, model catalogs). Those
 * are hydrated from the active engine and never persisted here — see
 * {@link stripEngineOwnedSettings}.
 */

export const APP_SETTINGS_STORAGE_KEY = "cesium-app-settings";
export const APP_SETTINGS_EVENT = "cesium:app-settings-changed";
/** Written once the one-time legacy import (engine blob → client) has run. */
export const APP_SETTINGS_MIGRATION_KEY = "cesium-app-settings-migrated";

/**
 * Reset engine-owned fields to their defaults so the persisted client
 * document never carries per-engine state:
 * - `models.byBackend` — model toggles merged against that engine's catalogs.
 * - `agents.rememberedPermissions` — permission rules the engine enforces
 *   (and appends to) during agent runs.
 * - `agents.autoAcceptAllAgentPermissions` / `agents.mcpProt` — enforcement
 *   flags the engine reads when answering permission prompts.
 */
export function stripEngineOwnedSettings(
  settings: GlobalSettingsState
): GlobalSettingsState {
  const defaults = createDefaultGlobalSettings();
  return {
    ...settings,
    agents: {
      ...settings.agents,
      rememberedPermissions: [],
      autoAcceptAllAgentPermissions: defaults.agents.autoAcceptAllAgentPermissions,
      mcpProt: defaults.agents.mcpProt,
    },
    models: { byBackend: {} },
  };
}

/** Overlay the engine-owned fields from `engine` onto `base`. */
export function mergeEngineOwnedSettings(
  base: GlobalSettingsState,
  engine: Pick<GlobalSettingsState, "agents" | "models">
): GlobalSettingsState {
  return {
    ...base,
    agents: {
      ...base.agents,
      rememberedPermissions: engine.agents.rememberedPermissions,
      autoAcceptAllAgentPermissions: engine.agents.autoAcceptAllAgentPermissions,
      mcpProt: engine.agents.mcpProt,
    },
    models: { byBackend: engine.models.byBackend },
  };
}

export function hasStoredAppSettings(): boolean {
  try {
    return Boolean(clientKeyValueStore().getItem(APP_SETTINGS_STORAGE_KEY));
  } catch {
    return false;
  }
}

export function readStoredAppSettings(): GlobalSettingsState | null {
  try {
    const raw = clientKeyValueStore().getItem(APP_SETTINGS_STORAGE_KEY);
    if (!raw) {
      return null;
    }
    return normalizeLoadedGlobalSettings(JSON.parse(raw));
  } catch {
    return null;
  }
}

export function serializeAppSettings(settings: GlobalSettingsState): string {
  return JSON.stringify(stripEngineOwnedSettings(settings));
}

export function notifyAppSettingsChanged(): void {
  getClientPlatform().emitEvent(APP_SETTINGS_EVENT);
}

/**
 * Persist the client-owned slice. Engine-owned fields are stripped so the
 * stored document (and anything mirrored to the cloud) stays engine-free.
 */
export function writeStoredAppSettings(settings: GlobalSettingsState): void {
  try {
    clientKeyValueStore().setItem(
      APP_SETTINGS_STORAGE_KEY,
      serializeAppSettings(settings)
    );
  } catch {
    // Keep the in-memory state; persistence failures must never break the UI.
  }
  notifyAppSettingsChanged();
}

/**
 * Pre-refactor releases stored shared preferences on the engine marked
 * `defaultServerId` in the connections blob. The field no longer exists in
 * the parsed state, so read it raw to aim the one-time legacy import at the
 * engine that actually holds the user's settings.
 */
export function readLegacyDefaultServerId(): string | null {
  try {
    const raw = clientKeyValueStore().getItem("opencursor.server-connections");
    if (!raw) {
      return null;
    }
    const parsed = JSON.parse(raw) as { defaultServerId?: unknown };
    return typeof parsed.defaultServerId === "string" && parsed.defaultServerId
      ? parsed.defaultServerId
      : null;
  } catch {
    return null;
  }
}

export function hasCompletedAppSettingsMigration(): boolean {
  try {
    return clientKeyValueStore().getItem(APP_SETTINGS_MIGRATION_KEY) === "1";
  } catch {
    return false;
  }
}

export function markAppSettingsMigrationComplete(): void {
  try {
    clientKeyValueStore().setItem(APP_SETTINGS_MIGRATION_KEY, "1");
  } catch {
    // Non-fatal; the migration is idempotent.
  }
}
