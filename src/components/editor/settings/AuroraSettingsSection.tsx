"use client";

import { useMemo, useState } from "react";
import { AuroraBackground } from "@/components/chat/AuroraBackground";
import {
  SettingsBlock,
  SettingsPxRangeControl,
  SettingsRow,
  SettingsSection,
} from "@/components/editor/settings-ui";
import { ToggleSwitch } from "@/components/ui/ToggleSwitch";
import { useTheme } from "@/components/theme/ThemeProvider";
import {
  AURORA_BLUR_MAX,
  AURORA_BLUR_MIN,
  AURORA_CONVERSATION_STATES,
  AURORA_INTENSITY_MAX,
  AURORA_INTENSITY_MIN,
  AURORA_PRESETS,
  AURORA_PRESET_IDS,
  AURORA_SPEED_MAX,
  AURORA_SPEED_MIN,
  type AuroraConfig,
  type AuroraConversationState,
  type AuroraPresetId,
  auroraRgbToHex,
  parseAuroraHex,
} from "@/lib/aurora-config";

const STATE_LABELS: Record<AuroraConversationState, string> = {
  new: "New chat",
  idle: "Idle",
  typing: "Typing",
  working: "Working",
  awaiting: "Waiting",
  completed: "Completed",
  failed: "Failed",
  paused: "Paused",
  cancelled: "Cancelled",
};

const PRESET_SWATCHES: Record<AuroraPresetId, [string, string, string]> = {
  borealis: ["#38e6b0", "#48b0ff", "#a884ff"],
  australis: ["#ff76a8", "#ba78ff", "#40d6dc"],
  arctic: ["#60d6ff", "#a4ecff", "#bad2ff"],
  dusk: ["#ffb048", "#ff80b0", "#a870ff"],
  nebula: ["#c484ff", "#ff94dc", "#708cff"],
  monochrome: ["#d2dce8", "#a4b4c6", "#788aa0"],
  custom: ["#38e6b0", "#48b0ff", "#a884ff"],
};

export function AuroraSettingsSection() {
  const { themeConfig, setThemeConfig } = useTheme();
  const aurora = themeConfig.aurora;
  const [previewState, setPreviewState] = useState<AuroraConversationState>("new");

  const setAurora = (patch: Partial<AuroraConfig>) => {
    setThemeConfig({
      ...themeConfig,
      aurora: { ...themeConfig.aurora, ...patch },
    });
  };

  const customHex = useMemo(
    () => aurora.customColors.map((color) => auroraRgbToHex(color)) as [string, string, string],
    [aurora.customColors]
  );

  return (
    <SettingsSection title="Conversation aurora">
      <SettingsRow
        searchId="aurora-enabled"
        title="Aurora background"
        description="Soft moving color wash behind the agent conversation. Stays behind messages and the composer."
        trailing={
          <ToggleSwitch
            checked={aurora.enabled}
            onChange={(enabled) => setAurora({ enabled })}
            size="md"
          />
        }
      />
      <SettingsRow
        searchId="aurora-react-state"
        title="React to conversation state"
        description="Shift motion and color when the chat is new, typing, working, waiting, finished, or failed."
        trailing={
          <ToggleSwitch
            checked={aurora.reactToState}
            onChange={(reactToState) => setAurora({ reactToState })}
            size="md"
          />
        }
      />
      <SettingsBlock searchId="aurora-preset">
        <p className="font-sans text-[13px] font-medium text-[var(--text-primary)]">Preset</p>
        <p className="mt-[4px] font-sans text-[12px] leading-snug text-[var(--text-secondary)]">
          Start from a sky, then tune intensity. Custom keeps your three colors.
        </p>
        <div className="mt-[12px] grid grid-cols-2 gap-[8px] sm:grid-cols-3">
          {AURORA_PRESET_IDS.map((id) => {
            const selected = aurora.presetId === id;
            const label = id === "custom" ? "Custom" : AURORA_PRESETS[id].label;
            const swatches = id === "custom" ? customHex : PRESET_SWATCHES[id];
            return (
              <button
                key={id}
                type="button"
                aria-pressed={selected}
                onClick={() => setAurora({ presetId: id })}
                className={`flex flex-col gap-[8px] rounded-[var(--radius-tab)] border px-[10px] py-[10px] text-left transition-colors ${
                  selected
                    ? "border-[var(--text-primary)] bg-[var(--accent-bg)]"
                    : "border-[var(--border-card)] hover:bg-[var(--accent-bg)]"
                }`}
              >
                <span className="flex items-center gap-[5px]">
                  {swatches.map((color) => (
                    <span
                      key={color}
                      className="size-[10px] rounded-full border border-[var(--border-subtle)]"
                      style={{ backgroundColor: color }}
                    />
                  ))}
                </span>
                <span className="font-sans text-[12px] font-medium text-[var(--text-primary)]">
                  {label}
                </span>
              </button>
            );
          })}
        </div>
      </SettingsBlock>
      {aurora.presetId === "custom" ? (
        <SettingsBlock searchId="aurora-custom-colors">
          <p className="font-sans text-[13px] font-medium text-[var(--text-primary)]">
            Custom colors
          </p>
          <div className="mt-[12px] flex flex-wrap gap-[10px]">
            {customHex.map((hex, index) => (
              <label
                key={index}
                className="flex items-center gap-[8px] rounded-[var(--radius-tab)] border border-[var(--border-card)] bg-[var(--bg-main)] px-[8px] py-[6px] font-sans text-[11px] text-[var(--text-secondary)]"
              >
                Color {index + 1}
                <input
                  type="color"
                  value={hex}
                  onChange={(event) => {
                    const next = parseAuroraHex(event.target.value);
                    if (!next) {
                      return;
                    }
                    const customColors: AuroraConfig["customColors"] = [
                      ...aurora.customColors,
                    ];
                    customColors[index] = next;
                    setAurora({ customColors });
                  }}
                  className="size-[22px] cursor-pointer border-0 bg-transparent p-0"
                  aria-label={`Aurora custom color ${index + 1}`}
                />
              </label>
            ))}
          </div>
        </SettingsBlock>
      ) : null}
      <SettingsBlock searchId="aurora-intensity">
        <p className="font-sans text-[13px] font-medium text-[var(--text-primary)]">Intensity</p>
        <p className="mt-[4px] font-sans text-[12px] leading-snug text-[var(--text-secondary)]">
          How present the wash is. Keep this low if you want it barely there.
        </p>
        <SettingsPxRangeControl
          className="mt-[12px]"
          ariaLabel="Aurora intensity"
          min={AURORA_INTENSITY_MIN}
          max={AURORA_INTENSITY_MAX}
          value={aurora.intensity}
          unit="%"
          onChange={(intensity) => setAurora({ intensity })}
        />
      </SettingsBlock>
      <SettingsBlock searchId="aurora-speed">
        <p className="font-sans text-[13px] font-medium text-[var(--text-primary)]">Speed</p>
        <p className="mt-[4px] font-sans text-[12px] leading-snug text-[var(--text-secondary)]">
          How quickly the curtains drift. Lower stays calmer.
        </p>
        <SettingsPxRangeControl
          className="mt-[12px]"
          ariaLabel="Aurora speed"
          min={AURORA_SPEED_MIN}
          max={AURORA_SPEED_MAX}
          value={aurora.speed}
          unit="%"
          onChange={(speed) => setAurora({ speed })}
        />
      </SettingsBlock>
      <SettingsBlock searchId="aurora-blur">
        <p className="font-sans text-[13px] font-medium text-[var(--text-primary)]">Blur</p>
        <p className="mt-[4px] font-sans text-[12px] leading-snug text-[var(--text-secondary)]">
          Softer edges read more like night sky; sharper edges look more graphic.
        </p>
        <SettingsPxRangeControl
          className="mt-[12px]"
          ariaLabel="Aurora blur"
          min={AURORA_BLUR_MIN}
          max={AURORA_BLUR_MAX}
          value={aurora.blur}
          unit="%"
          onChange={(blur) => setAurora({ blur })}
        />
      </SettingsBlock>
      <SettingsBlock searchId="aurora-preview" className="space-y-[12px]">
        <p className="font-sans text-[13px] font-medium text-[var(--text-primary)]">Preview</p>
        <p className="font-sans text-[12px] leading-snug text-[var(--text-secondary)]">
          Sample each conversation state without leaving settings.
        </p>
        <div className="flex flex-wrap gap-[6px]">
          {AURORA_CONVERSATION_STATES.map((state) => {
            const selected = previewState === state;
            return (
              <button
                key={state}
                type="button"
                aria-pressed={selected}
                onClick={() => setPreviewState(state)}
                className={`rounded-[var(--radius-tab)] border px-[8px] py-[4px] font-sans text-[11px] transition-colors ${
                  selected
                    ? "border-[var(--text-primary)] bg-[var(--accent-bg)] text-[var(--text-primary)]"
                    : "border-[var(--border-card)] text-[var(--text-secondary)] hover:bg-[var(--accent-bg)] hover:text-[var(--text-primary)]"
                }`}
              >
                {STATE_LABELS[state]}
              </button>
            );
          })}
        </div>
        <div className="relative overflow-hidden rounded-[var(--radius-card)] border border-[var(--border-card)] bg-[var(--bg-main)]">
          <AuroraBackground state={previewState} preview />
          <div className="pointer-events-none absolute inset-x-0 bottom-0 px-[12px] py-[10px]">
            <p className="font-sans text-[12px] font-medium text-[var(--text-primary)]">
              {STATE_LABELS[previewState]}
            </p>
          </div>
        </div>
      </SettingsBlock>
    </SettingsSection>
  );
}
