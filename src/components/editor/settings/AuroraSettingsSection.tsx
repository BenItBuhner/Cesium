"use client";

import { Plus, X } from "lucide-react";
import { AuroraBackdrop } from "@/components/agent/AuroraBackdrop";
import { useGlobalSettings } from "@/components/preferences/GlobalSettingsProvider";
import {
  SettingsBlock,
  SettingsPxRangeControl,
  SettingsRow,
  SettingsSection,
} from "@/components/editor/settings-ui";
import { ToggleSwitch } from "@/components/ui/ToggleSwitch";
import {
  AURORA_MAX_CUSTOM_COLORS,
  AURORA_MIN_CUSTOM_COLORS,
  AURORA_PRESET_CATALOG,
  type AuroraPresetId,
  type AuroraSettingsState,
} from "@/lib/global-settings";
import type { AuroraPlacement } from "@/lib/aurora/aurora-renderer";

function presetGradient(colors: string[]): string {
  return `linear-gradient(115deg, ${colors.join(", ")})`;
}

/** Appearance panel section for the aurora conversation backdrop. */
export function AuroraSettingsSection() {
  const { settings, updateSettings } = useGlobalSettings();
  const aurora = settings.aurora;

  const patchAurora = (patch: Partial<AuroraSettingsState>) => {
    updateSettings((current) => ({
      ...current,
      aurora: { ...current.aurora, ...patch },
    }));
  };

  const presetEntries = Object.entries(AURORA_PRESET_CATALOG) as Array<
    [Exclude<AuroraPresetId, "custom">, (typeof AURORA_PRESET_CATALOG)[keyof typeof AURORA_PRESET_CATALOG]]
  >;

  const previewPlacement: AuroraPlacement =
    aurora.placement === "dynamic" ? "center" : aurora.placement;

  return (
    <SettingsSection title="Aurora background">
      <SettingsRow
        searchId="aurora-background"
        title="Aurora background"
        description="Soft aurora-borealis color field behind agent conversations."
        trailing={
          <ToggleSwitch
            checked={aurora.enabled}
            onChange={(value) => patchAurora({ enabled: value })}
            size="md"
          />
        }
      />
      {aurora.enabled ? (
        <>
          <SettingsBlock searchId="aurora-preview">
            <div className="relative h-[140px] overflow-hidden rounded-[var(--radius-card)] border border-[var(--border-subtle)] bg-[var(--bg-main)]">
              <AuroraBackdrop
                mood="working"
                placement={previewPlacement}
                settingsOverride={aurora}
              />
            </div>
          </SettingsBlock>
          <SettingsBlock searchId="aurora-preset">
            <p className="font-sans text-[13px] font-medium text-[var(--text-primary)]">Preset</p>
            <p className="mt-[4px] font-sans text-[12px] leading-snug text-[var(--text-secondary)]">
              Curated palettes, or build your own under Custom.
            </p>
            <div className="mt-[10px] grid grid-cols-2 gap-[8px] sm:grid-cols-3">
              {presetEntries.map(([id, preset]) => {
                const selected = aurora.preset === id;
                return (
                  <button
                    key={id}
                    type="button"
                    onClick={() => patchAurora({ preset: id })}
                    aria-pressed={selected}
                    title={preset.description}
                    className={`group overflow-hidden rounded-[var(--radius-card)] border text-left transition-colors ${
                      selected
                        ? "border-[var(--accent)] ring-1 ring-[var(--accent)]"
                        : "border-[var(--border-card)] hover:border-[var(--text-disabled)]"
                    }`}
                  >
                    <span
                      className="block h-[40px] w-full opacity-80 transition-opacity group-hover:opacity-100"
                      style={{ background: presetGradient(preset.colors) }}
                      aria-hidden
                    />
                    <span className="block px-[10px] py-[7px] font-sans text-[12px] font-medium text-[var(--text-primary)]">
                      {preset.label}
                    </span>
                  </button>
                );
              })}
              <button
                type="button"
                onClick={() => patchAurora({ preset: "custom" })}
                aria-pressed={aurora.preset === "custom"}
                title="Use your own colors"
                className={`group overflow-hidden rounded-[var(--radius-card)] border text-left transition-colors ${
                  aurora.preset === "custom"
                    ? "border-[var(--accent)] ring-1 ring-[var(--accent)]"
                    : "border-[var(--border-card)] hover:border-[var(--text-disabled)]"
                }`}
              >
                <span
                  className="block h-[40px] w-full opacity-80 transition-opacity group-hover:opacity-100"
                  style={{ background: presetGradient(aurora.customColors) }}
                  aria-hidden
                />
                <span className="block px-[10px] py-[7px] font-sans text-[12px] font-medium text-[var(--text-primary)]">
                  Custom
                </span>
              </button>
            </div>
          </SettingsBlock>
          {aurora.preset === "custom" ? (
            <SettingsBlock searchId="aurora-custom-colors">
              <p className="font-sans text-[13px] font-medium text-[var(--text-primary)]">
                Custom colors
              </p>
              <p className="mt-[4px] font-sans text-[12px] leading-snug text-[var(--text-secondary)]">
                {AURORA_MIN_CUSTOM_COLORS}–{AURORA_MAX_CUSTOM_COLORS} band colors, top curtain
                first.
              </p>
              <div className="mt-[10px] flex flex-wrap items-center gap-[8px]">
                {aurora.customColors.map((color, index) => (
                  <span
                    key={`${index}-${color}`}
                    className="inline-flex items-center gap-[4px] rounded-[var(--radius-tab)] border border-[var(--border-card)] bg-[var(--bg-main)] p-[4px]"
                  >
                    <input
                      type="color"
                      value={color}
                      aria-label={`Aurora color ${index + 1}`}
                      onChange={(event) => {
                        const next = [...aurora.customColors];
                        next[index] = event.target.value;
                        patchAurora({ customColors: next });
                      }}
                      className="size-[26px] cursor-pointer appearance-none rounded-[4px] border-0 bg-transparent p-0"
                    />
                    {aurora.customColors.length > AURORA_MIN_CUSTOM_COLORS ? (
                      <button
                        type="button"
                        aria-label={`Remove aurora color ${index + 1}`}
                        onClick={() =>
                          patchAurora({
                            customColors: aurora.customColors.filter((_, i) => i !== index),
                          })
                        }
                        className="rounded-[4px] p-[2px] text-[var(--text-disabled)] transition-colors hover:bg-[var(--accent-bg)] hover:text-[var(--text-primary)]"
                      >
                        <X className="size-[12px]" strokeWidth={2} />
                      </button>
                    ) : null}
                  </span>
                ))}
                {aurora.customColors.length < AURORA_MAX_CUSTOM_COLORS ? (
                  <button
                    type="button"
                    onClick={() =>
                      patchAurora({
                        customColors: [
                          ...aurora.customColors,
                          aurora.customColors[aurora.customColors.length - 1] ?? "#38bdf8",
                        ],
                      })
                    }
                    className="inline-flex items-center gap-[4px] rounded-[var(--radius-tab)] border border-dashed border-[var(--border-card)] px-[10px] py-[7px] font-sans text-[12px] text-[var(--text-secondary)] transition-colors hover:bg-[var(--accent-bg)] hover:text-[var(--text-primary)]"
                  >
                    <Plus className="size-[12px]" strokeWidth={2} />
                    Add color
                  </button>
                ) : null}
              </div>
            </SettingsBlock>
          ) : null}
          <SettingsBlock searchId="aurora-intensity">
            <p className="font-sans text-[13px] font-medium text-[var(--text-primary)]">
              Intensity
            </p>
            <p className="mt-[4px] font-sans text-[12px] leading-snug text-[var(--text-secondary)]">
              Overall visibility. The effect stays behind content and dims further in light mode.
            </p>
            <SettingsPxRangeControl
              className="mt-[12px]"
              ariaLabel="Aurora intensity"
              min={0}
              max={100}
              unit="%"
              value={aurora.intensity}
              onChange={(intensity) => patchAurora({ intensity })}
            />
          </SettingsBlock>
        </>
      ) : null}
    </SettingsSection>
  );
}
