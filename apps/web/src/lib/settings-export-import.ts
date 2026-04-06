import type { GlobalAppSettingsSlice, GlobalSettingsState } from "@/lib/global-settings";
import {
  normalizeKeyboardShortcutsState,
  type KeyboardShortcutsSettingsState,
} from "@/lib/keyboard-shortcuts";
import { parseUserPreferences, type UserPreferences } from "@/lib/preferences";
import {
  normalizeThemeConfig,
  type ThemeConfig,
} from "@/lib/theme-config";
import { parseThemePreference, type ThemePreference } from "@/lib/theme";
import type { WorkspaceSessionState } from "@/lib/workspace-session";

/** Legacy export bundles (appearance string only). */
export const SETTINGS_EXPORT_SCHEMA_V1 = 1 as const;
/** Full theme config (appearance + per-mode themes + custom themes). */
export const SETTINGS_EXPORT_SCHEMA_V2 = 2 as const;

export type SettingsExportGranularity = {
  theme: boolean;
  userPreferences: boolean;
  keyboardShortcuts: boolean;
  globalApp: boolean;
  workspaceSession: boolean;
};

export type SettingsExportBundle = {
  schemaVersion: typeof SETTINGS_EXPORT_SCHEMA_V1 | typeof SETTINGS_EXPORT_SCHEMA_V2;
  exportedAt: string;
  /** Appearance mode; v1 primary; v2 duplicate of `themeConfig.appearance` when present. */
  theme?: ThemePreference;
  /** v2+ full theming state. */
  themeConfig?: ThemeConfig;
  userPreferences?: UserPreferences;
  keyboardShortcuts?: KeyboardShortcutsSettingsState;
  globalApp?: GlobalAppSettingsSlice;
  workspaceSession?: WorkspaceSessionState;
};

/** @deprecated Use `SettingsExportBundle`. */
export type SettingsExportBundleV1 = SettingsExportBundle;

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

function parseThemeConfigImport(value: unknown): ThemeConfig | null {
  if (!value || typeof value !== "object") {
    return null;
  }
  return normalizeThemeConfig(value);
}

export function buildSettingsExportBundle(options: {
  selection: SettingsExportGranularity;
  themeConfig: ThemeConfig;
  userPreferences: UserPreferences;
  globalSettings: GlobalSettingsState;
  workspaceSession: WorkspaceSessionState;
}): SettingsExportBundle {
  const exportedAt = new Date().toISOString();
  const bundle: SettingsExportBundle = {
    schemaVersion: SETTINGS_EXPORT_SCHEMA_V2,
    exportedAt,
  };
  const { selection } = options;
  if (selection.theme) {
    bundle.theme = options.themeConfig.appearance;
    bundle.themeConfig = options.themeConfig;
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

export function parseSettingsImportBundle(raw: unknown): SettingsExportBundle | null {
  if (!raw || typeof raw !== "object") {
    return null;
  }
  const r = raw as Record<string, unknown>;
  const sv = r.schemaVersion;
  if (sv !== SETTINGS_EXPORT_SCHEMA_V1 && sv !== SETTINGS_EXPORT_SCHEMA_V2) {
    return null;
  }
  const exportedAt =
    typeof r.exportedAt === "string" ? r.exportedAt : new Date().toISOString();
  const out: SettingsExportBundle = {
    schemaVersion: sv as typeof SETTINGS_EXPORT_SCHEMA_V1 | typeof SETTINGS_EXPORT_SCHEMA_V2,
    exportedAt,
  };

  if ("theme" in r && isThemePreference(r.theme)) {
    out.theme = r.theme;
  }
  const tc = parseThemeConfigImport(r.themeConfig);
  if (tc) {
    out.themeConfig = tc;
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
  bundle: SettingsExportBundle,
  selection: SettingsExportGranularity
): SettingsExportBundle {
  const exportedAt = bundle.exportedAt;
  const next: SettingsExportBundle = {
    schemaVersion: bundle.schemaVersion,
    exportedAt,
  };
  if (selection.theme) {
    if (bundle.themeConfig != null) {
      next.themeConfig = bundle.themeConfig;
    }
    if (bundle.theme != null) {
      next.theme = bundle.theme;
    }
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
