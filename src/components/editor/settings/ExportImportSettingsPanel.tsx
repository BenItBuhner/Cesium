"use client";

import { useCallback, useState } from "react";
import { Download } from "lucide-react";
import { useGlobalSettings } from "@/components/preferences/GlobalSettingsProvider";
import { useUserPreferences } from "@/components/preferences/UserPreferencesProvider";
import { useTheme } from "@/components/theme/ThemeProvider";
import { useWorkspace } from "@/contexts/WorkspaceContext";
import {
  buildSettingsExportBundle,
  mergeImportedGlobalAppSlice,
  parseImportedThemePreference,
  parseSettingsImportBundle,
  stripBundleBySelection,
  type SettingsExportBundle,
  type SettingsExportGranularity,
} from "@/lib/settings-export-import";
import {
  createPersistableWorkspaceSession,
  mergeWorkspaceSessionFromImport,
} from "@/lib/workspace-session";
import {
  PageIntro,
  SettingsBlock,
  SettingsCallout,
  SettingsSection,
  rowButtonClass,
} from "@/components/editor/settings-ui";

const EXPORT_DEFAULT_SELECTION: SettingsExportGranularity = {
  theme: true,
  userPreferences: true,
  keyboardShortcuts: true,
  globalApp: true,
  workspaceSession: false,
};

/** Search scroll ids for the export picker rows (matches the settings search index). */
const EXPORT_ROW_SEARCH_IDS: Record<keyof SettingsExportGranularity, string> = {
  theme: "theme-export",
  userPreferences: "prefs-export",
  keyboardShortcuts: "shortcuts-export",
  globalApp: "app-export",
  workspaceSession: "session-export",
};

function ExportGranularityPicker({
  value,
  onChange,
  presence,
  exposeSearchIds = false,
}: {
  value: SettingsExportGranularity;
  onChange: (next: SettingsExportGranularity) => void;
  /** When set, disable checkboxes for sections not in the file (import mode). */
  presence?: SettingsExportGranularity | null;
  /** Expose per-row `data-settings-search-id`s (export picker only, to keep ids unique). */
  exposeSearchIds?: boolean;
}) {
  const row = (
    key: keyof SettingsExportGranularity,
    label: string,
    hint?: string
  ) => {
    const available = presence ? presence[key] : true;
    return (
      <label
        data-settings-search-id={exposeSearchIds ? EXPORT_ROW_SEARCH_IDS[key] : undefined}
        className={`flex items-start gap-[10px] font-sans text-[13px] ${
          available ? "cursor-pointer text-[var(--text-primary)]" : "text-[var(--text-disabled)]"
        }`}
      >
        <input
          type="checkbox"
          className="mt-[3px] size-[14px] shrink-0"
          checked={value[key]}
          disabled={!available}
          onChange={(e) => onChange({ ...value, [key]: e.target.checked })}
        />
        <span>
          {label}
          {hint ? (
            <span className="mt-[2px] block font-sans text-[11px] text-[var(--text-secondary)]">
              {hint}
            </span>
          ) : null}
        </span>
      </label>
    );
  };

  return (
    <div className="flex flex-col gap-[10px]">
      {row(
        "theme",
        "Theming",
        "Appearance mode, per-light/dark themes, and custom presets (server sync + local cache)."
      )}
      {row("userPreferences", "Local preferences", "iPad experimental toggles and related UI flags.")}
      {row(
        "keyboardShortcuts",
        "Keyboard shortcuts",
        "Custom bindings stored with global workspace settings."
      )}
      {row(
        "globalApp",
        "App settings",
        "General, agents, and models (synced via the settings API)."
      )}
      {row(
        "workspaceSession",
        "Workspace layout session",
        "Open tabs, chat, sidebar layout for this workspace (can be large)."
      )}
    </div>
  );
}

export function ExportImportSettingsPanel() {
  const { themeConfig, setPreference, setThemeConfig } = useTheme();
  const { preferences, importUserPreferences } = useUserPreferences();
  const { settings, updateSettings } = useGlobalSettings();
  const { workspaceSession, updateWorkspaceSession } = useWorkspace();
  const [exportSelection, setExportSelection] = useState<SettingsExportGranularity>({
    ...EXPORT_DEFAULT_SELECTION,
  });
  const [importBundle, setImportBundle] = useState<SettingsExportBundle | null>(null);
  const [importSelection, setImportSelection] =
    useState<SettingsExportGranularity | null>(null);
  const [importPresence, setImportPresence] = useState<SettingsExportGranularity | null>(
    null
  );
  const [importError, setImportError] = useState<string | null>(null);

  const runExport = useCallback(() => {
    const persistable = createPersistableWorkspaceSession(workspaceSession);
    const bundle = buildSettingsExportBundle({
      selection: exportSelection,
      themeConfig,
      userPreferences: preferences,
      globalSettings: settings,
      workspaceSession: persistable,
    });
    const blob = new Blob([JSON.stringify(bundle, null, 2)], {
      type: "application/json",
    });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `cesium-settings-${new Date().toISOString().slice(0, 10)}.json`;
    a.click();
    URL.revokeObjectURL(url);
  }, [exportSelection, themeConfig, preferences, settings, workspaceSession]);

  const onImportFileChange = useCallback((fileList: FileList | null) => {
    const file = fileList?.[0] ?? null;
    setImportError(null);
    setImportBundle(null);
    setImportSelection(null);
    setImportPresence(null);
    if (!file) {
      return;
    }
    void file.text().then((text) => {
      try {
        const raw: unknown = JSON.parse(text);
        const parsed = parseSettingsImportBundle(raw);
        if (!parsed) {
          setImportError(
            "Not a valid Cesium settings export (need schemaVersion 1 or 2)."
          );
          return;
        }
        setImportBundle(parsed);
        const presence: SettingsExportGranularity = {
          theme: parsed.theme != null || parsed.themeConfig != null,
          userPreferences: parsed.userPreferences != null,
          keyboardShortcuts: parsed.keyboardShortcuts != null,
          globalApp: parsed.globalApp != null,
          workspaceSession: parsed.workspaceSession != null,
        };
        setImportPresence(presence);
        setImportSelection({
          theme: presence.theme,
          userPreferences: presence.userPreferences,
          keyboardShortcuts: presence.keyboardShortcuts,
          globalApp: presence.globalApp,
          workspaceSession: presence.workspaceSession,
        });
      } catch {
        setImportError("Could not parse JSON.");
      }
    });
  }, []);

  const runApplyImport = useCallback(() => {
    if (!importBundle || !importSelection) {
      return;
    }
    const slice = stripBundleBySelection(importBundle, importSelection);
    if (slice.themeConfig != null) {
      setThemeConfig(slice.themeConfig);
    } else if (slice.theme != null) {
      const t = parseImportedThemePreference(slice.theme);
      if (t) {
        setPreference(t);
      }
    }
    if (slice.userPreferences != null) {
      importUserPreferences(slice.userPreferences);
    }
    if (slice.keyboardShortcuts != null || slice.globalApp != null) {
      updateSettings((c) => {
        let next = c;
        if (slice.keyboardShortcuts != null) {
          next = { ...next, keyboardShortcuts: slice.keyboardShortcuts };
        }
        if (slice.globalApp != null) {
          next = mergeImportedGlobalAppSlice(next, slice.globalApp);
        }
        return next;
      });
    }
    if (slice.workspaceSession != null) {
      updateWorkspaceSession((c) =>
        mergeWorkspaceSessionFromImport(c, slice.workspaceSession!)
      );
    }
    setImportBundle(null);
    setImportSelection(null);
    setImportPresence(null);
    setImportError(null);
  }, [
    importBundle,
    importSelection,
    importUserPreferences,
    setPreference,
    setThemeConfig,
    updateSettings,
    updateWorkspaceSession,
  ]);

  return (
    <>
      <PageIntro title="Import & export" />
      <SettingsSection title="Export">
        <SettingsBlock className="space-y-[14px]">
          <ExportGranularityPicker
            value={exportSelection}
            onChange={setExportSelection}
            exposeSearchIds
          />
          <button
            type="button"
            className={`inline-flex items-center gap-[8px] ${rowButtonClass}`}
            onClick={runExport}
          >
            <Download className="size-[14px]" strokeWidth={1.5} aria-hidden />
            Download JSON
          </button>
        </SettingsBlock>
      </SettingsSection>
      <SettingsSection title="Import">
        <SettingsBlock className="space-y-[14px]">
          <label className="block font-sans text-[12px] text-[var(--text-secondary)]">
            <span className="mb-[6px] block">Choose a previously exported file</span>
            <input
              type="file"
              accept="application/json,.json"
              className="max-w-full font-sans text-[12px] text-[var(--text-primary)]"
              onChange={(e) => onImportFileChange(e.target.files)}
            />
          </label>
          {importError ? <SettingsCallout tone="danger">{importError}</SettingsCallout> : null}
          {importBundle && importSelection ? (
            <>
              <p className="font-sans text-[12px] text-[var(--text-secondary)]">
                Exported {importBundle.exportedAt}. Choose which sections to apply:
              </p>
              <ExportGranularityPicker
                value={importSelection}
                onChange={setImportSelection}
                presence={importPresence}
              />
              <button
                type="button"
                className={rowButtonClass}
                onClick={runApplyImport}
              >
                Apply import
              </button>
            </>
          ) : null}
        </SettingsBlock>
      </SettingsSection>
    </>
  );
}
