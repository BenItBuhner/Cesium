"use client";

import {
  useCallback,
  useEffect,
  useMemo,
  useState,
  type ComponentType,
  type ReactNode,
} from "react";
import {
  ChevronDown,
  ChevronRight,
  Download,
  ExternalLink,
  Info,
  Lock,
  RefreshCw,
  X,
} from "lucide-react";
import { HardwareAwareTextInput } from "@/components/input/HardwareAwareTextField";
import { useGlobalSettings } from "@/components/preferences/GlobalSettingsProvider";
import { useUserPreferences } from "@/components/preferences/UserPreferencesProvider";
import { useTheme } from "@/components/theme/ThemeProvider";
import type { CustomThemeEntry } from "@/lib/theme-config";
import { DEFAULT_BUILTIN_THEME_ID, BUILTIN_THEME_CATALOG } from "@/lib/theme-presets";
import type { ThemePreference } from "@/lib/theme";
import {
  THEME_TOKEN_GROUPS,
  sanitizeThemeTokensPartial,
  type ThemeTokenKey,
} from "@/lib/theme-tokens";
import { useWorkspace } from "@/contexts/WorkspaceContext";
import {
  fetchAgentDeploymentHints,
  type CursorAgentDeploymentHintsPayload,
} from "@/lib/server-api";
import {
  DEFAULT_KEYBOARD_SHORTCUT_BINDINGS,
  detectShortcutPlatform,
  formatShortcutBindingsForInput,
  parseShortcutBindingsInput,
  primaryModifierLabel,
  SHORTCUT_COMMAND_DEFINITIONS,
  type ShortcutCommandSection,
  type ShortcutPlatform,
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
import { SettingsThemeSelect } from "@/components/editor/SettingsThemeSelect";
import { ToggleSwitch } from "@/components/ui/ToggleSwitch";
import { availableModels, currentModel } from "@/lib/mock-data";

export const rowButtonClass =
  "inline-flex shrink-0 items-center gap-[6px] rounded-[var(--radius-tab)] border border-[var(--border-card)] bg-transparent px-[12px] py-[5px] font-sans text-[12px] font-normal text-[var(--text-primary)] transition-colors hover:bg-[var(--accent-bg)]";

const selectClass =
  "inline-flex min-w-[160px] max-w-[240px] shrink-0 items-center justify-between gap-[8px] rounded-[var(--radius-tab)] border border-[var(--border-card)] bg-[var(--bg-main)] px-[10px] py-[6px] font-sans text-[12px] text-[var(--text-primary)] transition-colors hover:bg-[var(--accent-bg)]";

const tagClass =
  "inline-flex items-center gap-[6px] rounded-[var(--radius-tab)] border border-[var(--border-card)] bg-[var(--bg-main)] px-[8px] py-[3px] font-mono text-[11px] text-[var(--text-primary)]";

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

export function SettingsSection({
  title,
  children,
  action,
}: {
  title?: string;
  children: ReactNode;
  action?: ReactNode;
}) {
  const showHeader = Boolean((title && title.length > 0) || action);
  return (
    <section className="mb-[20px]">
      {showHeader ? (
        <div className="mb-[10px] flex items-center justify-between gap-[12px] px-[2px]">
          {title ? (
            <h2 className="font-sans text-[15px] font-semibold text-[var(--text-primary)]">
              {title}
            </h2>
          ) : (
            <span />
          )}
          {action}
        </div>
      ) : null}
      <div className="overflow-hidden rounded-[var(--radius-card)] border border-[var(--border-card)] bg-[var(--bg-panel)]">
        {children}
      </div>
    </section>
  );
}

export function SettingsRow({
  title,
  description,
  trailing,
  border = true,
  titleExtra,
}: {
  title: string;
  description?: string;
  trailing: ReactNode;
  border?: boolean;
  titleExtra?: ReactNode;
}) {
  return (
    <div
      className={`flex min-h-[56px] items-center justify-between gap-[16px] px-[16px] py-[12px] ${
        border ? "border-b border-[var(--border-subtle)] last:border-b-0" : ""
      }`}
    >
      <div className="min-w-0 flex-1">
        <p className="flex flex-wrap items-center gap-[8px] font-sans text-[13px] font-medium text-[var(--text-primary)]">
          {title}
          {titleExtra}
        </p>
        {description ? (
          <p className="mt-[4px] font-sans text-[12px] leading-snug text-[var(--text-secondary)]">
            {description}
          </p>
        ) : null}
      </div>
      <div className="shrink-0">{trailing}</div>
    </div>
  );
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

function SelectMock({ label }: { label: string }) {
  return (
    <button type="button" className={selectClass}>
      <span className="truncate">{label}</span>
      <ChevronDown className="size-[14px] shrink-0 text-[var(--text-disabled)]" strokeWidth={1.5} />
    </button>
  );
}

function TagList({ tags, onRemove }: { tags: string[]; onRemove?: (t: string) => void }) {
  return (
    <div className="flex max-w-[min(100%,420px)] flex-wrap justify-end gap-[6px]">
      {tags.map((t) => (
        <span key={t} className={tagClass}>
          <span className="max-w-[200px] truncate">{t}</span>
          {onRemove ? (
            <button
              type="button"
              className="rounded p-[1px] text-[var(--text-disabled)] hover:bg-[var(--accent-bg)] hover:text-[var(--text-primary)]"
              aria-label={`Remove ${t}`}
              onClick={() => onRemove(t)}
            >
              <X className="size-[12px]" strokeWidth={2} />
            </button>
          ) : null}
        </span>
      ))}
    </div>
  );
}

function EmptyWell({
  children,
  action,
}: {
  children: ReactNode;
  action?: ReactNode;
}) {
  return (
    <div className="flex min-h-[120px] flex-col items-center justify-center gap-[12px] rounded-[var(--radius-card)] border border-[var(--border-subtle)] bg-[var(--bg-main)] px-[16px] py-[24px] text-center">
      <p className="max-w-[360px] font-sans text-[13px] leading-relaxed text-[var(--text-secondary)]">
        {children}
      </p>
      {action}
    </div>
  );
}

function PageIntro({ title, subtitle }: { title: string; subtitle?: string }) {
  return (
    <>
      <h1 className="mb-[6px] font-sans text-[22px] font-semibold tracking-tight text-[var(--text-primary)]">
        {title}
      </h1>
      {subtitle ? (
        <p className="mb-[22px] max-w-[560px] font-sans text-[13px] leading-relaxed text-[var(--text-secondary)]">
          {subtitle}
        </p>
      ) : null}
    </>
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
      <PageIntro
        title="General"
        subtitle="Account, editor links, notifications, and privacy (demo UI)."
      />
      <SettingsSection title="Manage Account">
        <SettingsRow
          title="Manage Account"
          description="Manage your account and billing."
          trailing={
            <button type="button" className={rowButtonClass}>
              Open
              <ExternalLink className="size-[14px]" strokeWidth={1.5} aria-hidden />
            </button>
          }
        />
      </SettingsSection>
      <SettingsSection title="Preferences">
        <SettingsRow
          title="Editor Settings"
          description="Configure font, formatting, minimap and more"
          trailing={
            <button type="button" className={rowButtonClass}>
              Open
              <ExternalLink className="size-[14px]" strokeWidth={1.5} aria-hidden />
            </button>
          }
        />
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
          title="System notifications"
          description="Show notifications for important events and completions."
          trailing={
            <ToggleSwitch
              checked={general.sysNotify}
              onChange={(value) => patchGeneral({ sysNotify: value })}
              size="md"
            />
          }
        />
        <SettingsRow
          title="Warning Notifications"
          description="Surface warnings and non-fatal issues as notifications."
          trailing={
            <ToggleSwitch
              checked={general.warnNotify}
              onChange={(value) => patchGeneral({ warnNotify: value })}
              size="md"
            />
          }
        />
        <SettingsRow
          title="System Tray Icon"
          description="Keep an icon in the system tray while the app runs."
          trailing={
            <ToggleSwitch
              checked={general.trayIcon}
              onChange={(value) => patchGeneral({ trayIcon: value })}
              size="md"
            />
          }
        />
        <SettingsRow
          title="Completion Sound"
          description="Play a short sound when a generation completes."
          trailing={
            <ToggleSwitch
              checked={general.completionSound}
              onChange={(value) => patchGeneral({ completionSound: value })}
              size="md"
            />
          }
          border={false}
        />
      </SettingsSection>
      <SettingsSection title="Privacy">
        <SettingsRow
          title="Privacy Mode"
          description="When enabled, your code is not used to train models. Some cloud features may be limited in this demo."
          trailing={
            <button type="button" className={rowButtonClass}>
              <Lock className="size-[14px]" strokeWidth={1.5} aria-hidden />
              Privacy Mode
            </button>
          }
          border={false}
        />
      </SettingsSection>
      <div className="mt-[8px] px-[2px]">
        <button
          type="button"
          className="font-sans text-[13px] text-[var(--text-secondary)] transition-colors hover:text-[var(--text-primary)]"
        >
          Log Out
        </button>
      </div>
    </>
  );
}

const appearanceBtnBase =
  "rounded-[var(--radius-tab)] px-[12px] py-[6px] font-sans text-[12px] transition-colors";

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

  const appearanceChoice = (value: ThemePreference, label: string) => {
    const on = themeConfig.appearance === value;
    return (
      <button
        key={value}
        type="button"
        className={`${appearanceBtnBase} ${
          on
            ? "border-2 border-[var(--accent)] bg-[var(--accent-bg)] font-medium text-[var(--text-primary)]"
            : "border border-[var(--border-card)] bg-transparent text-[var(--text-primary)] hover:bg-[var(--accent-bg)]"
        }`}
        onClick={() => setPreference(value)}
      >
        {label}
      </button>
    );
  };

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
      <PageIntro
        title="Appearance"
        subtitle="Choose system/light/dark behavior, a theme for each resolved appearance, and optional custom token overrides. Custom themes are stored in this browser and can be included in settings export."
      />
      <SettingsSection title="Appearance mode">
        <div className="flex flex-wrap items-center gap-[8px] border-b border-[var(--border-subtle)] px-[16px] py-[14px] last:border-b-0">
          {appearanceChoice("system", "System")}
          {appearanceChoice("light", "Light")}
          {appearanceChoice("dark", "Dark")}
        </div>
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
          border={false}
        />
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

function CursorAgentServerDeploymentReadout() {
  const [payload, setPayload] = useState<CursorAgentDeploymentHintsPayload | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    fetchAgentDeploymentHints()
      .then((data) => {
        if (!cancelled) {
          setPayload(data);
          setLoadError(null);
        }
      })
      .catch((error) => {
        if (!cancelled) {
          setLoadError(error instanceof Error ? error.message : String(error));
        }
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const h = payload?.cursorAgent;

  return (
    <SettingsSection>
      <SubsectionLabel>Cursor CLI (OpenCursor server)</SubsectionLabel>
      <div className="px-[16px] pb-[14px] pt-[2px] font-sans text-[12px] leading-relaxed text-[var(--text-secondary)]">
        {loadError ? (
          <p className="text-[var(--text-primary)]">Could not load server hints: {loadError}</p>
        ) : !h ? (
          <p>Loading server configuration…</p>
        ) : (
          <div className="flex flex-col gap-[10px]">
            <p>
              <span className="text-[var(--text-primary)]">Binary: </span>
              {h.resolved
                ? h.commandPreview ?? "(resolved)"
                : "Not found. Set OPENCURSOR_CURSOR_CLI_BIN on the machine that runs the API."}
            </p>
            <p>
              <span className="text-[var(--text-primary)]">Path override env: </span>
              {h.cursorBinEnvSet ? "set" : "not set (using PATH)"}
            </p>
            <p>
              <span className="text-[var(--text-primary)]">Extra argv: </span>
              {h.extraArgs.length > 0 ? h.extraArgs.join(" ") : "—"}
            </p>
            <p>
              <span className="text-[var(--text-primary)]">Permission mode env: </span>
              {h.permissionModeEnv ?? "—"}
            </p>
            <p>
              <span className="text-[var(--text-primary)]">ACP capabilities JSON override: </span>
              {h.acpCapabilitiesJsonSet ? "set" : "not set"}
            </p>
            <p className="text-[11px] opacity-90">
              When the Cursor backend needs approval, choose an action on the permission card in the chat transcript.
              After a new chat session, check the transcript for Cursor CLI authentication notes from the server.
            </p>
          </div>
        )}
      </div>
    </SettingsSection>
  );
}

export function AgentsSettingsPanel() {
  const { settings, updateSettings } = useGlobalSettings();
  const agents = settings.agents;
  const modLabel = useMemo(
    () => primaryModifierLabel(detectShortcutPlatform()),
    []
  );

  const patchAgents = (patch: Partial<typeof agents>) => {
    updateSettings((current) => ({
      ...current,
      agents: {
        ...current.agents,
        ...patch,
      },
    }));
  };

  const rm = (arr: string[], t: string) => arr.filter((x) => x !== t);

  return (
    <>
      <PageIntro title="Agents" />
      <CursorAgentServerDeploymentReadout />
      <SettingsSection>
        <SettingsRow
          title={`Submit with ${modLabel} + Enter`}
          description={`When enabled, ${modLabel} + Enter submits chat and Enter inserts a newline.`}
          trailing={
            <ToggleSwitch
              checked={agents.submitCtrlEnter}
              onChange={(v) => patchAgents({ submitCtrlEnter: v })}
              size="md"
              variant="green"
            />
          }
        />
        <SettingsRow
          title="Queue Messages"
          description="Adjust the default behavior of sending a message while Agent is running."
          trailing={<SelectMock label="Send after current message" />}
        />
        <SettingsRow
          title="Usage Summary"
          description="When to show the usage summary at the bottom of the chat pane."
          trailing={<SelectMock label="Auto" />}
        />
        <SettingsRow
          title="Agent Autocomplete"
          description="Contextual suggestions while prompting Agent."
          trailing={
            <ToggleSwitch
              checked={agents.autocomplete}
              onChange={(v) => patchAgents({ autocomplete: v })}
              size="md"
              variant="green"
            />
          }
          border={false}
        />
      </SettingsSection>
      <SettingsSection>
        <SubsectionLabel>Context</SubsectionLabel>
        <SettingsRow
          title="Web Search Tool"
          description="Allow Agent to search the web for relevant information."
          trailing={
            <ToggleSwitch
              checked={agents.webSearch}
              onChange={(v) => patchAgents({ webSearch: v })}
              size="md"
              variant="green"
            />
          }
        />
        <SettingsRow
          title="Auto-Accept Web Search"
          description="Skip approval dialog. Agent may run web searches automatically."
          trailing={
            <ToggleSwitch
              checked={agents.autoWeb}
              onChange={(v) => patchAgents({ autoWeb: v })}
              size="md"
              variant="green"
            />
          }
        />
        <SettingsRow
          title="Web fetch tool"
          description="Allow Agent to fetch content from URLs."
          trailing={
            <ToggleSwitch
              checked={agents.webFetch}
              onChange={(v) => patchAgents({ webFetch: v })}
              size="md"
              variant="green"
            />
          }
        />
        <SettingsRow
          title="Hierarchical Cursor Ignore"
          description="Apply .cursorignore files in all subdirectories. Changing this setting will require a restart."
          trailing={
            <ToggleSwitch
              checked={agents.hierIgnore}
              onChange={(v) => patchAgents({ hierIgnore: v })}
              size="md"
              variant="green"
            />
          }
        />
        <SettingsRow
          title="Ignore Symlinks in Cursor Ignore Search"
          description="Use with caution. Skip symlinks during .cursorignore file discovery."
          titleExtra={
            <span
              className="rounded-[2px] bg-[#f59e0b]/20 px-[4px] font-sans text-[9px] font-semibold uppercase text-[#b45309]"
              title="Warning"
            >
              !
            </span>
          }
          trailing={
            <ToggleSwitch
              checked={agents.symlinkIgnore}
              onChange={(v) => patchAgents({ symlinkIgnore: v })}
              size="md"
              variant="green"
            />
          }
          border={false}
        />
      </SettingsSection>
      <SettingsSection>
        <SubsectionLabel>Auto-Run</SubsectionLabel>
        <SettingsRow
          title="Auto-Run Mode"
          description="Choose how Agent runs tools like command execution, MCP, and file writes."
          trailing={<SelectMock label="Auto-Run in Sandbox" />}
        />
        <SettingsRow
          title="Auto-Run Network Access"
          description="Control which network requests are allowed when commands run in the sandbox."
          trailing={<SelectMock label="sandbox.json + Defaults" />}
        />
        <SettingsRow
          title="Auto-Approved Mode Transitions"
          description="Mode transitions that will be automatically approved without prompting."
          trailing={
            <TagList
              tags={agents.modeTags}
              onRemove={(t) => patchAgents({ modeTags: rm(agents.modeTags, t) })}
            />
          }
        />
        <SettingsRow
          title="Command Allowlist"
          description="Commands Agent may run without confirmation when auto-run is enabled."
          trailing={
            <TagList
              tags={agents.cmdTags}
              onRemove={(t) => patchAgents({ cmdTags: rm(agents.cmdTags, t) })}
            />
          }
          border={false}
        />
      </SettingsSection>
      <SettingsSection title="Protection">
        <SettingsRow
          title="Browser Protection"
          description="Prevent Agent from automatically running Browser tools."
          trailing={
            <ToggleSwitch
              checked={agents.browserProt}
              onChange={(v) => patchAgents({ browserProt: v })}
              size="md"
              variant="green"
            />
          }
        />
        <SettingsRow
          title="MCP Tools Protection"
          description="Prevent Agent from automatically running MCP tools."
          trailing={
            <ToggleSwitch
              checked={agents.mcpProt}
              onChange={(v) => patchAgents({ mcpProt: v })}
              size="md"
              variant="green"
            />
          }
        />
        <SettingsRow
          title="File Deletion Protection"
          description="Prevent Agent from deleting files automatically."
          trailing={
            <ToggleSwitch
              checked={agents.fileDel}
              onChange={(v) => patchAgents({ fileDel: v })}
              size="md"
              variant="green"
            />
          }
        />
        <SettingsRow
          title="External File Protection"
          description="Prevent Agent from creating or modifying files outside of the workspace automatically."
          trailing={
            <ToggleSwitch
              checked={agents.extFile}
              onChange={(v) => patchAgents({ extFile: v })}
              size="md"
              variant="green"
            />
          }
          border={false}
        />
      </SettingsSection>
      <SettingsSection title="">
        <SubsectionLabel>Inline editing & terminal</SubsectionLabel>
        <SettingsRow
          title="Legacy Terminal Tool"
          description="Use the legacy terminal tool in agent mode, for use on systems with unsupported shell configurations."
          trailing={
            <ToggleSwitch
              checked={agents.legacyTerm}
              onChange={(v) => patchAgents({ legacyTerm: v })}
              size="md"
              variant="green"
            />
          }
        />
        <SettingsRow
          title="Auto-Parse Links"
          description={`Automatically parse links when pasted into Quick Edit (${modLabel}+K) input.`}
          trailing={
            <ToggleSwitch
              checked={agents.autoParse}
              onChange={(v) => patchAgents({ autoParse: v })}
              size="md"
              variant="green"
            />
          }
        />
        <SettingsRow
          title="Themed Diff Backgrounds"
          description="Use themed background colors for inline code diffs."
          trailing={
            <ToggleSwitch
              checked={agents.themedDiff}
              onChange={(v) => patchAgents({ themedDiff: v })}
              size="md"
              variant="green"
            />
          }
        />
        <SettingsRow
          title="Tool details in chat stream"
          description="When on, file edit diffs and command permission prompts appear as separate blocks in the main chat. When off, they stay inside the worked-session tool dropdown (default)."
          trailing={
            <ToggleSwitch
              checked={agents.inlineToolDetailsInChat}
              onChange={(v) => patchAgents({ inlineToolDetailsInChat: v })}
              size="md"
              variant="green"
            />
          }
        />
        <SettingsRow
          title="Collapse Auto-Run Commands"
          description="Collapse auto-run command output by default in Terminal command previews."
          trailing={
            <ToggleSwitch
              checked={agents.collapseAuto}
              onChange={(v) => patchAgents({ collapseAuto: v })}
              size="md"
              variant="green"
            />
          }
          border={false}
        />
      </SettingsSection>
      <SettingsSection title="Voice mode">
        <SettingsRow
          title="Submit Keywords"
          description="Custom keywords that trigger auto-submit in voice mode. Only single words (no spaces) are allowed."
          trailing={<TagList tags={["submit"]} />}
          border={false}
        />
      </SettingsSection>
      <SettingsSection title="Attribution">
        <SettingsRow
          title="Commit Attribution"
          description="Mark Agent commits as &apos;Made with Cursor&apos;."
          trailing={
            <ToggleSwitch
              checked={agents.commitAttr}
              onChange={(v) => patchAgents({ commitAttr: v })}
              size="md"
              variant="green"
            />
          }
        />
        <SettingsRow
          title="PR Attribution"
          description="Mark pull requests as made with Cursor."
          trailing={
            <ToggleSwitch
              checked={agents.prAttr}
              onChange={(v) => patchAgents({ prAttr: v })}
              size="md"
              variant="green"
            />
          }
          border={false}
        />
      </SettingsSection>
      <SettingsSection title="Git">
        <SettingsRow
          title="Branch Prefix"
          description="Prefix for new branches created by Agent (e.g. cursor/, username/)."
          trailing={
            <HardwareAwareTextInput
              type="text"
               value={agents.branchPrefix}
               onChange={(value) => patchAgents({ branchPrefix: value })}
              placeholder="cursor/"
              className="w-[min(100%,200px)] rounded-[var(--radius-tab)] border border-[var(--border-card)] bg-[var(--bg-main)] px-[10px] py-[6px] font-sans text-[12px] text-[var(--text-primary)] outline-none placeholder:text-[var(--text-disabled)]"
              ariaLabel="Branch prefix"
            />
          }
          border={false}
        />
      </SettingsSection>
    </>
  );
}

function createModelsSettingsState(): { id: string; name: string; on: boolean }[] {
  return availableModels.map((m) => ({
    id: m.id,
    name: m.name,
    on: m.id === currentModel.id,
  }));
}

export function ModelsSettingsPanel() {
  const { settings, updateSettings } = useGlobalSettings();
  const [apiOpen, setApiOpen] = useState(false);
  const [modelQuery, setModelQuery] = useState("");
  const models = settings.models.models.length
    ? settings.models.models
    : createModelsSettingsState();

  const setModels = (
    updater: (current: { id: string; name: string; on: boolean }[]) => {
      id: string;
      name: string;
      on: boolean;
    }[]
  ) => {
    updateSettings((current) => ({
      ...current,
      models: {
        ...current.models,
        models: updater(current.models.models),
      },
    }));
  };

  const visibleModels = useMemo(() => {
    const q = modelQuery.trim().toLowerCase();
    if (!q) return models;
    return models.filter((model) => model.name.toLowerCase().includes(q));
  }, [modelQuery, models]);

  return (
    <>
      <PageIntro title="Models" />
      <div className="mb-[16px] flex items-center gap-[8px]">
        <div className="relative min-w-0 flex-1">
          <HardwareAwareTextInput
            type="search"
            value={modelQuery}
            onChange={setModelQuery}
            placeholder="Add or search model"
            className="box-border h-[36px] w-full rounded-[var(--radius-tab)] border border-[var(--border-card)] bg-[var(--bg-panel)] pl-[10px] pr-[10px] font-sans text-[13px] text-[var(--text-primary)] outline-none placeholder:text-[var(--text-disabled)]"
            ariaLabel="Add or search model"
          />
        </div>
        <button
          type="button"
          className="flex size-[36px] shrink-0 items-center justify-center rounded-[var(--radius-tab)] border border-[var(--border-card)] bg-[var(--bg-panel)] text-[var(--text-secondary)] hover:bg-[var(--accent-bg)]"
          aria-label="Refresh models"
        >
          <RefreshCw className="size-[16px]" strokeWidth={1.5} />
        </button>
      </div>
      <SettingsSection>
        {visibleModels.map((m, i) => (
          <SettingsRow
            key={m.id}
            title={m.name}
            trailing={
              <div className="flex items-center gap-[8px]">
                <button
                  type="button"
                  className="text-[var(--text-disabled)] hover:text-[var(--text-primary)]"
                  aria-label={`About ${m.name}`}
                >
                  <Info className="size-[14px]" strokeWidth={1.5} />
                </button>
                <ToggleSwitch
                  checked={m.on}
                  onChange={(v) =>
                    setModels((rows) =>
                      rows.map((r) => (r.id === m.id ? { ...r, on: v } : r))
                    )
                  }
                  size="md"
                  variant="green"
                />
              </div>
            }
            border={i < visibleModels.length - 1}
          />
        ))}
        <div className="px-[16px] py-[12px]">
          <button
            type="button"
            className="font-sans text-[13px] font-medium text-[#2563eb] hover:underline"
          >
            View All Models
          </button>
        </div>
        <button
          type="button"
          onClick={() => setApiOpen(!apiOpen)}
          className="flex w-full items-center gap-[6px] border-t border-[var(--border-subtle)] px-[16px] py-[10px] font-sans text-[12px] text-[var(--text-secondary)] hover:bg-[var(--accent-bg)] hover:text-[var(--text-primary)]"
        >
          <ChevronRight
            className={`size-[14px] transition-transform ${apiOpen ? "rotate-90" : ""}`}
            strokeWidth={1.5}
          />
          API Keys
        </button>
        {apiOpen ? (
          <div className="border-t border-[var(--border-subtle)] px-[16px] py-[12px] font-sans text-[12px] text-[var(--text-secondary)]">
            API key management would open here.
          </div>
        ) : null}
      </SettingsSection>
    </>
  );
}

export function RulesSkillsSubagentsPanel() {
  const { settings, updateSettings } = useGlobalSettings();
  return (
    <>
      <PageIntro
        title="Rules, Skills, Subagents"
        subtitle="Provide domain-specific knowledge and workflows for the agent."
      />
      <SettingsSection>
        <SettingsRow
          title="Include third-party Plugins, Skills, and other configs"
           description="Automatically import agent configs from other tools."
           trailing={
            <ToggleSwitch
              checked={settings.rules.thirdParty}
              onChange={(value) =>
                updateSettings((current) => ({
                  ...current,
                  rules: {
                    ...current.rules,
                    thirdParty: value,
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
      <SettingsSection
        title="Rules"
        action={
          <button type="button" className="font-sans text-[12px] font-medium text-[#2563eb] hover:underline">
            + New
          </button>
        }
      >
        <div className="space-y-[8px] p-[12px]">
          {["Markdown Files", "Issue Resolution & Debugging", "Hospitality & Tech"].map((n) => (
            <div
              key={n}
              className="rounded-[var(--radius-tab)] border border-[var(--border-subtle)] bg-[var(--bg-main)] px-[12px] py-[10px] font-sans text-[12px] font-medium text-[var(--text-primary)]"
            >
              {n}
            </div>
          ))}
        </div>
      </SettingsSection>
      <SettingsSection
        title="Skills"
        action={
          <button type="button" className="font-sans text-[12px] font-medium text-[#2563eb] hover:underline">
            + New
          </button>
        }
      >
        <div className="divide-y divide-[var(--border-subtle)]">
          {[
            ["code-simplifier", "Simplifies and refines code for clarity."],
            ["frontend-ninja", "Distinctive production-grade UI work."],
            ["make-docs", "Documentation updates across the repo."],
            ["push", "Git push workflows."],
            ["openai-docs", "OpenAI product and API references."],
          ].map(([id, d]) => (
            <div key={id} className="px-[16px] py-[10px]">
              <p className="font-mono text-[12px] font-semibold text-[var(--text-primary)]">{id}</p>
              <p className="mt-[2px] font-sans text-[12px] text-[var(--text-secondary)]">{d}</p>
            </div>
          ))}
        </div>
        <div className="border-t border-[var(--border-subtle)] px-[16px] py-[10px]">
          <button type="button" className="font-sans text-[12px] text-[#2563eb] hover:underline">
            Show all (10 more)
          </button>
        </div>
      </SettingsSection>
      <SettingsSection
        title="Subagents"
        action={
          <button type="button" className="font-sans text-[12px] font-medium text-[#2563eb] hover:underline">
            + New
          </button>
        }
      >
        <div className="px-[16px] py-[12px]">
          <p className="font-mono text-[12px] font-semibold text-[var(--text-primary)]">docs-researcher</p>
          <p className="mt-[2px] font-sans text-[12px] text-[var(--text-secondary)]">
            Fetches library documentation on demand.
          </p>
        </div>
      </SettingsSection>
      <SettingsSection
        title="Community"
        action={
          <button type="button" className="font-sans text-[12px] font-medium text-[#2563eb] hover:underline">
            + New
          </button>
        }
      >
        <div className="divide-y divide-[var(--border-subtle)]">
          {["no-edit", "test-debug-and-iterate", "docs"].map((n) => (
            <div key={n} className="px-[16px] py-[10px] font-mono text-[12px] text-[var(--text-primary)]">
              {n}
            </div>
          ))}
        </div>
      </SettingsSection>
    </>
  );
}

export function PluginsSettingsPanel() {
  const { updateWorkspaceSession } = useWorkspace();

  return (
    <>
      <PageIntro
        title="Plugins"
        subtitle="Extensions for agents: reusable skills, MCP-backed tools, and related capabilities. This page is the hub for ACP-style agents; detailed editors live in Rules, Skills, Subagents and Tools & MCPs until a unified manifest is wired up."
      />
      <SettingsSection title="Manage">
        <SettingsRow
          title="Rules, skills, and subagents"
          description="Instruction files, skills, and subagent presets that agents load for domain-specific behavior."
          trailing={
            <button
              type="button"
              className={rowButtonClass}
              onClick={() =>
                updateWorkspaceSession((current) => ({
                  ...current,
                  settingsView: {
                    ...current.settingsView,
                    activeNav: "rulesSkills",
                  },
                }))
              }
            >
              Open
            </button>
          }
        />
        <SettingsRow
          title="Tools & MCP servers"
          description="MCP connections, browser automation, and allowlists for what tools may run automatically."
          trailing={
            <button
              type="button"
              className={rowButtonClass}
              onClick={() =>
                updateWorkspaceSession((current) => ({
                  ...current,
                  settingsView: {
                    ...current.settingsView,
                    activeNav: "tools",
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
      <SettingsSection title="Roadmap">
        <div className="p-[12px]">
          <p className="mb-[10px] font-sans text-[12px] text-[var(--text-secondary)]">
            Future work: one place to enable or scope skills and MCP servers per agent backend, shared across
            ACP-supported providers.
          </p>
          <EmptyWell>
            No unified plugin registry yet—use the links above to configure skills and MCP for now.
          </EmptyWell>
        </div>
      </SettingsSection>
    </>
  );
}

export function ToolsMcpSettingsPanel() {
  const { settings, updateSettings } = useGlobalSettings();
  const tools = settings.tools;

  return (
    <>
      <PageIntro title="Tools" subtitle="Browser automation, MCP servers, and allowlists." />
      <div className="mb-[16px] flex flex-wrap gap-[6px] border-b border-[var(--border-subtle)] pb-[10px]">
        {["Home", "opencursor", "Cloud"].map((t, i) => (
          <button
            key={t}
            type="button"
            className={`border-b-2 px-[10px] pb-[8px] font-sans text-[12px] ${
              i === 0
                ? "border-[#2563eb] font-medium text-[var(--text-primary)]"
                : "border-transparent text-[var(--text-secondary)] hover:text-[var(--text-primary)]"
            }`}
          >
            {t}
          </button>
        ))}
      </div>
      <SettingsSection title="Browser">
        <SettingsRow
          title="Browser Automation"
          description="Connected to Browser Tab."
          trailing={<SelectMock label="Browser Tab" />}
        />
        <SettingsRow
          title="Show Localhost Links in Browser"
          description="Automatically open localhost links in the Browser Tab."
          trailing={
            <ToggleSwitch
              checked={tools.localhost}
              onChange={(value) =>
                updateSettings((current) => ({
                  ...current,
                  tools: {
                    ...current.tools,
                    localhost: value,
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
      <SettingsSection title="User MCP Servers">
        <div className="p-[12px]">
          <p className="mb-[10px] font-sans text-[12px] text-[var(--text-secondary)]">
            Servers available in this workspace.
          </p>
          <EmptyWell action={<button type="button" className={rowButtonClass}>Add Custom MCP</button>}>
            No User MCP tools. Add a custom MCP tool in your user MCP config.
          </EmptyWell>
        </div>
      </SettingsSection>
      <SettingsSection
        title="Team MCP Servers"
        action={
          <button type="button" className="font-sans text-[12px] text-[#2563eb] hover:underline">
            Manage
          </button>
        }
      >
        <div className="p-[12px]">
          <p className="mb-[10px] font-sans text-[12px] text-[var(--text-secondary)]">
            Configured on the dashboard.
          </p>
          <EmptyWell
            action={
              <button type="button" className={rowButtonClass}>
                Configure Team MCP Servers
              </button>
            }
          >
            No Team MCP Servers. Configure MCP servers in the dashboard to make them available on desktop and in the cloud.
          </EmptyWell>
        </div>
      </SettingsSection>
      <SettingsSection title="Plugin MCP Servers">
        {tools.pluginState.map((p, i) => (
          <div
            key={p.id}
            className={`flex min-h-[56px] items-center justify-between gap-[12px] px-[16px] py-[12px] ${
              i < tools.pluginState.length - 1 ? "border-b border-[var(--border-subtle)]" : ""
            }`}
          >
            <div className="min-w-0">
              <p className="font-sans text-[13px] font-semibold text-[var(--text-primary)]">{p.name}</p>
              <p className="mt-[2px] font-sans text-[12px] text-[var(--text-secondary)]">{p.status}</p>
            </div>
            {p.connect ? (
              <button
                type="button"
                className="rounded-[var(--radius-tab)] bg-[#2563eb] px-[12px] py-[5px] font-sans text-[12px] font-medium text-white hover:bg-[#1d4ed8]"
              >
                Connect
              </button>
            ) : (
              <ToggleSwitch
                checked={p.on}
                onChange={(v) =>
                  updateSettings((current) => ({
                    ...current,
                    tools: {
                      ...current.tools,
                      pluginState: current.tools.pluginState.map((row) =>
                        row.id === p.id ? { ...row, on: v } : row
                      ),
                    },
                  }))
                }
                size="md"
                variant="green"
              />
            )}
          </div>
        ))}
      </SettingsSection>
      <SettingsSection title="Allowlists">
        <SettingsRow
          title="MCP Allowlist"
          description="MCP tools that can run automatically. Format: &apos;server:tool&apos;, &apos;server:*&apos;, &apos;tool&apos;, or &apos;*&apos;."
          trailing={<TagList tags={tools.mcpTags} />}
        />
        <SettingsRow
          title="Fetch Domain Allowlist"
          description="Domains that Agent can fetch from automatically. Use &apos;*&apos; for all domains."
          trailing={<TagList tags={tools.domainTags} />}
          border={false}
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
    setExperimentalIpadMode,
    setExperimentalIpadCustomButtons,
    setExperimentalIpadWindowedTabInset,
  } = useUserPreferences();

  return (
    <>
      <PageIntro title="Beta" />
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
          border={false}
        />
      </SettingsSection>
    </>
  );
}

function ShortcutBindingField({
  commandId,
  bindings,
  platform,
  onCommit,
  onReset,
}: {
  commandId: string;
  bindings: string[];
  platform: ShortcutPlatform;
  onCommit: (raw: string) => boolean;
  onReset: () => void;
}) {
  const displayValue = formatShortcutBindingsForInput(bindings, platform);
  const [draft, setDraft] = useState(displayValue);
  useEffect(() => {
    setDraft(displayValue);
  }, [displayValue]);

  return (
    <div className="flex max-w-[min(100%,440px)] flex-wrap items-center justify-end gap-[8px]">
      <HardwareAwareTextInput
        value={draft}
        onChange={setDraft}
        onBlur={() => {
          if (!onCommit(draft)) {
            setDraft(displayValue);
          }
        }}
        placeholder={`${primaryModifierLabel(platform)}+P, F1 (comma = alternate)`}
        className={shortcutInputClass}
        ariaLabel={`Shortcuts for ${commandId}`}
      />
      <button type="button" className={rowButtonClass} onClick={onReset}>
        Reset
      </button>
    </div>
  );
}

export function KeyboardShortcutsSettingsPanel() {
  const { settings, updateSettings } = useGlobalSettings();
  const platform = useMemo(() => detectShortcutPlatform(), []);
  const bindings = settings.keyboardShortcuts.bindings;

  const bySection = useMemo(() => {
    const map = new Map<
      ShortcutCommandSection,
      (typeof SHORTCUT_COMMAND_DEFINITIONS)[number][]
    >();
    for (const def of SHORTCUT_COMMAND_DEFINITIONS) {
      const list = map.get(def.section) ?? [];
      list.push(def);
      map.set(def.section, list);
    }
    return map;
  }, []);

  const commitBinding = useCallback(
    (commandId: string, raw: string) => {
      const parsed = parseShortcutBindingsInput(raw);
      if (parsed === null) {
        return false;
      }
      updateSettings((current) => ({
        ...current,
        keyboardShortcuts: {
          ...current.keyboardShortcuts,
          bindings: {
            ...current.keyboardShortcuts.bindings,
            [commandId]: parsed,
          },
        },
      }));
      return true;
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

  return (
    <>
      <PageIntro
        title="Keyboard shortcuts"
        subtitle={`Bindings use Mod as the primary modifier (${primaryModifierLabel(platform)} on this device). Separate chord steps with spaces (e.g. ${primaryModifierLabel(platform)}+K ${primaryModifierLabel(platform)}+S). Changes sync to the server with other settings.`}
      />
      {SECTION_ORDER.map((section) => {
        const defs = bySection.get(section);
        if (!defs?.length) {
          return null;
        }
        return (
          <SettingsSection key={section} title={section}>
            {defs.map((def, index) => (
              <SettingsRow
                key={def.id}
                title={def.label}
                description={def.id}
                border={index < defs.length - 1}
                titleExtra={
                  <span className="font-mono text-[11px] font-normal text-[var(--text-disabled)]">
                    {def.defaultBindings.length
                      ? formatShortcutBindingsForInput(def.defaultBindings, platform)
                      : "—"}
                  </span>
                }
                trailing={
                  <ShortcutBindingField
                    commandId={def.id}
                    platform={platform}
                    bindings={
                      bindings[def.id] ??
                      DEFAULT_KEYBOARD_SHORTCUT_BINDINGS[def.id] ??
                      []
                    }
                    onCommit={(raw) => commitBinding(def.id, raw)}
                    onReset={() => resetBinding(def.id)}
                  />
                }
              />
            ))}
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
        "Appearance mode, per-light/dark themes, and custom presets (local storage)."
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
        "General, Agents, Models, Plugins, Rules, Tools — demo settings from the settings API."
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
    a.download = `opencursor-settings-${new Date().toISOString().slice(0, 10)}.json`;
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
            "Not a valid OpenCursor settings export (need schemaVersion 1 or 2)."
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
      <PageIntro
        title="Import & export"
        subtitle="Choose which parts of your setup to include in a JSON backup. Import merges selected sections into this browser and workspace; keyboard shortcuts and app settings are saved to the server."
      />
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

export const SETTINGS_PANELS: Record<string, ComponentType> = {
  general: GeneralSettingsPanel,
  appearance: AppearanceSettingsPanel,
  agents: AgentsSettingsPanel,
  models: ModelsSettingsPanel,
  plugins: PluginsSettingsPanel,
  rulesSkills: RulesSkillsSubagentsPanel,
  tools: ToolsMcpSettingsPanel,
  beta: BetaSettingsPanel,
  keyboardShortcuts: KeyboardShortcutsSettingsPanel,
  exportImport: ExportImportSettingsPanel,
};
