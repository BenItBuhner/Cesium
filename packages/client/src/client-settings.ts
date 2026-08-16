import { clientKeyValueStore, getClientPlatform } from "./platform";
import {
  createDefaultGlobalSettings,
  normalizeLoadedGlobalSettings,
  type GlobalSettingsState,
} from "./global-settings";

/**
 * Client-owned workbench settings (theme, shortcuts, rail, composer prefs).
 * The engine still owns model catalogs and remembered tool permissions.
 */
export const CLIENT_SETTINGS_STORAGE_KEY = "opencursor.client-settings";
export const CLIENT_SETTINGS_EVENT = "opencursor:client-settings-changed";
export const CLIENT_SETTINGS_MIGRATED_KEY = "opencursor.client-settings-migrated";

export function stripEngineBoundSettings(
  settings: GlobalSettingsState
): GlobalSettingsState {
  const defaults = createDefaultGlobalSettings();
  return {
    ...settings,
    models: defaults.models,
    agents: {
      ...settings.agents,
      rememberedPermissions: defaults.agents.rememberedPermissions,
      autoAcceptAllAgentPermissions: defaults.agents.autoAcceptAllAgentPermissions,
    },
  };
}

export function mergeEngineBoundSettings(
  client: GlobalSettingsState,
  engine: GlobalSettingsState
): GlobalSettingsState {
  return {
    ...client,
    models: engine.models,
    agents: {
      ...client.agents,
      rememberedPermissions: engine.agents.rememberedPermissions,
      autoAcceptAllAgentPermissions: engine.agents.autoAcceptAllAgentPermissions,
    },
  };
}

export function clientSettingsHavePersonalization(
  settings: GlobalSettingsState
): boolean {
  const baseline = stripEngineBoundSettings(createDefaultGlobalSettings());
  const current = stripEngineBoundSettings(settings);
  return JSON.stringify(current) !== JSON.stringify(baseline);
}

export function readClientSettings(): GlobalSettingsState {
  try {
    const raw = clientKeyValueStore().getItem(CLIENT_SETTINGS_STORAGE_KEY);
    if (!raw) {
      return createDefaultGlobalSettings();
    }
    return stripEngineBoundSettings(normalizeLoadedGlobalSettings(JSON.parse(raw)));
  } catch {
    return createDefaultGlobalSettings();
  }
}

export function writeClientSettings(
  settings: GlobalSettingsState,
  options?: { emit?: boolean }
): void {
  const persistable = stripEngineBoundSettings(settings);
  try {
    clientKeyValueStore().setItem(
      CLIENT_SETTINGS_STORAGE_KEY,
      JSON.stringify(persistable)
    );
  } catch {
    // Ignore quota / private-mode failures; in-memory state still applies.
  }
  if (options?.emit !== false) {
    getClientPlatform().emitEvent(CLIENT_SETTINGS_EVENT);
  }
}

export function hasMigratedClientSettingsFromEngine(): boolean {
  return clientKeyValueStore().getItem(CLIENT_SETTINGS_MIGRATED_KEY) === "1";
}

export function markClientSettingsMigratedFromEngine(): void {
  clientKeyValueStore().setItem(CLIENT_SETTINGS_MIGRATED_KEY, "1");
}

export function serializeClientSettingsPayload(settings: GlobalSettingsState): string {
  return JSON.stringify(stripEngineBoundSettings(settings));
}

export function parseClientSettingsPayload(raw: string): GlobalSettingsState | null {
  try {
    return stripEngineBoundSettings(normalizeLoadedGlobalSettings(JSON.parse(raw)));
  } catch {
    return null;
  }
}
