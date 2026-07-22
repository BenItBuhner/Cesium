"use client";

import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ChangeEvent,
  type ComponentType,
  type ReactNode,
} from "react";
import { createPortal } from "react-dom";
import {
  AlertTriangle,
  Check,
  ChevronDown,
  ChevronRight,
  Database,
  Download,
  RefreshCw,
  Search,
  Upload,
} from "lucide-react";
import { VerticalFadedScroll } from "@/components/chat/VerticalFadedScroll";
import { HardwareAwareTextInput } from "@/components/input/HardwareAwareTextField";
import { DefaultServerSettingsBanner } from "@/components/preferences/DefaultServerSettingsBanner";
import { useGlobalSettings } from "@/components/preferences/GlobalSettingsProvider";
import { ServerConnectionsManager } from "@/components/preferences/ServerConnectionsManager";
import { useServerConnections } from "@/components/preferences/ServerConnectionsProvider";
import { useUserPreferences } from "@/components/preferences/UserPreferencesProvider";
import { useCesiumRendererFeatureFlags } from "@/lib/desktop-environment";
import { useTheme } from "@/components/theme/ThemeProvider";
import {
  serverHealthColorClass,
  serverHealthIndicator,
} from "@/lib/server-health-display";
import {
  TOOL_CALL_DROPDOWN_MAX_HEIGHT_MAX_PX,
  TOOL_CALL_DROPDOWN_MAX_HEIGHT_MIN_PX,
  type CustomThemeEntry,
} from "@/lib/theme-config";
import { DEFAULT_BUILTIN_THEME_ID, BUILTIN_THEME_CATALOG } from "@/lib/theme-presets";
import { McpServersSettingsPanel } from "./mcp-servers-settings";
import { CloudAgentsSettingsPanel } from "./cloud-agents-settings";
import type { ThemePreference } from "@/lib/theme";
import {
  THEME_TOKEN_GROUPS,
  sanitizeThemeTokensPartial,
  type ThemeTokenKey,
} from "@/lib/theme-tokens";
import { useWorkspace } from "@/contexts/WorkspaceContext";
import {
  buildStorageExportUrl,
  createCustomAgentPlugin,
  discoverAgentPlugins,
  fetchAgentPluginHarnessCapabilities,
  fetchAgentPlugins,
  fetchStorageStatus,
  importStorageArchive,
  runStorageMigration,
  installAgentPlugin,
  setAgentPluginEnabled,
  setAgentPluginHarnessOverride,
  verifyAgentPlugins,
  type StorageDriverKind,
  type StorageMigrationPhase,
  type StorageMigrationProgress,
  type StorageMigrationResult,
  type StorageStatusResponse,
} from "@/lib/server-api";
import type {
  AgentPluginDefinition,
  AgentPluginDiscoveryResult,
  AgentPluginHarnessCapability,
  AgentPluginPublic,
  AgentPluginVerificationReport,
} from "@/lib/plugin-types";
import {
  DEFAULT_KEYBOARD_SHORTCUT_BINDINGS,
  detectShortcutPlatform,
  formatShortcutBinding,
  formatShortcutBindingsForInput,
  normalizeKeyForCapture,
  SHORTCUT_COMMAND_DEFINITIONS,
  type ShortcutCommandSection,
  type ShortcutPlatform,
  type VoiceInputMode,
} from "@/lib/keyboard-shortcuts";
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
  AgentsHarnessSettingsPanel,
  HARNESS_LABELS,
  HARNESS_ORDER,
} from "@/components/editor/agent-harness-settings";
import { VscodeExtensionsSettingsPanel } from "@/components/editor/vscode-extensions-settings";
import {
  PageIntro,
  SettingsBreadcrumbs,
  SettingsPxRangeControl,
  SettingsRadioList,
  SettingsRow,
  SettingsSection,
  rowButtonClass,
} from "@/components/editor/settings-ui";
import { SettingsThemeSelect } from "@/components/editor/SettingsThemeSelect";
import { ToggleSwitch } from "@/components/ui/ToggleSwitch";
import { AgentBackendIcon } from "@/components/chat/AgentBackendIcon";
import type { AgentBackendId } from "@/lib/agent-types";
import type { ModelToggleState } from "@/lib/global-settings";
import { recordPerfSample } from "@/lib/dev-perf";

export { rowButtonClass, SettingsPxRangeControl, SettingsRow, SettingsSection };

const selectClass =
  "inline-flex min-w-[160px] max-w-[240px] shrink-0 items-center justify-between gap-[8px] rounded-[var(--radius-tab)] border border-[var(--border-card)] bg-[var(--bg-main)] px-[10px] py-[6px] font-sans text-[12px] text-[var(--text-primary)] transition-colors hover:bg-[var(--accent-bg)]";

const shortcutInputClass =
  "box-border min-w-[200px] max-w-[min(100%,380px)] rounded-[var(--radius-tab)] border border-[var(--border-card)] bg-[var(--bg-main)] px-[10px] py-[6px] font-mono text-[11px] text-[var(--text-primary)] outline-none placeholder:text-[var(--text-disabled)]";

/** Shared height for Custom theme row (name input, duplicate select, Create). */
const CUSTOM_THEME_ROW_CONTROL_MIN_H = "min-h-[38px]";

const SECTION_ORDER: ShortcutCommandSection[] = [
  "Workbench",
  "Chat",
  "File",
  "Editor",
  "Edit",
  "Search",
  "Terminal",
  "Window",
  "Developer",
];

type CompactModelToggleRow = {
  id: string;
  name: string;
  on: boolean;
  modelIds: string[];
};

const CURSOR_SDK_VARIANT_TOKENS = new Set([
  "auto",
  "default",
  "extra",
  "fast",
  "high",
  "large",
  "long",
  "low",
  "max",
  "medium",
  "normal",
  "short",
  "standard",
  "true",
  "false",
]);

function stripCursorSdkModelParams(value: string): string {
  return value.replace(/\[[^\]]+\]$/g, "").trim();
}

function normalizeModelVariantToken(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/[_-]+/g, " ")
    .replace(/\s+/g, " ");
}

function consumeSettingsModelVariantToken(words: string[]): boolean {
  const last = words.at(-1);
  if (!last) return false;
  const normalizedLast = normalizeModelVariantToken(last);
  if (normalizedLast === "true" || normalizedLast === "fast") {
    words.pop();
    return true;
  }
  if (normalizedLast === "false") {
    words.pop();
    if (normalizeModelVariantToken(words.at(-1) ?? "") === "fast") {
      words.pop();
    }
    return true;
  }
  if (/^\d+\s*[km]$/i.test(last)) {
    words.pop();
    return true;
  }
  const prev = normalizeModelVariantToken(words.at(-2) ?? "");
  if (prev === "extra" && normalizedLast === "high") {
    words.pop();
    words.pop();
    return true;
  }
  if (CURSOR_SDK_VARIANT_TOKENS.has(normalizedLast)) {
    words.pop();
    return true;
  }
  return false;
}

function compactModelName(name: string, fallbackId: string): string {
  const base = (name.trim() || fallbackId.trim() || "Model")
    .replace(/\s*\([^)]*\)\s*$/g, "")
    .trim();
  const parts = base.split(/\s+/);
  while (parts.length > 1 && consumeSettingsModelVariantToken(parts)) {}
  return parts.join(" ") || base || fallbackId || "Model";
}

function compactModelRowsForBackend(
  backendId: string,
  models: ModelToggleState[]
): CompactModelToggleRow[] {
  const groups = new Map<string, CompactModelToggleRow>();
  for (const model of models) {
    const baseId = stripCursorSdkModelParams(model.id);
    const baseName = compactModelName(model.name, baseId);
    const key = baseName.toLowerCase();
    const existing = groups.get(key);
    if (existing) {
      existing.on = existing.on || model.on;
      existing.modelIds.push(model.id);
      continue;
    }
    groups.set(key, {
      id: key,
      name: baseName,
      on: model.on,
      modelIds: [model.id],
    });
  }
  return [...groups.values()].sort((a, b) => a.name.localeCompare(b.name));
}

function SubsectionLabel({ children }: { children: ReactNode }) {
  return (
    <div className="border-b border-[var(--border-subtle)] bg-[var(--bg-main)] px-[16px] py-[8px]">
      <p className="font-sans text-[11px] font-medium uppercase tracking-wide text-[var(--text-disabled)]">
        {children}
      </p>
    </div>
  );
}

/* ——— Panels ——— */

export function GeneralSettingsPanel() {
  const { settings, updateSettings } = useGlobalSettings();
  const { updateWorkspaceSession } = useWorkspace();
  const general = settings.general;

  const patchGeneral = (patch: Partial<typeof general>) => {
    updateSettings((current) => ({
      ...current,
      general: {
        ...current.general,
        ...patch,
      },
    }));
  };

  return (
    <>
      <PageIntro title="General" />
      <SettingsSection title="Preferences">
        <SettingsRow
          title="Appearance & themes"
          description="System, light, or dark mode; per-appearance themes; custom token presets."
          trailing={
            <button
              type="button"
              className={rowButtonClass}
              onClick={() =>
                updateWorkspaceSession((current) => ({
                  ...current,
                  settingsView: {
                    ...current.settingsView,
                    activeNav: "appearance",
                  },
                }))
              }
            >
              Open
            </button>
          }
        />
        <SettingsRow
          title="Keyboard Shortcuts"
          description="Customize keyboard shortcuts for commands and workflows."
          trailing={
            <button
              type="button"
              className={rowButtonClass}
              onClick={() =>
                updateWorkspaceSession((current) => ({
                  ...current,
                  settingsView: {
                    ...current.settingsView,
                    activeNav: "keyboardShortcuts",
                  },
                }))
              }
            >
              Open
            </button>
          }
        />
        <SettingsRow
          title="Import & export settings"
          description="Back up or restore theme, shortcuts, workspace app settings, and more as JSON."
          trailing={
            <button
              type="button"
              className={rowButtonClass}
              onClick={() =>
                updateWorkspaceSession((current) => ({
                  ...current,
                  settingsView: {
                    ...current.settingsView,
                    activeNav: "exportImport",
                  },
                }))
              }
            >
              Open
            </button>
          }
          border={false}
        />
      </SettingsSection>
      <SettingsSection title="Notifications">
        <SettingsRow
          searchId="do-not-disturb"
          title="Do Not Disturb"
          description="Suppress all notifications — connection alerts, warnings, file overrides, and every other notification type."
          trailing={
            <ToggleSwitch
              checked={general.doNotDisturb}
              onChange={(value) => patchGeneral({ doNotDisturb: value })}
              size="md"
            />
          }
          border={false}
        />
      </SettingsSection>
    </>
  );
}

const APPEARANCE_MODE_OPTIONS: Array<{ value: ThemePreference; label: string }> = [
  { value: "system", label: "System" },
  { value: "light", label: "Light" },
  { value: "dark", label: "Dark" },
];

export function AppearanceSettingsPanel() {
  const { settings, updateSettings } = useGlobalSettings();
  const {
    themeConfig,
    setPreference,
    setLightThemeId,
    setDarkThemeId,
    setThemeConfig,
    upsertCustomTheme,
    removeCustomTheme,
    duplicateCustomTheme,
  } = useTheme();

  const themeOptions = useMemo(() => {
    const builtins = Object.entries(BUILTIN_THEME_CATALOG).map(([id, p]) => ({
      id,
      label: p.label,
    }));
    const customs = themeConfig.customThemes.map((t) => ({
      id: t.id,
      label: `${t.label} (custom)`,
    }));
    return [...builtins, ...customs];
  }, [themeConfig.customThemes]);

  const [newThemeName, setNewThemeName] = useState("");
  const [duplicateSourceId, setDuplicateSourceId] = useState<string>(DEFAULT_BUILTIN_THEME_ID);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [draft, setDraft] = useState<CustomThemeEntry | null>(null);
  const sideColumnsSwapped = settings.general.sideColumnsSwapped;

  useEffect(() => {
    if (!editingId) {
      setDraft(null);
      return;
    }
    const entry = themeConfig.customThemes.find((t) => t.id === editingId);
    if (entry) {
      setDraft({
        ...entry,
        light: { ...entry.light },
        dark: { ...entry.dark },
      });
    }
  }, [editingId, themeConfig.customThemes]);

  const saveDraft = () => {
    if (!draft) return;
    upsertCustomTheme({
      ...draft,
      light: sanitizeThemeTokensPartial(draft.light),
      dark: sanitizeThemeTokensPartial(draft.dark),
    });
    setEditingId(null);
    setDraft(null);
  };

  const allDuplicateSources = useMemo(() => {
    const builtins = Object.keys(BUILTIN_THEME_CATALOG);
    const customs = themeConfig.customThemes.map((t) => t.id);
    return [...builtins, ...customs];
  }, [themeConfig.customThemes]);

  const duplicateSelectOptions = useMemo(
    () =>
      allDuplicateSources.map((id) => ({
        value: id,
        label:
          BUILTIN_THEME_CATALOG[id]?.label ??
          themeConfig.customThemes.find((t) => t.id === id)?.label ??
          id,
      })),
    [allDuplicateSources, themeConfig.customThemes]
  );

  const themeSelectOptions = useMemo(
    () => themeOptions.map((o) => ({ value: o.id, label: o.label })),
    [themeOptions]
  );

  return (
    <>
      <PageIntro title="Appearance" />
      <SettingsSection title="Appearance mode" bordered={false}>
        <SettingsRadioList
          aria-label="Appearance mode"
          value={themeConfig.appearance}
          onChange={setPreference}
          options={APPEARANCE_MODE_OPTIONS}
        />
      </SettingsSection>
      <SettingsSection title="Layout">
        <SettingsRow
          title="Swap side columns"
          description="Move the agent/chat pane to the left and the file sidebar to the right while keeping the editor centered."
          trailing={
            <ToggleSwitch
              checked={sideColumnsSwapped}
              onChange={(value) =>
                updateSettings((current) => ({
                  ...current,
                  general: {
                    ...current.general,
                    sideColumnsSwapped: value,
                  },
                }))
              }
              size="md"
            />
          }
        />
        <SettingsRow
          title="Floating sidebar reveal"
          description="On tablet and desktop, show the floating control over the editor on the current sidebar side when the file sidebar is collapsed. You can always toggle the sidebar with the keyboard shortcut or command palette when this is off."
          trailing={
            <ToggleSwitch
              checked={themeConfig.showFloatingSidebarReveal}
              onChange={(value) =>
                setThemeConfig({ ...themeConfig, showFloatingSidebarReveal: value })
              }
              size="md"
            />
          }
        />
      </SettingsSection>
      <SettingsSection title="Design">
        <SettingsRow
          searchId="long-paste-references"
          title="Long paste references"
          description="Collapse text pasted into the chat composer as a compact reference when it is about 10K characters or longer."
          trailing={
            <ToggleSwitch
              checked={themeConfig.longPasteReferencesEnabled}
              onChange={(value) =>
                setThemeConfig({
                  ...themeConfig,
                  longPasteReferencesEnabled: value,
                })
              }
              size="md"
            />
          }
        />
        <SettingsRow
          title="Minimal edit diff"
          description="Show file edits as a single line with added and removed line counts instead of the full inline diff."
          trailing={
            <ToggleSwitch
              checked={themeConfig.editDiffRenderingMode === "counts"}
              onChange={(value) =>
                setThemeConfig({
                  ...themeConfig,
                  editDiffRenderingMode: value ? "counts" : "full",
                })
              }
              size="md"
            />
          }
          border={false}
        />
      </SettingsSection>
      <SettingsSection title="Chat">
        <div
          data-settings-search-id="tool-call-dropdown-height"
          className="border-b border-[var(--border-subtle)] px-[16px] py-[14px] last:border-b-0"
        >
          <p className="font-sans text-[13px] font-medium text-[var(--text-primary)]">
            Tool call dropdown height
          </p>
          <p className="mt-[4px] font-sans text-[12px] leading-snug text-[var(--text-secondary)]">
            Maximum height of expanded agent tool-call blocks in chat (for example &quot;Read 1
            file, called MCP tool&quot;). Content scrolls inside the limit.
          </p>
          <SettingsPxRangeControl
            className="mt-[12px]"
            ariaLabel="Tool call dropdown max height"
            min={TOOL_CALL_DROPDOWN_MAX_HEIGHT_MIN_PX}
            max={TOOL_CALL_DROPDOWN_MAX_HEIGHT_MAX_PX}
            value={themeConfig.toolCallDropdownMaxHeightPx}
            onChange={(toolCallDropdownMaxHeightPx) =>
              setThemeConfig({ ...themeConfig, toolCallDropdownMaxHeightPx })
            }
          />
        </div>
      </SettingsSection>
      <SettingsSection title="Light theme">
        <div className="border-b border-[var(--border-subtle)] px-[16px] py-[14px] last:border-b-0">
          <p className="mb-[10px] font-sans text-[12px] text-[var(--text-secondary)]">
            Applied when the UI resolves to light (including under &quot;Light&quot; mode or system light).
          </p>
          <SettingsThemeSelect
            className="w-full max-w-[min(100%,400px)]"
            triggerClassName={`${selectClass} w-full min-w-0 max-w-[min(100%,400px)]`}
            value={themeConfig.lightThemeId}
            options={themeSelectOptions}
            onChange={setLightThemeId}
            ariaLabel="Light appearance theme"
            placement="below"
          />
        </div>
      </SettingsSection>
      <SettingsSection title="Dark theme">
        <div className="border-b border-[var(--border-subtle)] px-[16px] py-[14px] last:border-b-0">
          <p className="mb-[10px] font-sans text-[12px] text-[var(--text-secondary)]">
            Applied when the UI resolves to dark (including under &quot;Dark&quot; mode or system dark).
          </p>
          <SettingsThemeSelect
            className="w-full max-w-[min(100%,400px)]"
            triggerClassName={`${selectClass} w-full min-w-0 max-w-[min(100%,400px)]`}
            value={themeConfig.darkThemeId}
            options={themeSelectOptions}
            onChange={setDarkThemeId}
            ariaLabel="Dark appearance theme"
            placement="below"
          />
        </div>
      </SettingsSection>
      <SettingsSection title="Custom themes">
        <div className="space-y-[12px] border-b border-[var(--border-subtle)] px-[16px] py-[14px] last:border-b-0">
          <p className="font-sans text-[12px] text-[var(--text-secondary)]">
            Duplicate a built-in preset or another custom theme, then edit CSS variable values (empty =
            use built-in default for that branch).
          </p>
          <div className="flex flex-wrap items-end gap-[10px]">
            <label className="flex min-w-[160px] flex-1 flex-col gap-[4px] font-sans text-[11px] text-[var(--text-secondary)]">
              Name
              <HardwareAwareTextInput
                value={newThemeName}
                onChange={setNewThemeName}
                className={`${shortcutInputClass} ${CUSTOM_THEME_ROW_CONTROL_MIN_H} flex items-center`}
                ariaLabel="New custom theme name"
              />
            </label>
            <label className="flex min-w-[160px] flex-1 flex-col gap-[4px] font-sans text-[11px] text-[var(--text-secondary)]">
              Duplicate from
              <SettingsThemeSelect
                className="w-full"
                triggerClassName={`${selectClass} ${CUSTOM_THEME_ROW_CONTROL_MIN_H} w-full min-w-0 max-w-none`}
                value={duplicateSourceId}
                options={duplicateSelectOptions}
                onChange={setDuplicateSourceId}
                ariaLabel="Duplicate theme from preset"
                placement="below"
              />
            </label>
            <button
              type="button"
              className={`${rowButtonClass} ${CUSTOM_THEME_ROW_CONTROL_MIN_H}`}
              onClick={() => {
                const id = duplicateCustomTheme(duplicateSourceId, newThemeName || "Custom theme");
                if (id) {
                  setNewThemeName("");
                  setEditingId(id);
                }
              }}
            >
              Create
            </button>
          </div>
          {themeConfig.customThemes.length ? (
            <ul className="divide-y divide-[var(--border-subtle)] rounded-[var(--radius-tab)] border border-[var(--border-card)]">
              {themeConfig.customThemes.map((t) => (
                <li
                  key={t.id}
                  className="flex flex-wrap items-center justify-between gap-[8px] px-[12px] py-[10px]"
                >
                  <span className="font-sans text-[13px] text-[var(--text-primary)]">{t.label}</span>
                  <div className="flex flex-wrap gap-[8px]">
                    <button
                      type="button"
                      className={rowButtonClass}
                      onClick={() => setEditingId(t.id)}
                    >
                      Edit
                    </button>
                    <button
                      type="button"
                      className={rowButtonClass}
                      onClick={() => removeCustomTheme(t.id)}
                    >
                      Delete
                    </button>
                  </div>
                </li>
              ))}
            </ul>
          ) : (
            <p className="font-sans text-[12px] text-[var(--text-disabled)]">No custom themes yet.</p>
          )}
        </div>
      </SettingsSection>
      {draft && editingId ? (
        <SettingsSection title={`Edit: ${draft.label}`}>
          <div className="space-y-[16px] border-b border-[var(--border-subtle)] px-[16px] py-[14px] last:border-b-0">
            <div className="flex flex-wrap items-center gap-[10px]">
              <label className="font-sans text-[12px] text-[var(--text-secondary)]">
                Display name
                <HardwareAwareTextInput
                  value={draft.label}
                  onChange={(v) => setDraft((d) => (d ? { ...d, label: v } : null))}
                  className={`${shortcutInputClass} mt-[4px] block w-full max-w-md`}
                  ariaLabel="Custom theme display name"
                />
              </label>
            </div>
            {(["light", "dark"] as const).map((branch) => (
              <div key={branch}>
                <SubsectionLabel>{branch === "light" ? "Light branch tokens" : "Dark branch tokens"}</SubsectionLabel>
                <div className="space-y-[12px] pt-[8px]">
                  {THEME_TOKEN_GROUPS.map((group) => (
                    <div key={group.title}>
                      <p className="mb-[6px] font-sans text-[11px] font-medium uppercase tracking-wide text-[var(--text-disabled)]">
                        {group.title}
                      </p>
                      <div className="grid gap-[8px] sm:grid-cols-2">
                        {group.keys.map((key: ThemeTokenKey) => (
                          <label
                            key={key}
                            className="flex flex-col gap-[2px] font-mono text-[10px] text-[var(--text-secondary)]"
                          >
                            {key}
                            <HardwareAwareTextInput
                              value={draft[branch][key] ?? ""}
                              onChange={(v) =>
                                setDraft((d) => {
                                  if (!d) return null;
                                  const next = { ...d[branch] };
                                  if (v.trim() === "") {
                                    delete next[key];
                                  } else {
                                    next[key] = v;
                                  }
                                  return branch === "light"
                                    ? { ...d, light: next }
                                    : { ...d, dark: next };
                                })
                              }
                              className="font-mono text-[11px]"
                              ariaLabel={`${branch} ${key}`}
                            />
                          </label>
                        ))}
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            ))}
            <div className="flex flex-wrap gap-[10px]">
              <button type="button" className={rowButtonClass} onClick={saveDraft}>
                Save theme
              </button>
              <button
                type="button"
                className={rowButtonClass}
                onClick={() => {
                  setEditingId(null);
                  setDraft(null);
                }}
              >
                Cancel
              </button>
            </div>
          </div>
        </SettingsSection>
      ) : null}
    </>
  );
}


export function AgentsSettingsPanel() {
  return <AgentsHarnessSettingsPanel />;
}

export function ModelsSettingsPanel() {
  const {
    settings,
    updateSettings,
    refreshModels,
    modelsRefreshing,
    saveModelToggleUpdates,
  } = useGlobalSettings();
  const { workspaceSession, updateWorkspaceSession } = useWorkspace();
  const [modelQuery, setModelQuery] = useState("");
  const [expandedBackends, setExpandedBackends] = useState<Set<string>>(new Set());

  useEffect(() => {
    const focus = workspaceSession.settingsView.panelSearchFocus;
    if (focus?.kind !== "models") {
      return;
    }
    setModelQuery(focus.query);
    if (focus.backendId) {
      setExpandedBackends((prev) => {
        const next = new Set(prev);
        next.add(focus.backendId!);
        return next;
      });
    }
    updateWorkspaceSession((current) => ({
      ...current,
      settingsView: {
        ...current.settingsView,
        panelSearchFocus: null,
      },
    }));
  }, [updateWorkspaceSession, workspaceSession.settingsView.panelSearchFocus]);

  const byBackend = useMemo(() => {
    const raw = settings.models.byBackend ?? {};
    const activeOnly: Record<string, ModelToggleState[]> = {};
    for (const backendId of HARNESS_ORDER) {
      const rows = raw[backendId];
      if (rows && rows.length > 0) {
        activeOnly[backendId] = rows;
      }
    }
    return activeOnly;
  }, [settings.models.byBackend]);

  const compactByBackend = useMemo(() => {
    const result: Record<string, CompactModelToggleRow[]> = {};
    for (const [backendId, models] of Object.entries(byBackend)) {
      result[backendId] = compactModelRowsForBackend(backendId, models);
    }
    return result;
  }, [byBackend]);

  const setModelsForBackend = useCallback(
    (backendId: string, updater: (current: ModelToggleState[]) => ModelToggleState[]) => {
      updateSettings((current) => ({
        ...current,
        models: {
          ...current.models,
          byBackend: {
            ...current.models.byBackend,
            [backendId]: updater(current.models.byBackend[backendId] ?? []),
          },
        },
      }));
    },
    [updateSettings]
  );

  const toggleModelGroup = useCallback(
    (backendId: string, row: CompactModelToggleRow, on: boolean) => {
      const startedAt = performance.now();
      const modelIds = new Set(row.modelIds);
      setModelsForBackend(backendId, (rows) =>
        rows.map((model) => (modelIds.has(model.id) ? { ...model, on } : model))
      );
      recordPerfSample("settings.models.toggle_visible", startedAt, {
        backendId,
        modelId: row.id,
        on,
      });
      void saveModelToggleUpdates(
        row.modelIds.map((modelId) => ({ backendId, modelId, on }))
      );
    },
    [setModelsForBackend, saveModelToggleUpdates]
  );

  const selectAllForBackend = useCallback(
    (backendId: string) => {
      const startedAt = performance.now();
      const currentModels = byBackend[backendId] ?? [];
      const updates = currentModels
        .filter((m) => !m.on)
        .map((m) => ({ backendId, modelId: m.id, on: true }));
      setModelsForBackend(backendId, (rows) => rows.map((r) => ({ ...r, on: true })));
      if (updates.length > 0) {
        void saveModelToggleUpdates(updates);
      }
      recordPerfSample("settings.models.select_all_visible", startedAt, {
        backendId,
        updates: updates.length,
      });
    },
    [byBackend, setModelsForBackend, saveModelToggleUpdates]
  );

  const deselectAllForBackend = useCallback(
    (backendId: string) => {
      const startedAt = performance.now();
      const currentModels = byBackend[backendId] ?? [];
      const updates = currentModels
        .filter((m) => m.on)
        .map((m) => ({ backendId, modelId: m.id, on: false }));
      setModelsForBackend(backendId, (rows) => rows.map((r) => ({ ...r, on: false })));
      if (updates.length > 0) {
        void saveModelToggleUpdates(updates);
      }
      recordPerfSample("settings.models.deselect_all_visible", startedAt, {
        backendId,
        updates: updates.length,
      });
    },
    [byBackend, setModelsForBackend, saveModelToggleUpdates]
  );

  const toggleCollapse = useCallback((backendId: string) => {
    const startedAt = performance.now();
    setExpandedBackends((prev) => {
      const next = new Set(prev);
      if (next.has(backendId)) {
        next.delete(backendId);
      } else {
        next.add(backendId);
      }
      recordPerfSample("settings.models.backend_toggle_visible", startedAt, {
        backendId,
        collapsed: !next.has(backendId),
      });
      return next;
    });
  }, []);

  const filteredByBackend = useMemo(() => {
    const q = modelQuery.trim().toLowerCase();
    if (!q) {
      return compactByBackend;
    }
    const result: Record<string, CompactModelToggleRow[]> = {};
    for (const [backendId, models] of Object.entries(compactByBackend)) {
      const filtered = models.filter((m) => m.name.toLowerCase().includes(q));
      if (filtered.length > 0) {
        result[backendId] = filtered;
      }
    }
    return result;
  }, [modelQuery, compactByBackend]);

  const sortedBackendIds = useMemo(() => {
    const present = new Set(Object.keys(filteredByBackend));
    return HARNESS_ORDER.filter((id) => present.has(id));
  }, [filteredByBackend]);

  return (
    <>
      <PageIntro title="Models" />
      <div className="mb-[16px] flex items-center gap-[8px]">
        <div className="relative min-w-0 flex-1">
          <HardwareAwareTextInput
            type="search"
            value={modelQuery}
            onChange={setModelQuery}
            placeholder="Search models"
            className="box-border h-[36px] w-full rounded-[var(--radius-tab)] border border-[var(--border-card)] bg-[var(--bg-panel)] pl-[10px] pr-[10px] font-sans text-[13px] text-[var(--text-primary)] outline-none placeholder:text-[var(--text-disabled)]"
            ariaLabel="Search models"
          />
        </div>
        <button
          type="button"
          onClick={() => void refreshModels()}
          disabled={modelsRefreshing}
          className="flex size-[36px] shrink-0 items-center justify-center rounded-[var(--radius-tab)] border border-[var(--border-card)] bg-[var(--bg-panel)] text-[var(--text-secondary)] transition-colors hover:bg-[var(--accent-bg)] disabled:opacity-50"
          aria-label="Refresh models"
        >
          <RefreshCw
            className={`size-[16px] ${modelsRefreshing ? "animate-spin" : ""}`}
            strokeWidth={1.5}
          />
        </button>
      </div>
      {sortedBackendIds.length === 0 ? (
        <div className="rounded-[var(--radius-card)] border border-[var(--border-card)] bg-[var(--bg-panel)] px-[16px] py-[24px] text-center font-sans text-[13px] text-[var(--text-disabled)]">
          {modelQuery ? "No models match your search" : "No models loaded yet. Click refresh to load from servers."}
        </div>
      ) : null}
      {sortedBackendIds.map((backendId) => {
        const models = filteredByBackend[backendId] ?? [];
        const allOn = models.length > 0 && models.every((m) => m.on);
        const onCountForBackend = models.filter((m) => m.on).length;
        const collapsed = !expandedBackends.has(backendId);
        return (
          <SettingsSection key={backendId}>
            <div
              className="flex min-h-[48px] cursor-pointer select-none items-center justify-between gap-[12px] px-[16px] py-[10px]"
              onClick={() => toggleCollapse(backendId)}
            >
              <div className="flex min-w-0 items-center gap-[10px]">
                <AgentBackendIcon
                  backendId={backendId as AgentBackendId}
                  className="size-[18px] shrink-0"
                  strokeWidth={1.5}
                />
                <span className="font-sans text-[13px] font-medium text-[var(--text-primary)]">
                  {HARNESS_LABELS[backendId as AgentBackendId] ?? backendId}
                </span>
                <span className="inline-flex items-center rounded-[var(--radius-tab)] bg-[var(--bg-main)] px-[6px] py-[1px] font-mono text-[11px] text-[var(--text-secondary)]">
                  {onCountForBackend}/{models.length}
                </span>
              </div>
              <div className="flex items-center gap-[8px]">
                <button
                  type="button"
                  onClick={(e) => {
                    e.stopPropagation();
                    if (allOn) {
                      deselectAllForBackend(backendId);
                    } else {
                      selectAllForBackend(backendId);
                    }
                  }}
                  className="inline-flex shrink-0 items-center gap-[4px] rounded-[var(--radius-tab)] border border-[var(--border-card)] bg-transparent px-[8px] py-[3px] font-sans text-[11px] text-[var(--text-secondary)] transition-colors hover:bg-[var(--accent-bg)] hover:text-[var(--text-primary)]"
                >
                  {allOn ? "Deselect all" : "Select all"}
                </button>
                <ChevronRight
                  className={`size-[14px] shrink-0 text-[var(--text-secondary)] transition-transform ${collapsed ? "" : "rotate-90"}`}
                  strokeWidth={1.5}
                />
              </div>
            </div>
            {collapsed ? null : (
              <div className="max-h-[min(480px,50vh)] overflow-y-auto overscroll-contain border-t border-[var(--border-subtle)]">
                {models.map((m, i) => (
                  <SettingsRow
                    key={`${backendId}::${m.id}`}
                    title={m.name}
                    trailing={
                      <ToggleSwitch
                        checked={m.on}
                        onChange={(v) => toggleModelGroup(backendId, m, v)}
                        size="sm"
                        variant="green"
                      />
                    }
                    border={i < models.length - 1}
                  />
                ))}
              </div>
            )}
          </SettingsSection>
        );
      })}
    </>
  );
}

export function RulesSkillsSubagentsPanel() {
  return (
    <>
      <PageIntro title="Rules, Skills, Subagents" />
    </>
  );
}

export function usePluginsMcpNavigation() {
  const { workspaceSession, updateWorkspaceSession } = useWorkspace();

  const mcpsOpen = workspaceSession.settingsView.mcpsOpen === true;

  const openMcpServers = useCallback(() => {
    updateWorkspaceSession((current) => ({
      ...current,
      settingsView: {
        ...current.settingsView,
        activeNav: "plugins",
        mcpsOpen: true,
      },
    }));
  }, [updateWorkspaceSession]);

  const closeMcpServers = useCallback(() => {
    updateWorkspaceSession((current) => ({
      ...current,
      settingsView: {
        ...current.settingsView,
        mcpsOpen: false,
      },
    }));
  }, [updateWorkspaceSession]);

  const openRulesSkills = useCallback(() => {
    updateWorkspaceSession((current) => ({
      ...current,
      settingsView: {
        ...current.settingsView,
        activeNav: "rulesSkills",
        mcpsOpen: false,
      },
    }));
  }, [updateWorkspaceSession]);

  return { mcpsOpen, openMcpServers, closeMcpServers, openRulesSkills };
}

export function PluginsSettingsPanel() {
  const { mcpsOpen, openMcpServers, closeMcpServers, openRulesSkills } =
    usePluginsMcpNavigation();
  const { workspaceInfo } = useWorkspace();
  const [plugins, setPlugins] = useState<AgentPluginPublic[]>([]);
  const [capabilities, setCapabilities] = useState<AgentPluginHarnessCapability[]>([]);
  const [discovery, setDiscovery] = useState<AgentPluginDiscoveryResult | null>(null);
  const [discoveryQuery, setDiscoveryQuery] = useState("");
  const [verification, setVerification] = useState<AgentPluginVerificationReport | null>(null);
  const [loading, setLoading] = useState(false);
  const [discovering, setDiscovering] = useState(false);
  const [verifying, setVerifying] = useState(false);
  const [pendingAction, setPendingAction] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [customName, setCustomName] = useState("");
  const [customSkill, setCustomSkill] = useState("");
  const [customMcpUrl, setCustomMcpUrl] = useState("");

  const workspaceId = workspaceInfo?.id ?? null;

  const capabilityById = useMemo(() => {
    const map = new Map<AgentBackendId, AgentPluginHarnessCapability>();
    for (const capability of capabilities) {
      map.set(capability.backendId, capability);
    }
    return map;
  }, [capabilities]);

  const promptOnlyHarnesses = useMemo(
    () => capabilities.filter((capability) => !capability.nativeMcp),
    [capabilities]
  );

  const refreshPlugins = useCallback(async () => {
    if (!workspaceId) {
      setPlugins([]);
      return;
    }
    setLoading(true);
    setError(null);
    try {
      const [nextPlugins, nextCapabilities] = await Promise.all([
        fetchAgentPlugins(workspaceId),
        fetchAgentPluginHarnessCapabilities(),
      ]);
      setPlugins(nextPlugins);
      setCapabilities(nextCapabilities);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load plugins.");
    } finally {
      setLoading(false);
    }
  }, [workspaceId]);

  const refreshDiscovery = useCallback(async (query = discoveryQuery) => {
    setDiscovering(true);
    try {
      setDiscovery(await discoverAgentPlugins(query));
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to discover plugins.");
    } finally {
      setDiscovering(false);
    }
  }, [discoveryQuery]);

  useEffect(() => {
    void refreshPlugins();
  }, [refreshPlugins]);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      setDiscovering(true);
      try {
        const result = await discoverAgentPlugins("");
        if (!cancelled) setDiscovery(result);
      } catch (err) {
        if (!cancelled) {
          setError(err instanceof Error ? err.message : "Failed to discover plugins.");
        }
      } finally {
        if (!cancelled) setDiscovering(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const runPluginAction = useCallback(
    async (actionId: string, action: () => Promise<AgentPluginPublic[]>) => {
      if (!workspaceId) return;
      setPendingAction(actionId);
      setError(null);
      try {
        setPlugins(await action());
      } catch (err) {
        setError(err instanceof Error ? err.message : "Plugin action failed.");
      } finally {
        setPendingAction(null);
      }
    },
    [workspaceId]
  );

  const runVerify = useCallback(async () => {
    if (!workspaceId) return;
    setVerifying(true);
    setError(null);
    try {
      setVerification(await verifyAgentPlugins(workspaceId));
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to verify plugin harness sync.");
    } finally {
      setVerifying(false);
    }
  }, [workspaceId]);

  const createCustomPlugin = useCallback(async () => {
    if (!workspaceId || !customName.trim()) return;
    const pluginId = customName.trim().toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
    const definition: AgentPluginDefinition = {
      schemaVersion: 1,
      pluginId: pluginId || "custom-plugin",
      displayName: customName.trim(),
      description: "Custom workspace plugin",
      mcp: customMcpUrl.trim()
        ? [
            {
              id: "custom-mcp",
              server: {
                label: customName.trim(),
                transport: "streamable-http",
                remote: { url: customMcpUrl.trim() },
                auth: { kind: "none" },
                summary: `${customName.trim()} custom MCP server`,
              },
            },
          ]
        : [],
      skills: customSkill.trim()
        ? [
            {
              id: "custom-skill",
              title: `${customName.trim()} skill`,
              description: "Custom plugin skill instructions",
              body: customSkill.trim(),
            },
          ]
        : [],
    };
    await runPluginAction("custom:create", async () => {
      const next = await createCustomAgentPlugin(workspaceId, definition);
      setCustomName("");
      setCustomSkill("");
      setCustomMcpUrl("");
      return next;
    });
  }, [customMcpUrl, customName, customSkill, runPluginAction, workspaceId]);

  if (mcpsOpen) {
    return (
      <>
        <SettingsBreadcrumbs
          segments={[
            { label: "Plugins", onClick: closeMcpServers },
            { label: "MCP servers" },
          ]}
        />
        <McpServersSettingsPanel />
      </>
    );
  }

  return (
    <>
      <SettingsBreadcrumbs segments={[{ label: "Plugins" }]} />
      <SettingsSection title="Agent Plugins">
        <div className="space-y-[10px] px-[16px] py-[12px]">
          <p className="font-sans text-[12px] leading-[18px] text-[var(--text-secondary)]">
            Plugins bundle MCP servers, skill instructions, and branding into one installable unit.
            Installed plugins sync to compatible harnesses automatically. Per-harness overrides let
            you disable a plugin for backends that cannot run its MCP tools natively.
          </p>
          {promptOnlyHarnesses.length > 0 ? (
            <div className="flex gap-[8px] rounded-[var(--radius-card)] border border-[color-mix(in_srgb,#f59e0b_35%,transparent)] bg-[color-mix(in_srgb,#f59e0b_10%,transparent)] px-[10px] py-[8px]">
              <AlertTriangle
                className="mt-[1px] size-[14px] shrink-0 text-[#fbbf24]"
                strokeWidth={1.75}
              />
              <div className="min-w-0 font-sans text-[12px] leading-[18px] text-[var(--text-secondary)]">
                <span className="font-medium text-[var(--text-primary)]">
                  Limited MCP support:
                </span>{" "}
                {promptOnlyHarnesses
                  .map((entry) => HARNESS_LABELS[entry.backendId] ?? entry.backendId)
                  .join(", ")}{" "}
                receive plugin skills and guidance in the prompt only. MCP tools will not run
                natively across those harnesses.
              </div>
            </div>
          ) : null}
          {error ? (
            <div className="rounded-[var(--radius-card)] border border-[var(--danger-border)] bg-[var(--danger-bg)] px-[10px] py-[8px] font-sans text-[12px] text-[var(--danger)]">
              {error}
            </div>
          ) : null}
          <div className="flex flex-wrap gap-[8px]">
            <button
              type="button"
              className={selectClass}
              disabled={!workspaceId || verifying}
              onClick={() => void runVerify()}
            >
              {verifying ? "Verifying..." : "Verify harness sync"}
            </button>
            <button
              type="button"
              className={selectClass}
              disabled={loading || pendingAction !== null}
              onClick={() => void refreshPlugins()}
            >
              Refresh
            </button>
          </div>
          {verification ? (
            <div className="rounded-[var(--radius-card)] border border-[var(--border-card)] bg-[var(--bg-main)] p-[10px]">
              <div className="font-sans text-[12px] font-medium text-[var(--text-primary)]">
                Harness verification
              </div>
              <p className="mt-[4px] font-sans text-[11px] leading-[16px] text-[var(--text-secondary)]">
                {verification.enabledPluginCount} enabled plugin(s) identified by{" "}
                {verification.summary.identifyingPlugins.length}/
                {verification.harnesses.length} harnesses. Prompt-only MCP:{" "}
                {verification.summary.promptOnlyMcp
                  .map((id) => HARNESS_LABELS[id] ?? id)
                  .join(", ") || "none"}
                .
              </p>
              <div className="mt-[8px] grid gap-[6px] sm:grid-cols-2">
                {verification.harnesses.map((harness) => (
                  <div
                    key={harness.backendId}
                    className="rounded-[var(--radius-tab)] border border-[var(--border-subtle)] px-[9px] py-[7px]"
                  >
                    <div className="flex items-center justify-between gap-[8px]">
                      <span className="flex items-center gap-[6px] font-sans text-[11px] text-[var(--text-primary)]">
                        <AgentBackendIcon backendId={harness.backendId} className="size-[13px]" />
                        {HARNESS_LABELS[harness.backendId] ?? harness.backendId}
                      </span>
                      <span className="font-sans text-[10px] uppercase tracking-[0.06em] text-[var(--text-secondary)]">
                        {harness.identified ? "Identified" : "Idle"}
                      </span>
                    </div>
                    <div className="mt-[4px] font-sans text-[10px] text-[var(--text-secondary)]">
                      {harness.skillCount} skill(s) ·{" "}
                      {harness.nativeMcp
                        ? `${harness.nativeMcpServerIds.length} native MCP`
                        : "prompt-only MCP"}
                    </div>
                    {harness.warnings[0] ? (
                      <div className="mt-[4px] font-sans text-[10px] leading-[14px] text-[#fbbf24]">
                        {harness.warnings[0].reason}
                      </div>
                    ) : null}
                  </div>
                ))}
              </div>
            </div>
          ) : null}
          {loading ? (
            <div className="font-sans text-[12px] text-[var(--text-secondary)]">Loading plugins...</div>
          ) : null}
          {plugins.map((plugin) => {
            const installed = Boolean(plugin.install);
            const enabled = plugin.enabled;
            const limitedHarnesses = HARNESS_ORDER.filter((backendId) => {
              const capability = capabilityById.get(backendId as AgentBackendId);
              const pluginSupport = plugin.definition.harnesses?.[backendId as AgentBackendId];
              const nativeMcp = pluginSupport?.nativeMcp ?? capability?.nativeMcp ?? true;
              return plugin.definition.mcp.length > 0 && !nativeMcp;
            });
            return (
              <div
                key={plugin.definition.pluginId}
                className="rounded-[var(--radius-card)] border border-[var(--border-card)] bg-[var(--bg-card)] p-[12px]"
              >
                <div className="flex items-start justify-between gap-[12px]">
                  <div className="min-w-0">
                    <div className="flex items-center gap-[8px]">
                      {plugin.definition.iconUrl ? (
                        <img
                          alt=""
                          src={plugin.definition.iconUrl}
                          className="size-[18px] rounded-[4px]"
                        />
                      ) : (
                        <Database className="size-[18px] text-[var(--text-secondary)]" strokeWidth={1.5} />
                      )}
                      <div className="font-sans text-[13px] font-semibold text-[var(--text-primary)]">
                        {plugin.definition.displayName}
                      </div>
                      <span className="rounded-full bg-[var(--accent-bg)] px-[7px] py-[2px] font-sans text-[10px] uppercase tracking-[0.08em] text-[var(--accent)]">
                        {enabled ? "Enabled" : installed ? "Installed" : "Catalog"}
                      </span>
                    </div>
                    <p className="mt-[6px] font-sans text-[12px] leading-[18px] text-[var(--text-secondary)]">
                      {plugin.definition.description}
                    </p>
                    <div className="mt-[8px] flex flex-wrap gap-[6px] font-sans text-[11px] text-[var(--text-secondary)]">
                      <span>{plugin.definition.skills.length} skill(s)</span>
                      <span>{plugin.definition.mcp.length} MCP contribution(s)</span>
                      {plugin.managedMcpServerIds.length > 0 ? (
                        <span>MCP: {plugin.managedMcpServerIds.join(", ")}</span>
                      ) : null}
                    </div>
                    {installed && limitedHarnesses.length > 0 ? (
                      <div className="mt-[8px] flex gap-[6px] font-sans text-[11px] leading-[16px] text-[#fbbf24]">
                        <AlertTriangle className="mt-[1px] size-[12px] shrink-0" strokeWidth={1.75} />
                        <span>
                          MCP tools will not work natively on{" "}
                          {limitedHarnesses
                            .map((id) => HARNESS_LABELS[id as AgentBackendId] ?? id)
                            .join(", ")}
                          . Skills still sync via prompt guidance.
                        </span>
                      </div>
                    ) : null}
                  </div>
                  <button
                    type="button"
                    className={selectClass}
                    disabled={pendingAction !== null || !workspaceId}
                    onClick={() =>
                      runPluginAction(plugin.definition.pluginId, () =>
                        installed
                          ? setAgentPluginEnabled(workspaceId!, plugin.definition.pluginId, !enabled)
                          : installAgentPlugin(workspaceId!, plugin.definition.pluginId)
                      )
                    }
                  >
                    {pendingAction === plugin.definition.pluginId
                      ? "Working..."
                      : installed
                        ? enabled
                          ? "Disable"
                          : "Enable"
                        : "Install"}
                  </button>
                </div>
                {installed ? (
                  <div className="mt-[12px] grid gap-[6px] sm:grid-cols-2">
                    {HARNESS_ORDER.map((backendId) => {
                      const override = plugin.install?.harnessOverrides.find(
                        (entry) => entry.backendId === backendId
                      );
                      const harnessEnabled = override?.enabled ?? plugin.enabled;
                      const capability = capabilityById.get(backendId as AgentBackendId);
                      const pluginSupport = plugin.definition.harnesses?.[backendId as AgentBackendId];
                      const nativeMcp = pluginSupport?.nativeMcp ?? capability?.nativeMcp ?? true;
                      const limited = plugin.definition.mcp.length > 0 && !nativeMcp;
                      return (
                        <button
                          key={backendId}
                          type="button"
                          title={
                            limited
                              ? pluginSupport?.notes ??
                                capability?.notes ??
                                "This harness does not support native plugin MCP."
                              : capability?.notes
                          }
                          className={`flex items-center justify-between rounded-[var(--radius-tab)] border px-[9px] py-[7px] font-sans text-[11px] hover:bg-[var(--accent-bg)] ${
                            limited
                              ? "border-[color-mix(in_srgb,#f59e0b_35%,transparent)] text-[#fbbf24]"
                              : "border-[var(--border-subtle)] text-[var(--text-secondary)]"
                          }`}
                          disabled={pendingAction !== null || !workspaceId}
                          onClick={() =>
                            runPluginAction(`${plugin.definition.pluginId}:${backendId}`, () =>
                              setAgentPluginHarnessOverride(
                                workspaceId!,
                                plugin.definition.pluginId,
                                backendId as AgentBackendId,
                                !harnessEnabled
                              )
                            )
                          }
                        >
                          <span className="flex items-center gap-[6px]">
                            <AgentBackendIcon backendId={backendId as AgentBackendId} className="size-[13px]" />
                            {HARNESS_LABELS[backendId as AgentBackendId] ?? backendId}
                            {limited ? (
                              <AlertTriangle className="size-[11px]" strokeWidth={1.75} />
                            ) : null}
                          </span>
                          <span>{harnessEnabled ? "On" : "Off"}</span>
                        </button>
                      );
                    })}
                  </div>
                ) : null}
              </div>
            );
          })}
        </div>
      </SettingsSection>

      <SettingsSection title="Discover">
        <div className="space-y-[10px] px-[16px] py-[12px]">
          <p className="font-sans text-[12px] leading-[18px] text-[var(--text-secondary)]">
            Browse the local catalog and optional remote/GitHub registries. Set{" "}
            <span className="font-mono text-[11px]">OPENCURSOR_PLUGIN_REGISTRY_URL</span> or{" "}
            <span className="font-mono text-[11px]">OPENCURSOR_PLUGIN_GITHUB_REPO</span> to pull
            additional plugins.
          </p>
          <div className="flex items-center gap-[8px]">
            <div className="relative min-w-0 flex-1">
              <Search
                className="pointer-events-none absolute left-[10px] top-1/2 size-[13px] -translate-y-1/2 text-[var(--text-secondary)]"
                strokeWidth={1.75}
              />
              <input
                className={`${shortcutInputClass} w-full max-w-none pl-[30px]`}
                placeholder="Search plugins"
                value={discoveryQuery}
                onChange={(event) => setDiscoveryQuery(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === "Enter") {
                    void refreshDiscovery(discoveryQuery);
                  }
                }}
              />
            </div>
            <button
              type="button"
              className={selectClass}
              disabled={discovering}
              onClick={() => void refreshDiscovery(discoveryQuery)}
            >
              {discovering ? "Searching..." : "Search"}
            </button>
          </div>
          {discovery?.sources?.length ? (
            <div className="flex flex-wrap gap-[6px] font-sans text-[10px] text-[var(--text-secondary)]">
              {discovery.sources.map((source) => (
                <span
                  key={`${source.id}:${source.label}`}
                  className="rounded-full border border-[var(--border-subtle)] px-[7px] py-[2px]"
                  title={source.error ?? source.url}
                >
                  {source.label}: {source.error ? "error" : source.pluginCount}
                </span>
              ))}
            </div>
          ) : null}
          <div className="space-y-[8px]">
            {(discovery?.plugins ?? [])
              .filter(
                (entry) =>
                  !plugins.some(
                    (plugin) =>
                      plugin.definition.pluginId === entry.definition.pluginId && plugin.install
                  )
              )
              .slice(0, 12)
              .map((entry) => (
                <div
                  key={`${entry.source}:${entry.definition.pluginId}`}
                  className="flex items-start justify-between gap-[12px] rounded-[var(--radius-card)] border border-[var(--border-subtle)] px-[10px] py-[9px]"
                >
                  <div className="min-w-0">
                    <div className="flex items-center gap-[8px]">
                      {entry.definition.iconUrl ? (
                        <img
                          alt=""
                          src={entry.definition.iconUrl}
                          className="size-[16px] rounded-[4px]"
                        />
                      ) : (
                        <Database className="size-[16px] text-[var(--text-secondary)]" strokeWidth={1.5} />
                      )}
                      <div className="font-sans text-[12px] font-semibold text-[var(--text-primary)]">
                        {entry.definition.displayName}
                      </div>
                      <span className="font-sans text-[10px] uppercase tracking-[0.06em] text-[var(--text-secondary)]">
                        {entry.sourceLabel}
                      </span>
                    </div>
                    <p className="mt-[4px] font-sans text-[11px] leading-[16px] text-[var(--text-secondary)]">
                      {entry.definition.description}
                    </p>
                  </div>
                  <button
                    type="button"
                    className={selectClass}
                    disabled={!workspaceId || pendingAction !== null}
                    onClick={() =>
                      runPluginAction(`discover:${entry.definition.pluginId}`, () =>
                        installAgentPlugin(workspaceId!, entry.definition.pluginId)
                      )
                    }
                  >
                    Install
                  </button>
                </div>
              ))}
            {discovery &&
            discovery.plugins.filter(
              (entry) =>
                !plugins.some(
                  (plugin) =>
                    plugin.definition.pluginId === entry.definition.pluginId && plugin.install
                )
            ).length === 0 ? (
              <div className="font-sans text-[12px] text-[var(--text-secondary)]">
                No additional plugins to install for this search.
              </div>
            ) : null}
          </div>
        </div>
      </SettingsSection>

      <SettingsSection title="Custom Plugin">
        <div className="space-y-[8px] px-[16px] py-[12px]">
          <input
            className={shortcutInputClass}
            placeholder="Plugin name"
            value={customName}
            onChange={(event) => setCustomName(event.target.value)}
          />
          <input
            className={shortcutInputClass}
            placeholder="Optional streamable HTTP MCP URL"
            value={customMcpUrl}
            onChange={(event) => setCustomMcpUrl(event.target.value)}
          />
          <textarea
            className={`${shortcutInputClass} min-h-[82px] w-full max-w-none resize-y`}
            placeholder="Optional skill instructions"
            value={customSkill}
            onChange={(event) => setCustomSkill(event.target.value)}
          />
          <button
            type="button"
            className={selectClass}
            disabled={!workspaceId || !customName.trim() || pendingAction !== null}
            onClick={() => void createCustomPlugin()}
          >
            Create custom plugin
          </button>
        </div>
      </SettingsSection>

      <SettingsSection title="Related">
        <button
          type="button"
          className="flex min-h-[48px] w-full items-center justify-between gap-[12px] border-b border-[var(--border-subtle)] px-[16px] py-[12px] text-left transition-colors hover:bg-[var(--accent-bg)]"
          onClick={openMcpServers}
        >
          <span className="font-sans text-[13px] font-medium text-[var(--text-primary)]">
            MCP servers
          </span>
          <ChevronRight className="size-[14px] shrink-0 text-[var(--text-secondary)]" strokeWidth={1.5} />
        </button>
        <button
          type="button"
          className="flex min-h-[48px] w-full items-center justify-between gap-[12px] px-[16px] py-[12px] text-left transition-colors hover:bg-[var(--accent-bg)]"
          onClick={openRulesSkills}
        >
          <span className="font-sans text-[13px] font-medium text-[var(--text-primary)]">
            Rules, skills, and subagents
          </span>
          <ChevronRight className="size-[14px] shrink-0 text-[var(--text-secondary)]" strokeWidth={1.5} />
        </button>
      </SettingsSection>
    </>
  );
}

function SettingsServerPicker({
  label,
  title,
  selectedServerId,
  servers,
  serverStatusById,
  onSelect,
  disabled = false,
}: {
  label: string;
  title?: string;
  selectedServerId: string | null;
  servers: Array<{ id: string; label: string; baseUrl: string }>;
  serverStatusById: Record<string, { health: string } | undefined>;
  onSelect: (serverId: string) => void;
  disabled?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [popoverPos, setPopoverPos] = useState({ top: 0, left: 0, width: 280 });
  const buttonRef = useRef<HTMLButtonElement | null>(null);
  const popoverRef = useRef<HTMLDivElement | null>(null);
  const selectedServer =
    servers.find((server) => server.id === selectedServerId) ?? servers[0] ?? null;
  const selectedHealth = selectedServer
    ? (serverStatusById[selectedServer.id]?.health ?? "unknown")
    : "unknown";

  useLayoutEffect(() => {
    if (!open || !buttonRef.current) {
      return;
    }
    const update = () => {
      const rect = buttonRef.current?.getBoundingClientRect();
      if (!rect) return;
      const width = Math.max(240, Math.min(320, window.innerWidth - 16));
      setPopoverPos({
        top: rect.bottom + 6,
        left: Math.max(8, Math.min(rect.right - width, window.innerWidth - width - 8)),
        width,
      });
    };
    update();
    window.addEventListener("resize", update);
    window.addEventListener("scroll", update, true);
    return () => {
      window.removeEventListener("resize", update);
      window.removeEventListener("scroll", update, true);
    };
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const onPointerDown = (event: PointerEvent) => {
      const target = event.target as Node | null;
      if (
        target &&
        (popoverRef.current?.contains(target) || buttonRef.current?.contains(target))
      ) {
        return;
      }
      setOpen(false);
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") setOpen(false);
    };
    document.addEventListener("pointerdown", onPointerDown, true);
    document.addEventListener("keydown", onKeyDown, true);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown, true);
      document.removeEventListener("keydown", onKeyDown, true);
    };
  }, [open]);

  return (
    <>
      <button
        ref={buttonRef}
        type="button"
        aria-label={label}
        title={title}
        aria-expanded={open}
        aria-haspopup="menu"
        disabled={disabled || servers.length === 0}
        onClick={() => setOpen((current) => !current)}
        className="inline-flex min-w-0 max-w-[240px] items-center gap-[6px] rounded-[var(--radius-pill)] border border-[var(--border-card)] bg-[var(--bg-main)] px-[10px] py-[6px] text-left font-sans text-[12px] text-[var(--text-primary)] transition-colors hover:bg-[var(--accent-bg)] disabled:cursor-not-allowed disabled:opacity-50"
      >
        <span
          className={`shrink-0 text-[10px] ${serverHealthColorClass(selectedHealth)}`}
          aria-hidden
        >
          {serverHealthIndicator(selectedHealth)}
        </span>
        <span className="min-w-0 flex-1 truncate">{selectedServer?.label ?? "Select server"}</span>
        <ChevronDown className="size-[13px] shrink-0 text-[var(--text-secondary)]" strokeWidth={1.5} />
      </button>
      {open
        ? createPortal(
            <div
              ref={popoverRef}
              role="menu"
              aria-label={label}
              className="fixed z-[10050] overflow-hidden rounded-[var(--radius-card)] border border-[var(--border-card)] bg-[var(--bg-panel)] shadow-lg"
              style={{
                top: popoverPos.top,
                left: popoverPos.left,
                width: popoverPos.width,
              }}
              data-ide-input-sink
              onPointerDown={(event) => event.stopPropagation()}
            >
              <div className="border-b border-[var(--border-card)] px-[10px] py-[7px]">
                <p className="font-sans text-[11px] font-medium text-[var(--text-secondary)]">
                  {label}
                </p>
              </div>
              <VerticalFadedScroll
                measureKey={servers.length}
                edgeColorVar="var(--bg-panel)"
                scrollClassName="hide-scrollbar-y max-h-[min(320px,45vh)] min-h-0 overflow-y-auto overscroll-contain p-[4px]"
              >
                {servers.map((server) => {
                  const selected = server.id === selectedServerId;
                  const health = serverStatusById[server.id]?.health ?? "unknown";
                  return (
                    <button
                      key={server.id}
                      type="button"
                      role="menuitemradio"
                      aria-checked={selected}
                      onClick={() => {
                        onSelect(server.id);
                        setOpen(false);
                      }}
                      className="flex w-full items-center gap-[8px] rounded-[var(--radius-tab)] px-[8px] py-[7px] text-left transition-colors hover:bg-[var(--accent-bg)]"
                    >
                      <span
                        className={`shrink-0 text-[10px] ${serverHealthColorClass(health)}`}
                        aria-hidden
                      >
                        {serverHealthIndicator(health)}
                      </span>
                      <span className="min-w-0 flex-1">
                        <span className="block truncate font-sans text-[12.5px] text-[var(--text-primary)]">
                          {server.label}
                        </span>
                        <span className="mt-[2px] block truncate font-mono text-[10.5px] text-[var(--text-secondary)]">
                          {server.baseUrl}
                        </span>
                      </span>
                      {selected ? (
                        <Check className="size-[13px] shrink-0 text-[var(--text-primary)]" strokeWidth={2} />
                      ) : null}
                    </button>
                  );
                })}
              </VerticalFadedScroll>
            </div>,
            document.body
          )
        : null}
    </>
  );
}

export function ServerConnectionsSettingsPanel() {
  const {
    activeServer,
    settingsServer,
    servers,
    onlineServers,
    serverStatusById,
    requiresDefaultServer,
    setActiveServer,
    setDefaultServer,
  } = useServerConnections();

  return (
    <>
      <PageIntro title="Servers" />
      <DefaultServerSettingsBanner className="mx-[16px] mb-[12px] mt-[4px]" />
      <SettingsSection title="Default settings server">
        <SettingsRow
          title="Home server for shared preferences"
          description={
            settingsServer
              ? `${settingsServer.baseUrl} · ${serverStatusById[settingsServer.id]?.health ?? "checking"}`
              : requiresDefaultServer
                ? "Pick which server stores theme, keyboard shortcuts, and model toggles."
                : "Unavailable"
          }
          trailing={
            <SettingsServerPicker
              label="Default settings server"
              title="Theme, shortcuts, and models are stored on this server for all chats"
              selectedServerId={settingsServer?.id ?? null}
              servers={servers}
              serverStatusById={serverStatusById}
              onSelect={setDefaultServer}
              disabled={servers.length === 0}
            />
          }
        />
        <SettingsRow
          title="Active chat server"
          description={`${activeServer.baseUrl} · ${serverStatusById[activeServer.id]?.health ?? "checking"}`}
          trailing={
            <SettingsServerPicker
              label="Active chat server"
              title="New chats and workspace actions use this server until you switch workspaces"
              selectedServerId={activeServer.id}
              servers={servers}
              serverStatusById={serverStatusById}
              onSelect={setActiveServer}
              disabled={servers.length === 0}
            />
          }
        />
        <SettingsRow
          title="Connected runtimes"
          description={
            onlineServers.length > 0
              ? onlineServers.map((server) => server.label).join(", ")
              : "No reachable saved servers yet."
          }
          trailing={
            <span className="rounded-[999px] border border-[var(--border-subtle)] px-[8px] py-[4px] font-sans text-[11px] text-[var(--text-secondary)]">
              {onlineServers.length}
            </span>
          }
          border={false}
        />
      </SettingsSection>
      <SettingsSection title="Saved servers" bordered={false}>
        <ServerConnectionsManager
          onActivate={(serverId) => {
            setActiveServer(serverId);
          }}
          onSetDefault={(serverId) => {
            setDefaultServer(serverId);
          }}
        />
      </SettingsSection>
    </>
  );
}

export function BetaSettingsPanel() {
  const {
    experimentalIpadMode,
    experimentalIpadCustomButtons,
    experimentalIpadWindowedTabInset,
    experimentalIpadResumeCache,
    vscodeExtensionsBeta,
    setExperimentalIpadMode,
    setExperimentalIpadCustomButtons,
    setExperimentalIpadWindowedTabInset,
    setExperimentalIpadResumeCache,
    setVscodeExtensionsBeta,
  } = useUserPreferences();
  const { ipadBetaSettings, vscodeExtensionsBetaSettings } = useCesiumRendererFeatureFlags();
  const { settings, updateSettings } = useGlobalSettings();
  const newBrowserEnabled = settings.agents.newBrowser;

  return (
    <>
      <PageIntro title="Beta" />
      <h2 className="mt-[24px] font-sans text-[13px] font-semibold text-[var(--text-secondary)]">
        Browser
      </h2>
      <SettingsSection>
        <SettingsRow
          title="New browser"
          description="Use the experimental Chromium-backed browser engine. This improves real browser API fidelity, but is still being tuned for hover states, animation smoothness, and response timing. The classic proxy browser remains the default."
          trailing={
            <ToggleSwitch
              checked={newBrowserEnabled}
              onChange={(checked) =>
                updateSettings((current) => ({
                  ...current,
                  agents: {
                    ...current.agents,
                    newBrowser: checked,
                  },
                }))
              }
              size="md"
              variant="green"
            />
          }
          border={false}
        />
      </SettingsSection>
      {vscodeExtensionsBetaSettings ? (
        <>
          <h2 className="mt-[24px] font-sans text-[13px] font-semibold text-[var(--text-secondary)]">
            Extensions
          </h2>
          <SettingsSection>
            <SettingsRow
              title="VS Code Extension Marketplace"
              description="Enable the desktop-only VS Code extension marketplace Beta. Installed extensions can run Node code in a separate host process; keep this off unless you trust the extensions and want the runtime."
              trailing={
                <ToggleSwitch
                  checked={vscodeExtensionsBeta}
                  onChange={setVscodeExtensionsBeta}
                  size="md"
                  variant="green"
                />
              }
              border={false}
            />
          </SettingsSection>
        </>
      ) : null}
      {ipadBetaSettings ? (
        <>
          <h2 className="mt-[24px] font-sans text-[13px] font-semibold text-[var(--text-secondary)]">
            iPad
          </h2>
          <SettingsSection>
            <SettingsRow
              title="Text Input Abstraction"
              description="Use hardware-keyboard-first input surfaces on iPad and avoid native text fields where possible. Experimental and intended for iPad web app sessions with a connected physical keyboard."
              trailing={
                <ToggleSwitch
                  checked={experimentalIpadMode}
                  onChange={setExperimentalIpadMode}
                  size="md"
                  variant="green"
                />
              }
            />
            <SettingsRow
              title="Custom Menu Buttons"
              description="Show explicit three-dot menu buttons for iPad-specific workarounds, starting with files and folders in the explorer tree."
              trailing={
                <ToggleSwitch
                  checked={experimentalIpadCustomButtons}
                  onChange={setExperimentalIpadCustomButtons}
                  size="md"
                  variant="green"
                />
              }
            />
            <SettingsRow
              title="Windowed mode tab inset"
              description="When the primary sidebar is hidden, add extra left padding to the editor tab strip so tabs sit clear of iPadOS window controls (close, minimize, maximize) in multitasking windows."
              trailing={
                <ToggleSwitch
                  checked={experimentalIpadWindowedTabInset}
                  onChange={setExperimentalIpadWindowedTabInset}
                  size="md"
                  variant="green"
                />
              }
            />
            <SettingsRow
              title="Fast resume cache"
              description="Cache the app shell and restore the last workspace snapshot before backend reconnect so iPadOS reloads feel closer to app resume."
              trailing={
                <ToggleSwitch
                  checked={experimentalIpadResumeCache}
                  onChange={setExperimentalIpadResumeCache}
                  size="md"
                  variant="green"
                />
              }
              border={false}
            />
          </SettingsSection>
        </>
      ) : null}
    </>
  );
}

const keycapClass =
  "inline-flex items-center rounded-[4px] border border-[var(--border-card)] bg-[var(--bg-main)] px-[6px] py-[2px] font-mono text-[11px] font-medium text-[var(--text-primary)] leading-tight";

function ShortcutKeycapGroup({
  binding,
  platform,
}: {
  binding: string;
  platform: ShortcutPlatform;
}) {
  const parsed = formatShortcutBinding(binding, platform);
  if (!parsed) return null;
  const tokens = parsed.split("+");
  return (
    <span className="inline-flex items-center gap-[3px]">
      {tokens.map((token, i) => (
        <kbd key={i} className={keycapClass}>{token}</kbd>
      ))}
    </span>
  );
}

function ShortcutKeyCapture({
  commandId,
  bindings,
  defaultBindings,
  platform,
  onCommitBinding,
  onReset,
}: {
  commandId: string;
  bindings: string[];
  defaultBindings: string[];
  platform: ShortcutPlatform;
  onCommitBinding: (bindings: string[]) => void;
  onReset: () => void;
}) {
  const [capturing, setCapturing] = useState(false);
  const captureRef = useRef<HTMLDivElement>(null);

  const isDefault =
    bindings.length === defaultBindings.length &&
    bindings.every((b, i) => b === defaultBindings[i]);

  useEffect(() => {
    if (!capturing) return;
    const onKeyDown = (e: KeyboardEvent) => {
      e.preventDefault();
      e.stopPropagation();
      if (["Control", "Shift", "Alt", "Meta"].includes(e.key)) return;
      if (e.key === "Escape") {
        setCapturing(false);
        return;
      }
      const parts: string[] = [];
      if (e.ctrlKey || e.metaKey) parts.push("Mod");
      if (e.shiftKey) parts.push("Shift");
      if (e.altKey) parts.push("Alt");
      parts.push(normalizeKeyForCapture(e.key));
      const binding = parts.join("+");
      setCapturing(false);
      onCommitBinding([binding]);
    };
    document.addEventListener("keydown", onKeyDown, true);
    return () => document.removeEventListener("keydown", onKeyDown, true);
  }, [capturing, onCommitBinding]);

  return (
    <div className="flex flex-wrap items-center justify-end gap-[8px]">
      <div
        ref={captureRef}
        role="button"
        tabIndex={0}
        onClick={() => setCapturing(true)}
        onKeyDown={(e) => {
          if (e.key === "Enter" || e.key === " ") {
            e.preventDefault();
            setCapturing(true);
          }
        }}
        className={`inline-flex cursor-pointer flex-wrap items-center justify-end gap-[6px] rounded-[var(--radius-tab)] outline-none transition-opacity focus-visible:ring-2 focus-visible:ring-[var(--accent)] ${
          capturing ? "opacity-100" : "hover:opacity-80"
        }`}
        aria-label={capturing ? `Press shortcut for ${commandId}` : `Shortcuts for ${commandId}. Click to change.`}
      >
        {capturing ? (
          <span className="font-sans text-[11px] italic text-[var(--accent)]">
            Press shortcut…
          </span>
        ) : bindings.length > 0 ? (
          bindings.map((binding, i) => (
            <ShortcutKeycapGroup
              key={i}
              binding={binding}
              platform={platform}
            />
          ))
        ) : (
          <span className="font-sans text-[11px] text-[var(--text-disabled)]">
            No binding
          </span>
        )}
      </div>
      {!isDefault && (
        <button type="button" className={rowButtonClass} onClick={onReset}>
          Reset
        </button>
      )}
    </div>
  );
}

type ShortcutCommandDef = (typeof SHORTCUT_COMMAND_DEFINITIONS)[number];

function shortcutBindingsHaystack(
  bindingList: string[],
  platform: ShortcutPlatform
): string {
  return bindingList
    .flatMap((binding) => [binding, formatShortcutBinding(binding, platform)])
    .join(" ")
    .toLowerCase();
}

function shortcutDefinitionMatchesQuery(
  def: ShortcutCommandDef,
  bindings: Record<string, string[]>,
  platform: ShortcutPlatform,
  query: string
): boolean {
  const q = query.trim().toLowerCase();
  if (!q) return true;

  if (def.label.toLowerCase().includes(q)) return true;
  if (def.id.toLowerCase().includes(q)) return true;
  if (def.section.toLowerCase().includes(q)) return true;

  const currentBindings =
    bindings[def.id] ?? DEFAULT_KEYBOARD_SHORTCUT_BINDINGS[def.id] ?? [];
  if (shortcutBindingsHaystack(currentBindings, platform).includes(q)) {
    return true;
  }
  if (shortcutBindingsHaystack(def.defaultBindings, platform).includes(q)) {
    return true;
  }

  const formattedCurrent = formatShortcutBindingsForInput(
    currentBindings,
    platform
  );
  if (formattedCurrent.toLowerCase().includes(q)) return true;

  return false;
}

export function KeyboardShortcutsSettingsPanel() {
  const { settings, updateSettings } = useGlobalSettings();
  const { workspaceSession, updateWorkspaceSession } = useWorkspace();
  const platform = useMemo(() => detectShortcutPlatform(), []);
  const bindings = settings.keyboardShortcuts.bindings;
  const voiceInputMode = settings.keyboardShortcuts.voiceInputMode;
  const [shortcutQuery, setShortcutQuery] = useState("");

  useEffect(() => {
    const focus = workspaceSession.settingsView.panelSearchFocus;
    if (focus?.kind !== "keyboardShortcuts") {
      return;
    }
    setShortcutQuery(focus.query);
    updateWorkspaceSession((current) => ({
      ...current,
      settingsView: {
        ...current.settingsView,
        panelSearchFocus: null,
      },
    }));
  }, [updateWorkspaceSession, workspaceSession.settingsView.panelSearchFocus]);
  const [expandedCategories, setExpandedCategories] = useState<
    Set<ShortcutCommandSection>
  >(new Set());

  const bySection = useMemo(() => {
    const map = new Map<ShortcutCommandSection, ShortcutCommandDef[]>();
    for (const def of SHORTCUT_COMMAND_DEFINITIONS) {
      const list = map.get(def.section) ?? [];
      list.push(def);
      map.set(def.section, list);
    }
    return map;
  }, []);

  const isFiltering = shortcutQuery.trim().length > 0;

  const filteredBySection = useMemo(() => {
    if (!isFiltering) {
      return bySection;
    }
    const result = new Map<ShortcutCommandSection, ShortcutCommandDef[]>();
    for (const [section, defs] of bySection) {
      const filtered = defs.filter((def) =>
        shortcutDefinitionMatchesQuery(def, bindings, platform, shortcutQuery)
      );
      if (filtered.length > 0) {
        result.set(section, filtered);
      }
    }
    return result;
  }, [bindings, bySection, isFiltering, platform, shortcutQuery]);

  const visibleSections = useMemo(
    () => SECTION_ORDER.filter((section) => filteredBySection.has(section)),
    [filteredBySection]
  );

  const commitBinding = useCallback(
    (commandId: string, newBindings: string[]) => {
      updateSettings((current) => ({
        ...current,
        keyboardShortcuts: {
          ...current.keyboardShortcuts,
          bindings: {
            ...current.keyboardShortcuts.bindings,
            [commandId]: newBindings,
          },
        },
      }));
    },
    [updateSettings]
  );

  const resetBinding = useCallback(
    (commandId: string) => {
      const fallback = DEFAULT_KEYBOARD_SHORTCUT_BINDINGS[commandId] ?? [];
      updateSettings((current) => ({
        ...current,
        keyboardShortcuts: {
          ...current.keyboardShortcuts,
          bindings: {
            ...current.keyboardShortcuts.bindings,
            [commandId]: [...fallback],
          },
        },
      }));
    },
    [updateSettings]
  );

  const toggleCategoryCollapse = useCallback((section: ShortcutCommandSection) => {
    setExpandedCategories((prev) => {
      const next = new Set(prev);
      if (next.has(section)) next.delete(section);
      else next.add(section);
      return next;
    });
  }, []);

  const setVoiceInputMode = useCallback(
    (mode: VoiceInputMode) => {
      updateSettings((current) => ({
        ...current,
        keyboardShortcuts: {
          ...current.keyboardShortcuts,
          voiceInputMode: mode,
        },
      }));
    },
    [updateSettings]
  );

  return (
    <>
      <PageIntro title="Keyboard shortcuts" />
      <div className="mb-[16px]">
        <HardwareAwareTextInput
          type="search"
          value={shortcutQuery}
          onChange={setShortcutQuery}
          placeholder="Search shortcuts"
          className="box-border h-[36px] w-full rounded-[var(--radius-tab)] border border-[var(--border-card)] bg-[var(--bg-panel)] pl-[10px] pr-[10px] font-sans text-[13px] text-[var(--text-primary)] outline-none placeholder:text-[var(--text-disabled)]"
          ariaLabel="Search keyboard shortcuts"
        />
      </div>
      {isFiltering && visibleSections.length === 0 ? (
        <div className="rounded-[var(--radius-card)] border border-[var(--border-card)] bg-[var(--bg-panel)] px-[16px] py-[24px] text-center font-sans text-[13px] text-[var(--text-disabled)]">
          No shortcuts match your search
        </div>
      ) : null}
      {visibleSections.map((section) => {
        const defs = filteredBySection.get(section);
        if (!defs?.length) return null;
        const allDefs = bySection.get(section) ?? defs;
        const collapsed = isFiltering ? false : !expandedCategories.has(section);
        const assignedCount = allDefs.filter((d) => {
          const b = bindings[d.id] ?? DEFAULT_KEYBOARD_SHORTCUT_BINDINGS[d.id] ?? [];
          return b.length > 0;
        }).length;
        return (
          <SettingsSection
            key={section}
            title={section}
            action={
              isFiltering ? (
                <span className="font-sans text-[12px] text-[var(--text-secondary)]">
                  {defs.length} {defs.length === 1 ? "match" : "matches"}
                </span>
              ) : (
                <button
                  type="button"
                  className="flex items-center gap-[6px] font-sans text-[12px] text-[var(--text-secondary)] hover:text-[var(--text-primary)]"
                  onClick={() => toggleCategoryCollapse(section)}
                >
                  <span>
                    {assignedCount}/{allDefs.length}
                  </span>
                  <ChevronRight
                    className={`size-[14px] shrink-0 transition-transform ${collapsed ? "" : "rotate-90"}`}
                    strokeWidth={1.5}
                  />
                </button>
              )
            }
          >
            {collapsed ? null : defs.map((def) => {
              const currentBindings =
                bindings[def.id] ??
                DEFAULT_KEYBOARD_SHORTCUT_BINDINGS[def.id] ??
                [];
              const isVoiceCommand = def.id === "chat.action.toggleVoiceInput";
              return (
                <div key={def.id}>
                  <SettingsRow
                    title={def.label}
                    description={
                      def.defaultBindings.length > 0
                        ? `${def.id} · Default: ${formatShortcutBindingsForInput(def.defaultBindings, platform)}`
                        : def.id
                    }
                    border={!isVoiceCommand}
                    trailing={
                      <ShortcutKeyCapture
                        commandId={def.id}
                        platform={platform}
                        bindings={currentBindings}
                        defaultBindings={def.defaultBindings}
                        onCommitBinding={(b) => commitBinding(def.id, b)}
                        onReset={() => resetBinding(def.id)}
                      />
                    }
                  />
                  {isVoiceCommand && (
                    <div className="flex items-center justify-between border-t border-[var(--border-subtle)] px-[16px] py-[10px]">
                      <span className="font-sans text-[12px] text-[var(--text-secondary)]">
                        Recording mode
                      </span>
                      <div className="flex items-center gap-[8px]">
                        <span
                          className={`font-sans text-[12px] ${
                            voiceInputMode === "toggle"
                              ? "text-[var(--text-primary)]"
                              : "text-[var(--text-disabled)]"
                          }`}
                        >
                          Toggle
                        </span>
                        <ToggleSwitch
                          checked={voiceInputMode === "hold"}
                          onChange={(isHold) =>
                            setVoiceInputMode(isHold ? "hold" : "toggle")
                          }
                          size="sm"
                          variant="green"
                        />
                        <span
                          className={`font-sans text-[12px] ${
                            voiceInputMode === "hold"
                              ? "text-[var(--text-primary)]"
                              : "text-[var(--text-disabled)]"
                          }`}
                        >
                          Hold
                        </span>
                      </div>
                    </div>
                  )}
                </div>
              );
            })}
          </SettingsSection>
        );
      })}
    </>
  );
}

const EXPORT_DEFAULT_SELECTION: SettingsExportGranularity = {
  theme: true,
  userPreferences: true,
  keyboardShortcuts: true,
  globalApp: true,
  workspaceSession: false,
};

function ExportGranularityPicker({
  value,
  onChange,
  presence,
}: {
  value: SettingsExportGranularity;
  onChange: (next: SettingsExportGranularity) => void;
  /** When set, disable checkboxes for sections not in the file (import mode). */
  presence?: SettingsExportGranularity | null;
}) {
  const row = (
    key: keyof SettingsExportGranularity,
    label: string,
    hint?: string
  ) => {
    const available = presence ? presence[key] : true;
    return (
      <label
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
        <div className="space-y-[14px] border-b border-[var(--border-subtle)] px-[16px] py-[14px] last:border-b-0">
          <ExportGranularityPicker
            value={exportSelection}
            onChange={setExportSelection}
          />
          <button
            type="button"
            className={`inline-flex items-center gap-[8px] ${rowButtonClass}`}
            onClick={runExport}
          >
            <Download className="size-[14px]" strokeWidth={1.5} aria-hidden />
            Download JSON
          </button>
        </div>
      </SettingsSection>
      <SettingsSection title="Import">
        <div className="space-y-[14px] border-b border-[var(--border-subtle)] px-[16px] py-[14px] last:border-b-0">
          <label className="block font-sans text-[12px] text-[var(--text-secondary)]">
            <span className="mb-[6px] block">Choose a previously exported file</span>
            <input
              type="file"
              accept="application/json,.json"
              className="max-w-full font-sans text-[12px] text-[var(--text-primary)]"
              onChange={(e) => onImportFileChange(e.target.files)}
            />
          </label>
          {importError ? (
            <p className="font-sans text-[12px] text-[#dc2626] dark:text-[#fca5a5]">
              {importError}
            </p>
          ) : null}
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
        </div>
      </SettingsSection>
    </>
  );
}

const STORAGE_DRIVER_LABELS: Record<StorageDriverKind, string> = {
  "legacy-json": "Legacy JSON",
  pg: "Postgres",
};

const STORAGE_PHASE_LABELS: Record<StorageMigrationPhase, string> = {
  workspaces: "Workspaces",
  "workspace-profile": "Workspace profile",
  "global-settings": "Global settings",
  "auth-state": "Auth state",
  "auth-sessions": "Auth sessions",
  "workspace-sessions": "Workspace sessions",
  "workspace-windows": "Workspace windows",
  "workspace-window-sessions": "Workspace window sessions",
  "agent-conversations": "Agent conversations",
  "agent-events": "Agent events",
  "burn-goals": "Burn goals",
  extensions: "Extensions",
  "provider-cache": "Provider cache",
};

function formatStorageStats(stats: StorageStatusResponse["drivers"]["pg"]): string {
  if (!stats.available || !stats.stats) {
    return stats.error ? `unavailable — ${stats.error}` : "unavailable";
  }
  const { workspaces, agentConversations, authSessions, providerCacheEntries } =
    stats.stats;
  return `${workspaces} workspaces · ${agentConversations} conversations · ${authSessions} sessions · ${providerCacheEntries} provider cache entries`;
}

function StorageSettingsPanel() {
  const [status, setStatus] = useState<StorageStatusResponse | null>(null);
  const [statusError, setStatusError] = useState<string | null>(null);
  const [direction, setDirection] = useState<{
    from: StorageDriverKind;
    to: StorageDriverKind;
  }>({ from: "legacy-json", to: "pg" });
  const [overwrite, setOverwrite] = useState(false);
  const [running, setRunning] = useState(false);
  const [currentProgress, setCurrentProgress] =
    useState<StorageMigrationProgress | null>(null);
  const [migrationLog, setMigrationLog] = useState<string[]>([]);
  const [lastResult, setLastResult] = useState<StorageMigrationResult | null>(null);

  const refreshStatus = useCallback(async () => {
    try {
      const payload = await fetchStorageStatus();
      setStatus(payload);
      setStatusError(null);
      if (payload.currentDriver !== direction.from && !running) {
        const other: StorageDriverKind =
          payload.currentDriver === "pg" ? "legacy-json" : "pg";
        setDirection({ from: payload.currentDriver, to: other });
      }
    } catch (error) {
      setStatusError((error as Error).message);
    }
  }, [direction.from, running]);

  useEffect(() => {
    void refreshStatus();
  }, [refreshStatus]);

  const handleStartMigration = useCallback(async () => {
    if (running) return;
    if (direction.from === direction.to) return;
    setRunning(true);
    setCurrentProgress(null);
    setLastResult(null);
    setMigrationLog([
      `Starting migration ${STORAGE_DRIVER_LABELS[direction.from]} → ${STORAGE_DRIVER_LABELS[direction.to]}${overwrite ? " (overwrite)" : ""}`,
    ]);
    try {
      await runStorageMigration(
        { from: direction.from, to: direction.to, overwrite },
        {
          onProgress: (event) => {
            setCurrentProgress(event);
          },
          onResult: (result) => {
            setLastResult(result);
            setMigrationLog((log) => [
              ...log,
              ...result.phases.map(
                (phase) =>
                  `${STORAGE_PHASE_LABELS[phase.phase]}: migrated ${phase.migrated}, skipped ${phase.skipped}${
                    phase.errors.length > 0 ? `, ${phase.errors.length} errors` : ""
                  }`
              ),
            ]);
          },
          onError: (message) => {
            setMigrationLog((log) => [...log, `Error: ${message}`]);
          },
        }
      );
    } catch (error) {
      setMigrationLog((log) => [...log, `Failed: ${(error as Error).message}`]);
    } finally {
      setRunning(false);
      void refreshStatus();
    }
  }, [direction, overwrite, refreshStatus, running]);

  const handleExport = useCallback(
    (driver: StorageDriverKind) => {
      if (typeof window === "undefined") return;
      const url = buildStorageExportUrl(driver);
      window.open(url, "_blank", "noopener,noreferrer");
    },
    []
  );

  const handleImport = useCallback(
    async (
      file: File,
      target: StorageDriverKind,
      forceOverwrite: boolean
    ): Promise<void> => {
      try {
        const archive = await file.text();
        const result = await importStorageArchive(archive, {
          driver: target,
          overwrite: forceOverwrite,
        });
        setMigrationLog((log) => [
          ...log,
          `Imported ${result.applied} entries into ${STORAGE_DRIVER_LABELS[target]}${
            result.errors.length > 0 ? ` with ${result.errors.length} errors` : ""
          }`,
        ]);
        await refreshStatus();
      } catch (error) {
        setMigrationLog((log) => [
          ...log,
          `Import failed: ${(error as Error).message}`,
        ]);
      }
    },
    [refreshStatus]
  );

  const legacyDiag = status?.drivers["legacy-json"];
  const pgDiag = status?.drivers.pg;
  const progressPercent = useMemo(() => {
    if (!currentProgress) return null;
    if (currentProgress.total === null || currentProgress.total === 0) return null;
    return Math.min(
      100,
      Math.round((currentProgress.completed / currentProgress.total) * 100)
    );
  }, [currentProgress]);

  return (
    <>
      <PageIntro title="Storage" />
      <SettingsSection
        title="Storage drivers"
        action={
          <button
            type="button"
            className={rowButtonClass}
            onClick={() => void refreshStatus()}
            disabled={running}
          >
            <RefreshCw className="size-[14px]" strokeWidth={1.5} aria-hidden />
            Refresh
          </button>
        }
      >
        {statusError ? (
          <div className="px-[16px] py-[12px] font-sans text-[12px] text-[var(--text-error)]">
            Status unavailable: {statusError}
          </div>
        ) : null}
        <SettingsRow
          title="Current driver"
          description={`OPENCURSOR_STORAGE_DRIVER=${status?.currentDriver ?? "(unknown)"}`}
          trailing={
            <span className="font-sans text-[12px] text-[var(--text-secondary)]">
              {status ? STORAGE_DRIVER_LABELS[status.currentDriver] : "Loading…"}
            </span>
          }
        />
        <SettingsRow
          title="Legacy JSON"
          description={legacyDiag ? formatStorageStats(legacyDiag) : "Loading…"}
          trailing={
            <div className="flex gap-[8px]">
              <button
                type="button"
                className={rowButtonClass}
                onClick={() => handleExport("legacy-json")}
                disabled={running}
              >
                <Download className="size-[14px]" strokeWidth={1.5} aria-hidden />
                Export
              </button>
              <StorageImportButton
                target="legacy-json"
                disabled={running}
                onImport={handleImport}
              />
            </div>
          }
        />
        <SettingsRow
          title="Postgres"
          description={pgDiag ? formatStorageStats(pgDiag) : "Loading…"}
          border={false}
          trailing={
            <div className="flex gap-[8px]">
              <button
                type="button"
                className={rowButtonClass}
                onClick={() => handleExport("pg")}
                disabled={running || !pgDiag?.available}
              >
                <Download className="size-[14px]" strokeWidth={1.5} aria-hidden />
                Export
              </button>
              <StorageImportButton
                target="pg"
                disabled={running || !pgDiag?.available}
                onImport={handleImport}
              />
            </div>
          }
        />
      </SettingsSection>
      <SettingsSection title="Migrate between drivers">
        <SettingsRow
          title="Direction"
          description="Choose which driver to copy from and which to copy to."
          trailing={
            <div className="flex items-center gap-[8px]">
              <select
                className={selectClass}
                value={direction.from}
                disabled={running}
        onChange={(event) => {
          const next = event.target.value as StorageDriverKind;
          setDirection(() => ({
            from: next,
            to: next === "pg" ? "legacy-json" : "pg",
          }));
        }}
              >
                <option value="legacy-json">Legacy JSON</option>
                <option value="pg">Postgres</option>
              </select>
              <ChevronRight className="size-[14px] text-[var(--text-secondary)]" aria-hidden />
              <select
                className={selectClass}
                value={direction.to}
                disabled={running}
                onChange={(event) =>
                  setDirection((prev) => ({
                    ...prev,
                    to: event.target.value as StorageDriverKind,
                  }))
                }
              >
                <option value="legacy-json">Legacy JSON</option>
                <option value="pg">Postgres</option>
              </select>
            </div>
          }
        />
        <SettingsRow
          title="Overwrite existing entries"
          description="When off, entries that already exist on the target are skipped. Turn this on only when you want the source to win."
          trailing={
            <ToggleSwitch
              checked={overwrite}
              onChange={setOverwrite}
              size="md"
            />
          }
        />
        <SettingsRow
          title="Run migration"
          description={
            direction.from === direction.to
              ? "Source and target must differ."
              : `Copies data from ${STORAGE_DRIVER_LABELS[direction.from]} to ${STORAGE_DRIVER_LABELS[direction.to]}.`
          }
          border={false}
          trailing={
            <button
              type="button"
              className={rowButtonClass}
              onClick={() => void handleStartMigration()}
              disabled={running || direction.from === direction.to}
            >
              <Database className="size-[14px]" strokeWidth={1.5} aria-hidden />
              {running ? "Migrating…" : "Start migration"}
            </button>
          }
        />
        {currentProgress ? (
          <div className="border-t border-[var(--border-subtle)] px-[16px] py-[12px]">
            <p className="font-sans text-[12px] text-[var(--text-secondary)]">
              {STORAGE_PHASE_LABELS[currentProgress.phase] ?? currentProgress.phase}
              {currentProgress.currentKey ? ` · ${currentProgress.currentKey}` : ""}
              {" — "}
              {currentProgress.completed}
              {currentProgress.total === null ? "" : ` / ${currentProgress.total}`}
            </p>
            {progressPercent !== null ? (
              <div className="mt-[8px] h-[4px] w-full overflow-hidden rounded-full bg-[var(--border-subtle)]">
                <div
                  className="h-full bg-[var(--accent-strong)] transition-[width]"
                  style={{ width: `${progressPercent}%` }}
                />
              </div>
            ) : null}
          </div>
        ) : null}
        {migrationLog.length > 0 ? (
          <div className="border-t border-[var(--border-subtle)] px-[16px] py-[12px]">
            <ul className="flex flex-col gap-[4px] font-sans text-[12px] text-[var(--text-secondary)]">
              {migrationLog.map((line, idx) => (
                <li key={idx}>{line}</li>
              ))}
            </ul>
            {lastResult ? (
              <p className="mt-[8px] font-sans text-[12px] text-[var(--text-primary)]">
                {lastResult.ok ? "Completed successfully." : "Completed with errors."}
              </p>
            ) : null}
          </div>
        ) : null}
      </SettingsSection>
    </>
  );
}

function StorageImportButton({
  target,
  disabled,
  onImport,
}: {
  target: StorageDriverKind;
  disabled?: boolean;
  onImport: (file: File, target: StorageDriverKind, overwrite: boolean) => Promise<void>;
}) {
  const [overwrite, setOverwrite] = useState(false);
  const inputRef = useRef<HTMLInputElement | null>(null);
  const handleFilesChanged = useCallback(
    async (event: ChangeEvent<HTMLInputElement>) => {
      const file = event.target.files?.[0];
      event.target.value = "";
      if (!file) return;
      await onImport(file, target, overwrite);
    },
    [onImport, overwrite, target]
  );
  return (
    <div className="flex items-center gap-[6px]">
      <input
        ref={inputRef}
        type="file"
        accept=".ndjson,application/x-ndjson,application/json,.json"
        className="hidden"
        onChange={(event) => void handleFilesChanged(event)}
      />
      <label
        className="flex items-center gap-[4px] font-sans text-[11px] text-[var(--text-secondary)]"
        title="Overwrite existing rows on import"
      >
        <input
          type="checkbox"
          checked={overwrite}
          disabled={disabled}
          onChange={(event) => setOverwrite(event.target.checked)}
        />
        overwrite
      </label>
      <button
        type="button"
        className={rowButtonClass}
        onClick={() => inputRef.current?.click()}
        disabled={disabled}
      >
        <Upload className="size-[14px]" strokeWidth={1.5} aria-hidden />
        Import
      </button>
    </div>
  );
}

export const SETTINGS_PANELS: Record<string, ComponentType> = {
  general: GeneralSettingsPanel,
  appearance: AppearanceSettingsPanel,
  agents: AgentsSettingsPanel,
  cloudAgents: CloudAgentsSettingsPanel,
  models: ModelsSettingsPanel,
  plugins: PluginsSettingsPanel,
  extensions: VscodeExtensionsSettingsPanel,
  servers: ServerConnectionsSettingsPanel,
  rulesSkills: RulesSkillsSubagentsPanel,
  beta: BetaSettingsPanel,
  keyboardShortcuts: KeyboardShortcutsSettingsPanel,
  exportImport: ExportImportSettingsPanel,
  storage: StorageSettingsPanel,
};
