import type { ThemeTokens } from "./theme-tokens";

export type Design2ModeTone =
  | "agent"
  | "plan"
  | "debug"
  | "ask"
  | "goal"
  | "workflow"
  | "orchestration";

export type Design2ModeRecipe = {
  label: string;
  icon: "infinity" | "list-checks" | "bug" | "message-circle-question" | "flame" | "workflow" | "boxes";
  textToken: string;
  backgroundToken: string;
  sendToken: string;
  hiddenWhenDefault: boolean;
};

export const DESIGN_2_MODE_RECIPES: Record<Design2ModeTone, Design2ModeRecipe> = {
  agent: {
    label: "Agent",
    icon: "infinity",
    textToken: "--accent",
    backgroundToken: "--accent-bg",
    sendToken: "--accent-dark",
    hiddenWhenDefault: true,
  },
  plan: {
    label: "Plan",
    icon: "list-checks",
    textToken: "--plan-accent",
    backgroundToken: "--plan-accent-bg",
    sendToken: "--plan-accent-dark",
    hiddenWhenDefault: false,
  },
  debug: {
    label: "Debug",
    icon: "bug",
    textToken: "--debug-accent",
    backgroundToken: "--debug-accent-bg",
    sendToken: "--debug-accent-dark",
    hiddenWhenDefault: false,
  },
  ask: {
    label: "Ask",
    icon: "message-circle-question",
    textToken: "--ask-accent",
    backgroundToken: "--ask-accent-bg",
    sendToken: "--ask-accent-dark",
    hiddenWhenDefault: false,
  },
  goal: {
    label: "Goal",
    icon: "flame",
    textToken: "--goal-accent",
    backgroundToken: "--goal-accent-bg",
    sendToken: "--goal-accent-dark",
    hiddenWhenDefault: false,
  },
  workflow: {
    label: "Workflow",
    icon: "workflow",
    textToken: "--workflow-accent",
    backgroundToken: "--workflow-accent-bg",
    sendToken: "--workflow-accent-dark",
    hiddenWhenDefault: false,
  },
  orchestration: {
    label: "Orchestration",
    icon: "boxes",
    textToken: "--orchestration-accent",
    backgroundToken: "--orchestration-accent-bg",
    sendToken: "--orchestration-accent-dark",
    hiddenWhenDefault: false,
  },
};

const COMPOSER_PADDING = 10;
const COMPOSER_BORDER_WIDTH = 1;
/**
 * Attach (+), send, stop, and voice controls share one diameter. 24px keeps
 * the collapsed capsule compact while giving comfortable touch targets.
 */
const COMPOSER_CONTROL_SIZE = 24;
/**
 * Corner radius for the composer shell once it grows past one line. The
 * single-line capsule renders `rounded-full`, whose visible corner radius is
 * half the collapsed shell height (padding + tallest control + border), so
 * multi-line shells reuse that exact value instead of snapping to the sharper
 * card radius.
 */
const COMPOSER_SHELL_RADIUS =
  COMPOSER_PADDING + COMPOSER_CONTROL_SIZE / 2 + COMPOSER_BORDER_WIDTH;

export const DESIGN_2_RECIPES = {
  composer: {
    placeholder: "Ask anything, @ for files, / for commands",
    compactPlaceholder: "Ask anything, @ for files…",
    modePlaceholder: "Ask anything…",
    padding: COMPOSER_PADDING,
    gap: 10,
    stackedGap: 8,
    plusSize: COMPOSER_CONTROL_SIZE,
    plusIconSize: 14,
    sendSize: COMPOSER_CONTROL_SIZE,
    sendIconSize: 14,
    sendIconStrokeWidth: 2.5,
    modeChipHeight: 22,
    modeChipPaddingLeft: 7,
    modeChipPaddingRight: 4,
    modeChipGap: 3,
    singleLineRadius: 999,
    multilineRadius: COMPOSER_SHELL_RADIUS,
    borderWidth: COMPOSER_BORDER_WIDTH,
    lineHeight: 20,
    multilineThreshold: 30,
    maxHeight: 240,
  },
  cards: {
    radius: 10,
    borderWidth: 1,
    padding: 10,
  },
  rail: {
    toolbarButtonSize: 18,
    toolbarIconSize: 16,
    toolbarGap: 8,
    rowHeight: 30,
    rowHorizontalPadding: 9,
    footerHorizontalPadding: 11,
    footerVerticalPadding: 10,
    footerGap: 8,
    footerControlSize: 18,
  },
  landing: {
    contentMaxWidth: 876,
    edgeGutter: 28,
    contextGap: 6,
    contextHorizontalPadding: 6,
    contextVerticalPadding: 4,
    quickActionGap: 10,
    quickActionHorizontalPadding: 14,
    quickActionVerticalPadding: 7,
  },
} as const;

export const DESIGN_2_SURFACE_ALIASES = {
  common: {
    "--agent-content-max-width": "876px",
    "--agent-content-edge-gutter": "28px",
    "--agent-panel-bg": "var(--bg-panel)",
    "--agent-card-bg": "var(--bg-card)",
    "--agent-card-hover-bg": "var(--bg-card-hover)",
    "--agent-border": "var(--border-card)",
    "--agent-composer-radius": `${COMPOSER_SHELL_RADIUS}px`,
    "--agent-card-radius": "var(--radius-card)",
    "--agent-control-radius": "var(--radius-tab)",
    "--agent-pill-radius": "var(--radius-pill)",
    "--agent-rail-row-height": "30px",
    "--d2-composer-plus-size": `${COMPOSER_CONTROL_SIZE}px`,
    "--d2-composer-send-size": `${COMPOSER_CONTROL_SIZE}px`,
    "--d2-card-border-width": "1px",
    "--d2-rail-control-size": "18px",
  },
  light: {
    // Derived from surface/text tokens so non-default light presets (sepia,
    // sakura, …) tint the control instead of getting a fixed neutral gray.
    "--agent-plus-button-bg": "color-mix(in srgb, var(--text-primary) 6%, var(--bg-main) 94%)",
    "--agent-plus-button-bg-hover": "color-mix(in srgb, var(--text-primary) 11%, var(--bg-main) 89%)",
    "--agent-plus-button-icon": "var(--text-secondary)",
    "--tab-agent-attention-dot": "color-mix(in srgb, var(--plan-accent) 68%, #737373 32%)",
    "--tab-unread-completion-dot": "#4a76a8",
  },
  dark: {
    "--agent-plus-button-bg": "color-mix(in srgb, var(--text-primary) 11%, var(--bg-main) 89%)",
    "--agent-plus-button-bg-hover": "color-mix(in srgb, var(--text-primary) 16%, var(--bg-main) 84%)",
    "--agent-plus-button-icon": "var(--text-secondary)",
    "--tab-agent-attention-dot": "color-mix(in srgb, var(--plan-accent) 38%, var(--bg-panel) 62%)",
    "--tab-unread-completion-dot": "#6b9fd4",
  },
} as const;

export type Design2SurfaceAliasKey =
  | keyof typeof DESIGN_2_SURFACE_ALIASES.common
  | keyof typeof DESIGN_2_SURFACE_ALIASES.light
  | keyof typeof DESIGN_2_SURFACE_ALIASES.dark;

export type Design2ThemeTokens = ThemeTokens &
  Record<Design2SurfaceAliasKey, string>;

export function resolveDesign2ThemeTokens(
  tokens: ThemeTokens,
  scheme: "light" | "dark"
): Design2ThemeTokens {
  return {
    ...tokens,
    ...DESIGN_2_SURFACE_ALIASES.common,
    ...DESIGN_2_SURFACE_ALIASES[scheme],
  };
}

export function resolveDesign2ModeTone(mode: string): Design2ModeTone {
  const normalized = mode.trim().toLowerCase();
  if (normalized in DESIGN_2_MODE_RECIPES) {
    return normalized as Design2ModeTone;
  }
  return "agent";
}

export function resolveDesign2ComposerLayout(input: {
  measuredMultiline: boolean;
  latchedMultiline: boolean;
  hasAttachments: boolean;
  value: string;
}): {
  multiline: boolean;
  radius: number;
} {
  const effectivelyEmpty = input.value.length === 0;
  const multiline =
    input.hasAttachments ||
    (!effectivelyEmpty && (input.measuredMultiline || input.latchedMultiline));
  return {
    multiline,
    radius: multiline
      ? DESIGN_2_RECIPES.composer.multilineRadius
      : DESIGN_2_RECIPES.composer.singleLineRadius,
  };
}

export function isComposerEffectivelyEmptyForMultiline(
  value: string,
  measuredMultiline: boolean
): boolean {
  if (value.length === 0) return true;
  if (value.trim().length > 0) return false;
  return !measuredMultiline;
}

export function shouldLatchComposerMultiline(
  value: string,
  measuredMultiline: boolean
): boolean {
  return (
    measuredMultiline &&
    !isComposerEffectivelyEmptyForMultiline(value, measuredMultiline)
  );
}

export function resolveComposerIsMultiLine(options: {
  forceMultiline?: boolean;
  useStickyMultiline: boolean;
  hookMeasuresMultiline: boolean;
  latchedMultiline: boolean;
  value: string;
}): boolean {
  if (options.forceMultiline) return true;
  if (!options.useStickyMultiline) return options.hookMeasuresMultiline;
  if (
    isComposerEffectivelyEmptyForMultiline(
      options.value,
      options.hookMeasuresMultiline
    )
  ) {
    return false;
  }
  return options.latchedMultiline || options.hookMeasuresMultiline;
}
