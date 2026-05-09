"use client";

import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ChangeEvent,
  type ComponentType,
  type ReactNode,
} from "react";
import {
  ChevronDown,
  ChevronRight,
  Database,
  Download,
  ExternalLink,

  Lock,
  RefreshCw,
  Upload,
  X,
} from "lucide-react";
import { HardwareAwareTextInput } from "@/components/input/HardwareAwareTextField";
import { useGlobalSettings } from "@/components/preferences/GlobalSettingsProvider";
import { ServerConnectionsManager } from "@/components/preferences/ServerConnectionsManager";
import { useServerConnections } from "@/components/preferences/ServerConnectionsProvider";
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
  buildStorageExportUrl,
  deleteCursorSdkApiKey,
  fetchAgentDeploymentHints,
  fetchCursorSdkCredentialStatus,
  fetchStorageStatus,
  importStorageArchive,
  runStorageMigration,
  saveCursorSdkApiKey,
  type CursorAgentDeploymentHintsPayload,
  type CursorSdkCredentialStatus,
  type StorageDriverKind,
  type StorageMigrationPhase,
  type StorageMigrationProgress,
  type StorageMigrationResult,
  type StorageStatusResponse,
} from "@/lib/server-api";
import {
  DEFAULT_KEYBOARD_SHORTCUT_BINDINGS,
  detectShortcutPlatform,
  formatShortcutBinding,
  formatShortcutBindingsForInput,
  normalizeKeyForCapture,
  primaryModifierLabel,
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
import { SettingsThemeSelect } from "@/components/editor/SettingsThemeSelect";
import { ToggleSwitch } from "@/components/ui/ToggleSwitch";
import { AgentBackendIcon } from "@/components/chat/AgentBackendIcon";
import type { AgentBackendId } from "@/lib/agent-types";
import type { ModelToggleState } from "@/lib/global-settings";
import { recordPerfSample } from "@/lib/dev-perf";

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

const BACKEND_LABELS: Record<string, string> = {
  "cursor-acp": "Cursor",
  "cursor-sdk": "Cursor SDK",
  "opencode-acp": "OpenCode",
  "opencode-server": "OpenCode Server",
  "gemini-acp": "Gemini",
  "codex-adapter": "Codex",
  "codex-app-server": "Codex App Server",
  "claude-adapter": "Claude Code",
  "claude-code-sdk": "Claude Code SDK",
};

const BACKEND_ORDER: string[] = [
  "cursor-acp",
  "cursor-sdk",
  "codex-adapter",
  "codex-app-server",
  "opencode-acp",
  "opencode-server",
  "gemini-acp",
  "claude-adapter",
  "claude-code-sdk",
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
          title="Do Not Disturb"
          description="Suppress all notifications — connection alerts, warnings, file overrides, and every other notification type."
          trailing={
            <ToggleSwitch
              checked={general.doNotDisturb}
              onChange={(value) => patchGeneral({ doNotDisturb: value })}
              size="md"
            />
          }
        />
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
        subtitle="Choose system/light/dark behavior, a theme for each resolved appearance, and optional custom token overrides. Theming syncs to the server (and local storage as a cache); include it in settings export for backups."
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
        />
        <SettingsRow
          title="New design"
          description="Enable the next-generation UI design hooks for agent mode. Visual changes will expand as the design system is built out."
          trailing={
            <ToggleSwitch
              checked={themeConfig.uiDesignMode === "new"}
              onChange={(value) =>
                setThemeConfig({
                  ...themeConfig,
                  uiDesignMode: value ? "new" : "classic",
                })
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

function CursorSdkCredentialSettings() {
  const [status, setStatus] = useState<CursorSdkCredentialStatus | null>(null);
  const [apiKey, setApiKey] = useState("");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      const result = await fetchCursorSdkCredentialStatus();
      setStatus(result.status);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Failed to load Cursor SDK status.");
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const saveKey = useCallback(async () => {
    if (!apiKey.trim()) {
      setMessage("Paste a Cursor API key first.");
      return;
    }
    setBusy(true);
    setMessage(null);
    try {
      const result = await saveCursorSdkApiKey(apiKey);
      setStatus(result.status);
      setApiKey("");
      setMessage("Cursor SDK key verified and saved.");
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Cursor SDK key verification failed.");
    } finally {
      setBusy(false);
    }
  }, [apiKey]);

  const deleteKey = useCallback(async () => {
    setBusy(true);
    setMessage(null);
    try {
      const result = await deleteCursorSdkApiKey();
      setStatus(result.status);
      setMessage(
        result.status.source === "env"
          ? "Stored key removed; CURSOR_API_KEY is still configured on the server."
          : "Stored Cursor SDK key removed."
      );
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Failed to remove Cursor SDK key.");
    } finally {
      setBusy(false);
    }
  }, []);

  const statusText = !status
    ? "Loading…"
    : status.configured
      ? status.source === "env"
        ? "Configured from CURSOR_API_KEY"
        : `Configured${status.apiKeyName ? ` as ${status.apiKeyName}` : ""}`
      : "Not configured";

  return (
    <SettingsSection>
      <SubsectionLabel>Cursor SDK</SubsectionLabel>
      <div className="flex flex-col gap-[12px] px-[16px] pb-[14px] pt-[2px] font-sans text-[12px] text-[var(--text-secondary)]">
        <div className="flex flex-wrap items-center justify-between gap-[10px]">
          <div>
            <p className="text-[13px] font-medium text-[var(--text-primary)]">{statusText}</p>
            {status?.userEmail ? (
              <p className="mt-[3px] font-mono text-[11px]">{status.userEmail}</p>
            ) : null}
          </div>
          <a
            href="https://cursor.com/dashboard/integrations"
            target="_blank"
            rel="noreferrer"
            className={rowButtonClass}
          >
            Get API key
            <ExternalLink className="size-[13px]" strokeWidth={1.6} />
          </a>
        </div>
        <div className="flex flex-wrap items-center gap-[8px]">
          <input
            type="password"
            value={apiKey}
            onChange={(event) => setApiKey(event.currentTarget.value)}
            placeholder="Paste Cursor API key"
            className="box-border min-h-[32px] min-w-[260px] flex-1 rounded-[var(--radius-tab)] border border-[var(--border-card)] bg-[var(--bg-main)] px-[10px] py-[6px] font-mono text-[11px] text-[var(--text-primary)] outline-none placeholder:text-[var(--text-disabled)]"
          />
          <button
            type="button"
            className={rowButtonClass}
            disabled={busy}
            onClick={saveKey}
          >
            Test and save
          </button>
          <button
            type="button"
            className={rowButtonClass}
            disabled={busy || status?.source !== "stored"}
            onClick={deleteKey}
          >
            Remove stored key
          </button>
        </div>
        <p className="leading-relaxed">
          The key stays server-side and is used only by the `Cursor SDK` backend. The normal global settings payload
          only sees redacted status.
        </p>
        {message ? <p className="text-[var(--text-primary)]">{message}</p> : null}
      </div>
    </SettingsSection>
  );
}

export function AgentsSettingsPanel() {
  const { settings, updateSettings } = useGlobalSettings();
  const { workspaces } = useWorkspace();
  const agents = settings.agents;
  const modLabel = useMemo(
    () => primaryModifierLabel(detectShortcutPlatform()),
    []
  );

  const workspaceNameById = useMemo(() => {
    const m = new Map<string, string>();
    for (const w of workspaces) {
      m.set(w.id, w.name);
    }
    return m;
  }, [workspaces]);

  const sortedRemembered = useMemo(() => {
    return [...agents.rememberedPermissions].sort((a, b) => b.updatedAt - a.updatedAt);
  }, [agents.rememberedPermissions]);

  const patchAgents = (patch: Partial<typeof agents>) => {
    updateSettings((current) => ({
      ...current,
      agents: {
        ...current.agents,
        ...patch,
      },
    }));
  };

  const removeRemembered = (id: string) => {
    patchAgents({
      rememberedPermissions: agents.rememberedPermissions.filter((r) => r.id !== id),
    });
  };

  return (
    <>
      <PageIntro
        title="Agents"
        subtitle="Chat composer behavior, tool-permission memory, and Cursor CLI hints from the server. Other agent backends use their own CLIs; permission prompts use the shared ACP flow when supported."
      />
      <CursorAgentServerDeploymentReadout />
      <CursorSdkCredentialSettings />
      <SettingsSection title="Chat">
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
          border={false}
        />
      </SettingsSection>
      <SettingsSection title="Tool permissions">
        <SettingsRow
          title="Auto-approve all permission prompts"
          description="Dangerous: for ACP sessions (Cursor, Opencode, Gemini, etc.), the server answers every tool permission with Allow immediately. Remembered allow/reject rules in the list below still win when they match. This toggle does not add list entries—use the cards in chat for audited “always” choices."
          trailing={
            <ToggleSwitch
              checked={agents.autoAcceptAllAgentPermissions}
              onChange={(v) => patchAgents({ autoAcceptAllAgentPermissions: v })}
              size="md"
              variant="green"
            />
          }
        />
        <div className="border-b border-[var(--border-subtle)] px-[16px] py-[12px] last:border-b-0">
          <div className="mb-[10px] flex flex-wrap items-center justify-between gap-[8px]">
            <div>
              <p className="font-sans text-[13px] font-medium text-[var(--text-primary)]">
                Remembered decisions
              </p>
              <p className="mt-[4px] max-w-[560px] font-sans text-[12px] leading-snug text-[var(--text-secondary)]">
                “Always allow” and “always reject” choices from permission cards, per workspace and
                backend. Removing an entry here stops automatic reuse; it does not revoke work already
                done.
              </p>
            </div>
            <button
              type="button"
              className={`${rowButtonClass} disabled:cursor-not-allowed disabled:opacity-45`}
              disabled={agents.rememberedPermissions.length === 0}
              onClick={() => patchAgents({ rememberedPermissions: [] })}
            >
              Clear all
            </button>
          </div>
          {sortedRemembered.length === 0 ? (
            <p className="rounded-[var(--radius-tab)] border border-[var(--border-subtle)] bg-[var(--bg-main)] px-[12px] py-[16px] text-center font-sans text-[12px] text-[var(--text-disabled)]">
              No remembered permissions yet. Choose “always allow” or “always reject” on a permission
              card in chat to populate this list.
            </p>
          ) : (
            <ul className="max-h-[min(360px,45vh)] divide-y divide-[var(--border-subtle)] overflow-y-auto overscroll-contain rounded-[var(--radius-tab)] border border-[var(--border-card)]">
              {sortedRemembered.map((rule) => {
                const wsLabel =
                  workspaceNameById.get(rule.workspaceId) ?? rule.workspaceId.slice(0, 8);
                const backendLabel = BACKEND_LABELS[rule.backendId] ?? rule.backendId;
                const choice =
                  rule.optionKind === "allow_always"
                    ? "Always allow"
                    : rule.optionKind === "reject_always"
                      ? "Always reject"
                      : rule.decision === "allow"
                        ? "Allow"
                        : "Reject";
                return (
                  <li
                    key={rule.id}
                    className="flex flex-wrap items-start justify-between gap-[10px] px-[12px] py-[10px]"
                  >
                    <div className="min-w-0 flex-1">
                      <p className="font-sans text-[13px] font-medium text-[var(--text-primary)]">
                        {rule.toolLabel}
                      </p>
                      <p className="mt-[4px] font-mono text-[11px] text-[var(--text-secondary)]">
                        {rule.toolKey}
                      </p>
                      <p className="mt-[6px] flex flex-wrap items-center gap-[6px] font-sans text-[11px] text-[var(--text-secondary)]">
                        <span className={tagClass}>{backendLabel}</span>
                        <span className={tagClass}>{wsLabel}</span>
                        <span
                          className={`${tagClass} ${
                            rule.decision === "allow"
                              ? "border-emerald-500/40 text-emerald-700 dark:text-emerald-300"
                              : "border-rose-500/40 text-rose-700 dark:text-rose-300"
                          }`}
                        >
                          {choice}
                        </span>
                      </p>
                    </div>
                    <button
                      type="button"
                      className={rowButtonClass}
                      onClick={() => removeRemembered(rule.id)}
                    >
                      Remove
                    </button>
                  </li>
                );
              })}
            </ul>
          )}
        </div>
      </SettingsSection>
    </>
  );
}

export function ModelsSettingsPanel() {
  const {
    settings,
    updateSettings,
    refreshModels,
    modelsRefreshing,
    modelToggleSaveState,
    saveModelToggleUpdates,
  } = useGlobalSettings();
  const [modelQuery, setModelQuery] = useState("");
  const [collapsedBackends, setCollapsedBackends] = useState<Set<string>>(new Set());

  const byBackend = useMemo(
    () => settings.models.byBackend ?? {},
    [settings.models.byBackend]
  );

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
    setCollapsedBackends((prev) => {
      const next = new Set(prev);
      if (next.has(backendId)) {
        next.delete(backendId);
      } else {
        next.add(backendId);
      }
      recordPerfSample("settings.models.backend_toggle_visible", startedAt, {
        backendId,
        collapsed: next.has(backendId),
      });
      return next;
    });
  }, []);

  const filteredByBackend = useMemo(() => {
    const startedAt = performance.now();
    const q = modelQuery.trim().toLowerCase();
    if (!q) {
      recordPerfSample("settings.models.filter_render", startedAt, {
        queryLength: 0,
        backends: Object.keys(compactByBackend).length,
      });
      return compactByBackend;
    }
    const result: Record<string, CompactModelToggleRow[]> = {};
    for (const [backendId, models] of Object.entries(compactByBackend)) {
      const filtered = models.filter((m) => m.name.toLowerCase().includes(q));
      if (filtered.length > 0) {
        result[backendId] = filtered;
      }
    }
    recordPerfSample("settings.models.filter_render", startedAt, {
      queryLength: q.length,
      backends: Object.keys(result).length,
    });
    return result;
  }, [modelQuery, compactByBackend]);

  const sortedBackendIds = useMemo(() => {
    const present = new Set(Object.keys(filteredByBackend));
    return BACKEND_ORDER.filter((id) => present.has(id)).concat(
      Object.keys(filteredByBackend).filter((id) => !BACKEND_ORDER.includes(id))
    );
  }, [filteredByBackend]);

  const totalModels = useMemo(
    () => Object.values(compactByBackend).reduce((sum, list) => sum + list.length, 0),
    [compactByBackend]
  );

  const onCount = useMemo(
    () =>
      Object.values(compactByBackend).reduce(
        (sum, list) => sum + list.filter((m) => m.on).length,
        0
      ),
    [compactByBackend]
  );

  return (
    <>
      <PageIntro
        title="Models"
        subtitle={`${onCount} of ${totalModels} models visible in dropdown${
          modelToggleSaveState.pending > 0
            ? ` · saving ${modelToggleSaveState.pending} change${
                modelToggleSaveState.pending === 1 ? "" : "s"
              }`
            : modelToggleSaveState.error
              ? ` · save issue: ${modelToggleSaveState.error}`
              : ""
        }`}
      />
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
        const collapsed = collapsedBackends.has(backendId);
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
                  {BACKEND_LABELS[backendId] ?? backendId}
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

export function ServerConnectionsSettingsPanel() {
  const { activeServer, setActiveServer } = useServerConnections();
  const previousActiveServerIdRef = useRef(activeServer.id);

  useEffect(() => {
    if (previousActiveServerIdRef.current === activeServer.id) {
      return;
    }
    previousActiveServerIdRef.current = activeServer.id;
    if (typeof window !== "undefined") {
      window.location.assign("/");
    }
  }, [activeServer.id]);

  return (
    <>
      <PageIntro
        title="Servers"
        subtitle="Choose which OpenCursor server this browser connects to, keep multiple base URLs saved locally, and switch between them quickly."
      />
      <SettingsSection title="Active connection">
        <SettingsRow
          title="Current server"
          description={activeServer.baseUrl}
          trailing={
            <span className="rounded-[999px] bg-[var(--accent-bg)] px-[8px] py-[4px] font-sans text-[11px] text-[var(--text-primary)]">
              {activeServer.label}
            </span>
          }
        />
      </SettingsSection>
      <SettingsSection title="Saved servers">
        <div className="px-[16px] py-[16px]">
          <ServerConnectionsManager
            onActivate={(serverId) => {
              setActiveServer(serverId);
            }}
          />
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
    <div className="flex max-w-[min(100%,440px)] flex-wrap items-center justify-end gap-[8px]">
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
        className={`flex min-w-[200px] cursor-pointer items-center gap-[6px] rounded-[var(--radius-tab)] border px-[10px] py-[6px] transition-colors ${
          capturing
            ? "border-[var(--accent-border)] bg-[var(--accent-bg)]"
            : "border-[var(--border-card)] bg-[var(--bg-main)] hover:bg-[var(--accent-bg)]"
        }`}
        aria-label={capturing ? `Press shortcut for ${commandId}` : `Shortcuts for ${commandId}. Click to change.`}
      >
        {capturing ? (
          <span className="font-sans text-[11px] italic text-[var(--text-secondary)]">
            Press shortcut…
          </span>
        ) : bindings.length > 0 ? (
          <span className="flex flex-wrap items-center gap-[6px]">
            {bindings.map((binding, i) => (
              <ShortcutKeycapGroup
                key={i}
                binding={binding}
                platform={platform}
              />
            ))}
          </span>
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

export function KeyboardShortcutsSettingsPanel() {
  const { settings, updateSettings } = useGlobalSettings();
  const platform = useMemo(() => detectShortcutPlatform(), []);
  const bindings = settings.keyboardShortcuts.bindings;
  const voiceInputMode = settings.keyboardShortcuts.voiceInputMode;
  const [collapsedSections, setCollapsedSections] = useState<
    Set<ShortcutCommandSection>
  >(new Set());

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

  const toggleSectionCollapse = useCallback((section: ShortcutCommandSection) => {
    setCollapsedSections((prev) => {
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
      <PageIntro
        title="Keyboard shortcuts"
        subtitle={`Bindings use Mod as the primary modifier (${primaryModifierLabel(platform)} on this device). Separate chord steps with spaces (e.g. ${primaryModifierLabel(platform)}+K ${primaryModifierLabel(platform)}+S). Changes sync to the server with other settings.`}
      />
      {SECTION_ORDER.map((section) => {
        const defs = bySection.get(section);
        if (!defs?.length) return null;
        const collapsed = collapsedSections.has(section);
        const assignedCount = defs.filter((d) => {
          const b = bindings[d.id] ?? DEFAULT_KEYBOARD_SHORTCUT_BINDINGS[d.id] ?? [];
          return b.length > 0;
        }).length;
        return (
          <SettingsSection
            key={section}
            title={section}
            action={
              <button
                type="button"
                className="flex items-center gap-[6px] font-sans text-[12px] text-[var(--text-secondary)] hover:text-[var(--text-primary)]"
                onClick={() => toggleSectionCollapse(section)}
              >
                <span>{assignedCount}/{defs.length}</span>
                <ChevronRight
                  className={`size-[14px] shrink-0 transition-transform ${collapsed ? "" : "rotate-90"}`}
                  strokeWidth={1.5}
                />
              </button>
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
        subtitle="Choose which parts of your setup to include in a JSON backup. Import merges selected sections into this browser and workspace; theme, keyboard shortcuts, and app settings sync to the server."
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
      <PageIntro
        title="Storage"
        subtitle="Switch between the legacy JSON/JSONL driver and Postgres, port data between them, and export or import NDJSON archives."
      />
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
  models: ModelsSettingsPanel,
  plugins: PluginsSettingsPanel,
  servers: ServerConnectionsSettingsPanel,
  rulesSkills: RulesSkillsSubagentsPanel,
  tools: ToolsMcpSettingsPanel,
  beta: BetaSettingsPanel,
  keyboardShortcuts: KeyboardShortcutsSettingsPanel,
  exportImport: ExportImportSettingsPanel,
  storage: StorageSettingsPanel,
};
