"use client";

import { useEffect, useMemo, useState } from "react";
import { HardwareAwareTextInput } from "@/components/input/HardwareAwareTextField";
import { useGlobalSettings } from "@/components/preferences/GlobalSettingsProvider";
import { useTheme } from "@/components/theme/ThemeProvider";
import {
  TOOL_CALL_DROPDOWN_MAX_HEIGHT_MAX_PX,
  TOOL_CALL_DROPDOWN_MAX_HEIGHT_MIN_PX,
  type CustomThemeEntry,
} from "@/lib/theme-config";
import { DEFAULT_BUILTIN_THEME_ID, BUILTIN_THEME_CATALOG } from "@/lib/theme-presets";
import type { ThemePreference } from "@/lib/theme";
import {
  THEME_TOKEN_GROUPS,
  sanitizeThemeTokensPartial,
  type ThemeTokenKey,
} from "@/lib/theme-tokens";
import {
  PageIntro,
  SettingsBlock,
  SettingsPxRangeControl,
  SettingsRadioList,
  SettingsRow,
  SettingsSection,
  SettingsSubsectionHeading,
  rowButtonClass,
} from "@/components/editor/settings-ui";
import { SettingsThemeSelect } from "@/components/editor/SettingsThemeSelect";
import { ToggleSwitch } from "@/components/ui/ToggleSwitch";
import { selectClass, shortcutInputClass } from "./shared";

const APPEARANCE_MODE_OPTIONS: Array<{ value: ThemePreference; label: string }> = [
  { value: "system", label: "System" },
  { value: "light", label: "Light" },
  { value: "dark", label: "Dark" },
];

/** Shared height for Custom theme row (name input, duplicate select, Create). */
const CUSTOM_THEME_ROW_CONTROL_MIN_H = "min-h-[38px]";

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
      <SettingsSection title="Themes">
        <SettingsRow
          searchId="light-theme"
          title="Light theme"
          description="Applied when the UI resolves to light (including under “Light” mode or system light)."
          trailing={
            <SettingsThemeSelect
              triggerClassName={selectClass}
              value={themeConfig.lightThemeId}
              options={themeSelectOptions}
              onChange={setLightThemeId}
              ariaLabel="Light appearance theme"
              placement="below"
            />
          }
        />
        <SettingsRow
          searchId="dark-theme"
          title="Dark theme"
          description="Applied when the UI resolves to dark (including under “Dark” mode or system dark)."
          trailing={
            <SettingsThemeSelect
              triggerClassName={selectClass}
              value={themeConfig.darkThemeId}
              options={themeSelectOptions}
              onChange={setDarkThemeId}
              ariaLabel="Dark appearance theme"
              placement="below"
            />
          }
          border={false}
        />
      </SettingsSection>
      <SettingsSection title="Layout">
        <SettingsRow
          searchId="swap-columns"
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
          searchId="floating-sidebar"
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
          searchId="minimal-edit-diff"
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
        <SettingsBlock searchId="tool-call-dropdown-height">
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
        </SettingsBlock>
      </SettingsSection>
      <SettingsSection title="Custom themes">
        <SettingsBlock className="space-y-[12px]">
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
            <ul className="divide-y divide-[var(--border-subtle)]">
              {themeConfig.customThemes.map((t) => (
                <li
                  key={t.id}
                  className="flex flex-wrap items-center justify-between gap-[8px] py-[10px]"
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
        </SettingsBlock>
      </SettingsSection>
      {draft && editingId ? (
        <SettingsSection title={`Edit: ${draft.label}`}>
          <SettingsBlock className="space-y-[16px]">
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
                <SettingsSubsectionHeading>
                  {branch === "light" ? "Light branch tokens" : "Dark branch tokens"}
                </SettingsSubsectionHeading>
                <div className="space-y-[12px]">
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
          </SettingsBlock>
        </SettingsSection>
      ) : null}
    </>
  );
}
