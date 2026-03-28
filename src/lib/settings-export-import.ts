import type { GlobalAppSettingsSlice, GlobalSettingsState } from "@/lib/global-settings";
import {
  normalizeKeyboardShortcutsState,
  type KeyboardShortcutsSettingsState,
} from "@/lib/keyboard-shortcuts";
import { parseUserPreferences, type UserPreferences } from "@/lib/preferences";
import { parseThemePreference, type ThemePreference } from "@/lib/theme";
import type { WorkspaceSessionState } from "@/lib/workspace-session";

export const SETTINGS_EXPORT_SCHEMA_VERSION = 1 as const;

export type SettingsExportGranularity = {
  theme: boolean;
  userPreferences: boolean;
  keyboardShortcuts: boolean;
  globalApp: boolean;
  workspaceSession: boolean;
};

export type SettingsExportBundleV1 = {
  schemaVersion: typeof SETTINGS_EXPORT_SCHEMA_VERSION;
  exportedAt: string;
  theme?: ThemePreference;
  userPreferences?: UserPreferences;
  keyboardShortcuts?: KeyboardShortcutsSettingsState;
  globalApp?: GlobalAppSettingsSlice;
  workspaceSession?: WorkspaceSessionState;
};

export function sliceGlobalAppFromSettings(
  settings: GlobalSettingsState
): GlobalAppSettingsSlice {
  const { general, agents, models, rules, tools } = settings;
  return { general, agents, models, rules, tools };
}

export function mergeImportedGlobalAppSlice(
  current: GlobalSettingsState,
  imported: GlobalAppSettingsSlice
): GlobalSettingsState {
  return {
    ...current,
    general: { ...current.general, ...imported.general },
    agents: {
      ...current.agents,
      ...imported.agents,
      cmdTags: imported.agents.cmdTags ?? current.agents.cmdTags,
      modeTags: imported.agents.modeTags ?? current.agents.modeTags,
    },
    models: {
      models:
        imported.models?.models && imported.models.models.length > 0
          ? imported.models.models
          : current.models.models,
    },
    rules: { ...current.rules, ...imported.rules },
    tools: {
      ...current.tools,
      ...imported.tools,
      mcpTags: imported.tools.mcpTags ?? current.tools.mcpTags,
      domainTags: imported.tools.domainTags ?? current.tools.domainTags,
      pluginState: imported.tools.pluginState ?? current.tools.pluginState,
    },
  };
}

function isThemePreference(value: unknown): value is ThemePreference {
  return value === "light" || value === "dark" || value === "system";
}

function parseUserPreferencesFromExport(value: unknown): UserPreferences | null {
  if (!value || typeof value !== "object") {
    return null;
  }
  try {
    return parseUserPreferences(JSON.stringify(value));
  } catch {
    return null;
  }
}

function parseWorkspaceSessionImport(value: unknown): WorkspaceSessionState | null {
  if (!value || typeof value !== "object") {
    return null;
  }
  const r = value as Partial<WorkspaceSessionState>;
  if (r.schemaVersion !== 1) {
    return null;
  }
  return value as WorkspaceSessionState;
}

export function buildSettingsExportBundle(options: {
  selection: SettingsExportGranularity;
  theme: ThemePreference;
  userPreferences: UserPreferences;
  globalSettings: GlobalSettingsState;
  workspaceSession: WorkspaceSessionState;
}): SettingsExportBundleV1 {
  const exportedAt = new Date().toISOString();
  const bundle: SettingsExportBundleV1 = {
    schemaVersion: SETTINGS_EXPORT_SCHEMA_VERSION,
    exportedAt,
  };
  const { selection } = options;
  if (selection.theme) {
    bundle.theme = options.theme;
  }
  if (selection.userPreferences) {
    bundle.userPreferences = options.userPreferences;
  }
  if (selection.keyboardShortcuts) {
    bundle.keyboardShortcuts = options.globalSettings.keyboardShortcuts;
  }
  if (selection.globalApp) {
    bundle.globalApp = sliceGlobalAppFromSettings(options.globalSettings);
  }
  if (selection.workspaceSession) {
    bundle.workspaceSession = options.workspaceSession;
  }
  return bundle;
}

export function parseSettingsImportBundle(raw: unknown): SettingsExportBundleV1 | null {
  if (!raw || typeof raw !== "object") {
    return null;
  }
  const r = raw as Record<string, unknown>;
  if (r.schemaVersion !== SETTINGS_EXPORT_SCHEMA_VERSION) {
    return null;
  }
  const exportedAt =
    typeof r.exportedAt === "string" ? r.exportedAt : new Date().toISOString();
  const out: SettingsExportBundleV1 = {
    schemaVersion: SETTINGS_EXPORT_SCHEMA_VERSION,
    exportedAt,
  };

  if ("theme" in r && isThemePreference(r.theme)) {
    out.theme = r.theme;
  }
  if (r.userPreferences != null && typeof r.userPreferences === "object") {
    const parsedPrefs = parseUserPreferencesFromExport(r.userPreferences);
    if (parsedPrefs) {
      out.userPreferences = parsedPrefs;
    }
  }
  if (r.keyboardShortcuts != null) {
    out.keyboardShortcuts = normalizeKeyboardShortcutsState(r.keyboardShortcuts);
  }
  if (r.globalApp != null && typeof r.globalApp === "object") {
    out.globalApp = r.globalApp as GlobalAppSettingsSlice;
  }
  const ws = parseWorkspaceSessionImport(r.workspaceSession);
  if (ws) {
    out.workspaceSession = ws;
  }
  return out;
}

export function stripBundleBySelection(
  bundle: SettingsExportBundleV1,
  selection: SettingsExportGranularity
): SettingsExportBundleV1 {
  const exportedAt = bundle.exportedAt;
  const next: SettingsExportBundleV1 = {
    schemaVersion: SETTINGS_EXPORT_SCHEMA_VERSION,
    exportedAt,
  };
  if (selection.theme && bundle.theme != null) {
    next.theme = bundle.theme;
  }
  if (selection.userPreferences && bundle.userPreferences != null) {
    next.userPreferences = bundle.userPreferences;
  }
  if (selection.keyboardShortcuts && bundle.keyboardShortcuts != null) {
    next.keyboardShortcuts = bundle.keyboardShortcuts;
  }
  if (selection.globalApp && bundle.globalApp != null) {
    next.globalApp = bundle.globalApp;
  }
  if (selection.workspaceSession && bundle.workspaceSession != null) {
    next.workspaceSession = bundle.workspaceSession;
  }
  return next;
}

/** Accept theme strings from localStorage or export file. */
export function parseImportedThemePreference(raw: unknown): ThemePreference | null {
  if (typeof raw === "string") {
    return parseThemePreference(raw);
  }
  if (isThemePreference(raw)) {
    return raw;
  }
  return null;
}
