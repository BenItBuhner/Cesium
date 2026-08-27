/**
 * Settings schema for the aurora conversation backdrop: a soft, animated
 * aurora-borealis color field layered behind agent conversations. The visual
 * renderer lives in the web app (`src/lib/aurora`); this module owns the
 * persisted shape, presets, defaults, and normalization.
 */

export const AURORA_PLACEMENT_IDS = [
  "dynamic",
  "top",
  "center",
  "full",
  "bottom",
] as const;

/**
 * Where the aurora sits in the pane. `dynamic` follows the conversation:
 * centered around the landing composer on a new chat, drifting to the top
 * once the conversation starts.
 */
export type AuroraPlacementId = (typeof AURORA_PLACEMENT_IDS)[number];

export const AURORA_PLACEMENT_LABELS: Record<AuroraPlacementId, string> = {
  dynamic: "Dynamic",
  top: "Top",
  center: "Center",
  full: "Full pane",
  bottom: "Bottom",
};

export function isAuroraPlacementId(value: unknown): value is AuroraPlacementId {
  return (
    typeof value === "string" &&
    (AURORA_PLACEMENT_IDS as readonly string[]).includes(value)
  );
}

export const AURORA_PRESET_IDS = [
  "aurora-borealis",
  "polar-dawn",
  "emerald-veil",
  "midnight-neon",
  "ember-drift",
  "moonlight",
  "custom",
] as const;

export type AuroraPresetId = (typeof AURORA_PRESET_IDS)[number];

export type AuroraPresetDefinition = {
  label: string;
  description: string;
  /** Ordered band colors, top curtain first. */
  colors: string[];
};

/**
 * Built-in palettes. `custom` intentionally has no entry: its colors come
 * from `AuroraSettingsState.customColors`.
 */
export const AURORA_PRESET_CATALOG: Record<
  Exclude<AuroraPresetId, "custom">,
  AuroraPresetDefinition
> = {
  "aurora-borealis": {
    label: "Aurora Borealis",
    description: "Classic polar greens and violets with a cyan undercurrent.",
    colors: ["#22e0a6", "#38bdf8", "#8b5cf6", "#d946ef"],
  },
  "polar-dawn": {
    label: "Polar Dawn",
    description: "Soft rose, amber, and lavender - first light over the ice.",
    colors: ["#fb7185", "#fbbf24", "#a78bfa", "#7dd3fc"],
  },
  "emerald-veil": {
    label: "Emerald Veil",
    description: "A single-family cascade of greens and sea teals.",
    colors: ["#34d399", "#2dd4bf", "#4ade80", "#22d3ee"],
  },
  "midnight-neon": {
    label: "Midnight Neon",
    description: "Electric indigo, ultraviolet, and hot magenta.",
    colors: ["#60a5fa", "#6366f1", "#a855f7", "#ec4899"],
  },
  "ember-drift": {
    label: "Ember Drift",
    description: "The rare red aurora - embers, rose, and gold.",
    colors: ["#fb923c", "#f43f5e", "#fbbf24", "#e879f9"],
  },
  moonlight: {
    label: "Moonlight",
    description: "Near-monochrome silver blues. The quietest option.",
    colors: ["#93c5fd", "#c7d2fe", "#a5b4fc", "#bae6fd"],
  },
};

export const DEFAULT_AURORA_PRESET_ID: AuroraPresetId = "aurora-borealis";

export const AURORA_MIN_CUSTOM_COLORS = 2;
export const AURORA_MAX_CUSTOM_COLORS = 5;

export type AuroraSettingsState = {
  /** Master switch for the animated conversation backdrop. */
  enabled: boolean;
  preset: AuroraPresetId;
  placement: AuroraPlacementId;
  /** 0..100 - overall visibility. The effect stays subtle even at 100. */
  intensity: number;
  /** 0..100 - animation pace; 50 is the designed speed. */
  speed: number;
  /**
   * Shift color, brightness, and motion with the conversation lifecycle
   * (new chat, typing, agent working, waiting on input, completed, error).
   * When off, the backdrop stays in its calm ambient state.
   */
  reactToActivity: boolean;
  /** Band colors used when `preset` is `custom` (2..5 hex values). */
  customColors: string[];
};

export function createDefaultAuroraSettings(): AuroraSettingsState {
  return {
    enabled: true,
    preset: DEFAULT_AURORA_PRESET_ID,
    placement: "dynamic",
    intensity: 55,
    speed: 50,
    reactToActivity: true,
    customColors: [...AURORA_PRESET_CATALOG["aurora-borealis"].colors],
  };
}

export function isAuroraPresetId(value: unknown): value is AuroraPresetId {
  return (
    typeof value === "string" && (AURORA_PRESET_IDS as readonly string[]).includes(value)
  );
}

/** Resolve the active band colors for a settings state (custom falls back to the default preset). */
export function resolveAuroraColors(settings: AuroraSettingsState): string[] {
  if (settings.preset === "custom") {
    return settings.customColors.length >= AURORA_MIN_CUSTOM_COLORS
      ? settings.customColors
      : [...AURORA_PRESET_CATALOG[DEFAULT_AURORA_PRESET_ID as "aurora-borealis"].colors];
  }
  return AURORA_PRESET_CATALOG[settings.preset].colors;
}

const HEX_COLOR_RE = /^#[0-9a-f]{6}$/i;

function clampPercent(raw: unknown, fallback: number): number {
  if (typeof raw !== "number" || !Number.isFinite(raw)) {
    return fallback;
  }
  return Math.min(100, Math.max(0, Math.round(raw)));
}

export function normalizeAuroraSettings(raw: unknown): AuroraSettingsState {
  const defaults = createDefaultAuroraSettings();
  if (!raw || typeof raw !== "object") {
    return defaults;
  }
  const record = raw as Partial<AuroraSettingsState>;
  const customColors = Array.isArray(record.customColors)
    ? record.customColors
        .filter((value): value is string => typeof value === "string" && HEX_COLOR_RE.test(value.trim()))
        .map((value) => value.trim().toLowerCase())
        .slice(0, AURORA_MAX_CUSTOM_COLORS)
    : defaults.customColors;
  return {
    enabled: typeof record.enabled === "boolean" ? record.enabled : defaults.enabled,
    preset: isAuroraPresetId(record.preset) ? record.preset : defaults.preset,
    placement: isAuroraPlacementId(record.placement) ? record.placement : defaults.placement,
    intensity: clampPercent(record.intensity, defaults.intensity),
    speed: clampPercent(record.speed, defaults.speed),
    reactToActivity:
      typeof record.reactToActivity === "boolean"
        ? record.reactToActivity
        : defaults.reactToActivity,
    customColors:
      customColors.length >= AURORA_MIN_CUSTOM_COLORS ? customColors : defaults.customColors,
  };
}
