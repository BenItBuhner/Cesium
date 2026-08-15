export const AURORA_INTENSITY_MIN = 0;
export const AURORA_INTENSITY_MAX = 100;
export const AURORA_INTENSITY_DEFAULT = 32;
export const AURORA_SPEED_MIN = 0;
export const AURORA_SPEED_MAX = 100;
export const AURORA_SPEED_DEFAULT = 38;
export const AURORA_BLUR_MIN = 0;
export const AURORA_BLUR_MAX = 100;
export const AURORA_BLUR_DEFAULT = 64;

export const AURORA_PRESET_IDS = [
  "borealis",
  "australis",
  "arctic",
  "dusk",
  "nebula",
  "monochrome",
  "custom",
] as const;

export type AuroraPresetId = (typeof AURORA_PRESET_IDS)[number];

export type AuroraConversationState =
  | "new"
  | "idle"
  | "typing"
  | "working"
  | "awaiting"
  | "completed"
  | "failed"
  | "paused"
  | "cancelled";

export const AURORA_CONVERSATION_STATES: AuroraConversationState[] = [
  "new",
  "idle",
  "typing",
  "working",
  "awaiting",
  "completed",
  "failed",
  "paused",
  "cancelled",
];

export type AuroraRgb = readonly [number, number, number];

export type AuroraPresetDefinition = {
  id: Exclude<AuroraPresetId, "custom">;
  label: string;
  description: string;
  dark: readonly [AuroraRgb, AuroraRgb, AuroraRgb];
  light: readonly [AuroraRgb, AuroraRgb, AuroraRgb];
};

const rgb = (r: number, g: number, b: number): AuroraRgb => [r, g, b];

export const AURORA_PRESETS: Record<
  Exclude<AuroraPresetId, "custom">,
  AuroraPresetDefinition
> = {
  borealis: {
    id: "borealis",
    label: "Borealis",
    description: "Classic northern lights — mint, ice, and violet.",
    dark: [rgb(56, 230, 176), rgb(72, 176, 255), rgb(168, 132, 255)],
    light: [rgb(16, 168, 128), rgb(14, 116, 196), rgb(124, 88, 220)],
  },
  australis: {
    id: "australis",
    label: "Australis",
    description: "Southern sky — rose, magenta, and teal.",
    dark: [rgb(255, 118, 168), rgb(186, 120, 255), rgb(64, 214, 220)],
    light: [rgb(214, 64, 122), rgb(148, 72, 214), rgb(14, 148, 156)],
  },
  arctic: {
    id: "arctic",
    label: "Arctic",
    description: "Cold ice field — cyan, frost, and pale blue.",
    dark: [rgb(96, 214, 255), rgb(164, 236, 255), rgb(186, 210, 255)],
    light: [rgb(14, 140, 196), rgb(56, 168, 196), rgb(88, 124, 196)],
  },
  dusk: {
    id: "dusk",
    label: "Dusk",
    description: "Warm evening wash — amber, rose, and violet.",
    dark: [rgb(255, 176, 72), rgb(255, 128, 176), rgb(168, 112, 255)],
    light: [rgb(196, 112, 16), rgb(196, 64, 112), rgb(124, 72, 196)],
  },
  nebula: {
    id: "nebula",
    label: "Nebula",
    description: "Deep space — orchid, pink, and indigo.",
    dark: [rgb(196, 132, 255), rgb(255, 148, 220), rgb(112, 140, 255)],
    light: [rgb(140, 72, 214), rgb(196, 64, 156), rgb(72, 88, 214)],
  },
  monochrome: {
    id: "monochrome",
    label: "Monochrome",
    description: "Quiet silver mist that follows the theme.",
    dark: [rgb(210, 220, 232), rgb(164, 180, 198), rgb(120, 138, 160)],
    light: [rgb(92, 104, 120), rgb(128, 140, 156), rgb(72, 84, 100)],
  },
};

export const DEFAULT_AURORA_CUSTOM_COLORS: readonly [AuroraRgb, AuroraRgb, AuroraRgb] = [
  rgb(56, 230, 176),
  rgb(72, 176, 255),
  rgb(168, 132, 255),
];

export type AuroraConfig = {
  enabled: boolean;
  presetId: AuroraPresetId;
  intensity: number;
  speed: number;
  blur: number;
  reactToState: boolean;
  customColors: [AuroraRgb, AuroraRgb, AuroraRgb];
};

export function createDefaultAuroraConfig(): AuroraConfig {
  return {
    enabled: true,
    presetId: "borealis",
    intensity: AURORA_INTENSITY_DEFAULT,
    speed: AURORA_SPEED_DEFAULT,
    blur: AURORA_BLUR_DEFAULT,
    reactToState: true,
    customColors: [
      DEFAULT_AURORA_CUSTOM_COLORS[0],
      DEFAULT_AURORA_CUSTOM_COLORS[1],
      DEFAULT_AURORA_CUSTOM_COLORS[2],
    ],
  };
}

export function isAuroraPresetId(value: unknown): value is AuroraPresetId {
  return typeof value === "string" && (AURORA_PRESET_IDS as readonly string[]).includes(value);
}

export function isAuroraConversationState(value: unknown): value is AuroraConversationState {
  return (
    typeof value === "string" &&
    (AURORA_CONVERSATION_STATES as readonly string[]).includes(value)
  );
}

function clampInt(raw: unknown, min: number, max: number, fallback: number): number {
  const n =
    typeof raw === "number" && Number.isFinite(raw)
      ? Math.round(raw)
      : fallback;
  return Math.min(max, Math.max(min, n));
}

function sanitizeChannel(raw: unknown): number | null {
  if (typeof raw !== "number" || !Number.isFinite(raw)) {
    return null;
  }
  return Math.min(255, Math.max(0, Math.round(raw)));
}

export function sanitizeAuroraRgb(raw: unknown, fallback: AuroraRgb): AuroraRgb {
  if (Array.isArray(raw) && raw.length >= 3) {
    const r = sanitizeChannel(raw[0]);
    const g = sanitizeChannel(raw[1]);
    const b = sanitizeChannel(raw[2]);
    if (r != null && g != null && b != null) {
      return [r, g, b];
    }
  }
  if (typeof raw === "string") {
    const parsed = parseAuroraHex(raw);
    if (parsed) {
      return parsed;
    }
  }
  return fallback;
}

export function parseAuroraHex(value: string): AuroraRgb | null {
  const hex = value.trim().replace(/^#/, "");
  if (!/^[0-9a-fA-F]{6}$/.test(hex)) {
    return null;
  }
  return [
    Number.parseInt(hex.slice(0, 2), 16),
    Number.parseInt(hex.slice(2, 4), 16),
    Number.parseInt(hex.slice(4, 6), 16),
  ];
}

export function auroraRgbToHex(color: AuroraRgb): string {
  return `#${color
    .map((channel) => channel.toString(16).padStart(2, "0"))
    .join("")}`;
}

export function auroraRgbToCss(color: AuroraRgb, alpha = 1): string {
  const a = Math.min(1, Math.max(0, alpha));
  return `rgba(${color[0]}, ${color[1]}, ${color[2]}, ${a})`;
}

export function sanitizeAuroraCustomColors(
  raw: unknown
): [AuroraRgb, AuroraRgb, AuroraRgb] {
  const source = Array.isArray(raw) ? raw : [];
  return [
    sanitizeAuroraRgb(source[0], DEFAULT_AURORA_CUSTOM_COLORS[0]),
    sanitizeAuroraRgb(source[1], DEFAULT_AURORA_CUSTOM_COLORS[1]),
    sanitizeAuroraRgb(source[2], DEFAULT_AURORA_CUSTOM_COLORS[2]),
  ];
}

export function resolveAuroraPresetColors(
  config: AuroraConfig,
  dark: boolean
): readonly [AuroraRgb, AuroraRgb, AuroraRgb] {
  if (config.presetId === "custom") {
    return config.customColors;
  }
  const preset = AURORA_PRESETS[config.presetId];
  return dark ? preset.dark : preset.light;
}

export function normalizeAuroraConfig(raw: unknown): AuroraConfig {
  const base = createDefaultAuroraConfig();
  if (!raw || typeof raw !== "object") {
    return base;
  }
  const r = raw as Record<string, unknown>;
  return {
    enabled: typeof r.enabled === "boolean" ? r.enabled : base.enabled,
    presetId: isAuroraPresetId(r.presetId) ? r.presetId : base.presetId,
    intensity: clampInt(
      r.intensity,
      AURORA_INTENSITY_MIN,
      AURORA_INTENSITY_MAX,
      base.intensity
    ),
    speed: clampInt(r.speed, AURORA_SPEED_MIN, AURORA_SPEED_MAX, base.speed),
    blur: clampInt(r.blur, AURORA_BLUR_MIN, AURORA_BLUR_MAX, base.blur),
    reactToState: typeof r.reactToState === "boolean" ? r.reactToState : base.reactToState,
    customColors: sanitizeAuroraCustomColors(r.customColors),
  };
}
