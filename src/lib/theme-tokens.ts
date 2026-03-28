/**
 * Semantic UI tokens mirrored from [globals.css](src/app/globals.css).
 * Runtime themes merge partials onto defaults and set them on `document.documentElement`.
 */

export type ThemeTokens = {
  "--background": string;
  "--foreground": string;
  "--bg-main": string;
  "--bg-panel": string;
  "--bg-card": string;
  "--bg-card-hover": string;
  "--bg-tab-active": string;
  "--bg-tab-inactive": string;
  "--border-card": string;
  "--border-subtle": string;
  "--text-primary": string;
  "--text-secondary": string;
  "--text-disabled": string;
  "--accent": string;
  "--accent-dark": string;
  "--accent-bg": string;
  "--plan-accent": string;
  "--plan-accent-dark": string;
  "--plan-accent-bg": string;
  "--plan-accent-selected-bg": string;
  "--plan-accent-selected-border": string;
  "--plan-accent-label": string;
  "--plan-accent-label-strong": string;
  "--debug-accent": string;
  "--debug-accent-dark": string;
  "--debug-accent-bg": string;
  "--ask-accent": string;
  "--ask-accent-dark": string;
  "--ask-accent-bg": string;
  "--file-tag-bg": string;
  "--file-tag-text": string;
  "--file-tag-icon": string;
  "--radius-card": string;
  "--radius-tab": string;
  "--radius-pill": string;
  "--radius-checkbox": string;
  "--font-size-body": string;
  "--font-size-small": string;
  "--font-size-meta": string;
  "--sidebar-width": string;
  "--chat-width": string;
  "--tab-height": string;
  "--palette-surface": string;
  "--palette-border": string;
  "--palette-divider": string;
  "--palette-input-text": string;
  "--palette-placeholder": string;
  "--palette-footer-text": string;
  "--palette-kbd-bg": string;
  "--palette-kbd-border": string;
  "--palette-kbd-text": string;
  "--palette-row-text": string;
  "--palette-row-muted": string;
  "--palette-row-selected-bg": string;
  "--palette-row-selected-text": string;
  "--palette-row-selected-muted": string;
  "--palette-keybinding-on-selected": string;
  "--palette-keybinding-idle": string;
  "--palette-backdrop": string;
  "--palette-shadow": string;
  "--palette-icon-json": string;
  "--palette-icon-md": string;
  "--palette-icon-css": string;
  "--palette-icon-ts": string;
  "--palette-icon-fallback": string;
};

const TOKEN_KEYS = [
  "--background",
  "--foreground",
  "--bg-main",
  "--bg-panel",
  "--bg-card",
  "--bg-card-hover",
  "--bg-tab-active",
  "--bg-tab-inactive",
  "--border-card",
  "--border-subtle",
  "--text-primary",
  "--text-secondary",
  "--text-disabled",
  "--accent",
  "--accent-dark",
  "--accent-bg",
  "--plan-accent",
  "--plan-accent-dark",
  "--plan-accent-bg",
  "--plan-accent-selected-bg",
  "--plan-accent-selected-border",
  "--plan-accent-label",
  "--plan-accent-label-strong",
  "--debug-accent",
  "--debug-accent-dark",
  "--debug-accent-bg",
  "--ask-accent",
  "--ask-accent-dark",
  "--ask-accent-bg",
  "--file-tag-bg",
  "--file-tag-text",
  "--file-tag-icon",
  "--radius-card",
  "--radius-tab",
  "--radius-pill",
  "--radius-checkbox",
  "--font-size-body",
  "--font-size-small",
  "--font-size-meta",
  "--sidebar-width",
  "--chat-width",
  "--tab-height",
  "--palette-surface",
  "--palette-border",
  "--palette-divider",
  "--palette-input-text",
  "--palette-placeholder",
  "--palette-footer-text",
  "--palette-kbd-bg",
  "--palette-kbd-border",
  "--palette-kbd-text",
  "--palette-row-text",
  "--palette-row-muted",
  "--palette-row-selected-bg",
  "--palette-row-selected-text",
  "--palette-row-selected-muted",
  "--palette-keybinding-on-selected",
  "--palette-keybinding-idle",
  "--palette-backdrop",
  "--palette-shadow",
  "--palette-icon-json",
  "--palette-icon-md",
  "--palette-icon-css",
  "--palette-icon-ts",
  "--palette-icon-fallback",
] as const satisfies readonly (keyof ThemeTokens)[];

export type ThemeTokenKey = (typeof TOKEN_KEYS)[number];

/** Grouped labels for the custom theme editor (every key appears once). */
export const THEME_TOKEN_GROUPS: { title: string; keys: ThemeTokenKey[] }[] = [
  {
    title: "Base & surfaces",
    keys: [
      "--background",
      "--foreground",
      "--bg-main",
      "--bg-panel",
      "--bg-card",
      "--bg-card-hover",
      "--bg-tab-active",
      "--bg-tab-inactive",
    ],
  },
  {
    title: "Borders & text",
    keys: [
      "--border-card",
      "--border-subtle",
      "--text-primary",
      "--text-secondary",
      "--text-disabled",
    ],
  },
  {
    title: "Accent & modes",
    keys: [
      "--accent",
      "--accent-dark",
      "--accent-bg",
      "--plan-accent",
      "--plan-accent-dark",
      "--plan-accent-bg",
      "--plan-accent-selected-bg",
      "--plan-accent-selected-border",
      "--plan-accent-label",
      "--plan-accent-label-strong",
      "--debug-accent",
      "--debug-accent-dark",
      "--debug-accent-bg",
      "--ask-accent",
      "--ask-accent-dark",
      "--ask-accent-bg",
    ],
  },
  {
    title: "File tags & layout",
    keys: [
      "--file-tag-bg",
      "--file-tag-text",
      "--file-tag-icon",
      "--radius-card",
      "--radius-tab",
      "--radius-pill",
      "--radius-checkbox",
      "--font-size-body",
      "--font-size-small",
      "--font-size-meta",
      "--sidebar-width",
      "--chat-width",
      "--tab-height",
    ],
  },
  {
    title: "Command palette",
    keys: [
      "--palette-surface",
      "--palette-border",
      "--palette-divider",
      "--palette-input-text",
      "--palette-placeholder",
      "--palette-footer-text",
      "--palette-kbd-bg",
      "--palette-kbd-border",
      "--palette-kbd-text",
      "--palette-row-text",
      "--palette-row-muted",
      "--palette-row-selected-bg",
      "--palette-row-selected-text",
      "--palette-row-selected-muted",
      "--palette-keybinding-on-selected",
      "--palette-keybinding-idle",
      "--palette-backdrop",
      "--palette-shadow",
      "--palette-icon-json",
      "--palette-icon-md",
      "--palette-icon-css",
      "--palette-icon-ts",
      "--palette-icon-fallback",
    ],
  },
];

/** Light branch defaults (`:root` in globals.css, `var()` references resolved). */
export const DEFAULT_THEME_TOKENS_LIGHT: ThemeTokens = {
  "--background": "#fafafa",
  "--foreground": "#0a0a0a",
  "--bg-main": "#fafafa",
  "--bg-panel": "#f0f0f0",
  "--bg-card": "#e6e6e6",
  "--bg-card-hover": "#dcdcdc",
  "--bg-tab-active": "#fafafa",
  "--bg-tab-inactive": "rgba(250, 250, 250, 0.35)",
  "--border-card": "#c4c4c4",
  "--border-subtle": "#e2e2e2",
  "--text-primary": "#1a1a1a",
  "--text-secondary": "#5c5c5c",
  "--text-disabled": "#9a9a9a",
  "--accent": "#1a1a1a",
  "--accent-dark": "#333333",
  "--accent-bg": "rgba(0, 0, 0, 0.08)",
  "--plan-accent": "#9a7f1a",
  "--plan-accent-dark": "#7d6615",
  "--plan-accent-bg": "#ebe4d0",
  "--plan-accent-selected-bg": "rgba(154, 127, 26, 0.14)",
  "--plan-accent-selected-border": "rgba(154, 127, 26, 0.35)",
  "--plan-accent-label": "rgba(90, 74, 18, 0.85)",
  "--plan-accent-label-strong": "rgba(50, 42, 10, 0.95)",
  "--debug-accent": "#b84d55",
  "--debug-accent-dark": "#8a3a40",
  "--debug-accent-bg": "#f0dedf",
  "--ask-accent": "#3d6b4d",
  "--ask-accent-dark": "#2f523c",
  "--ask-accent-bg": "#dfe8e2",
  "--file-tag-bg": "#c9dcf5",
  "--file-tag-text": "#1a2d4d",
  "--file-tag-icon": "#3d5a8a",
  "--radius-card": "10px",
  "--radius-tab": "5px",
  "--radius-pill": "50px",
  "--radius-checkbox": "2px",
  "--font-size-body": "14px",
  "--font-size-small": "10.5px",
  "--font-size-meta": "11.9px",
  "--sidebar-width": "290px",
  "--chat-width": "550px",
  "--tab-height": "40px",
  "--palette-surface": "#ffffff",
  "--palette-border": "#c4c4c4",
  "--palette-divider": "#e2e2e2",
  "--palette-input-text": "#1a1a1a",
  "--palette-placeholder": "#9a9a9a",
  "--palette-footer-text": "#5c5c5c",
  "--palette-kbd-bg": "#f0f0f0",
  "--palette-kbd-border": "#c4c4c4",
  "--palette-kbd-text": "#1a1a1a",
  "--palette-row-text": "#1a1a1a",
  "--palette-row-muted": "#5c5c5c",
  "--palette-row-selected-bg": "#d6ebff",
  "--palette-row-selected-text": "#1a1a1a",
  "--palette-row-selected-muted": "rgba(26, 26, 26, 0.55)",
  "--palette-keybinding-on-selected": "#0b5cab",
  "--palette-keybinding-idle": "#5c5c5c",
  "--palette-backdrop": "rgba(10, 10, 10, 0.38)",
  "--palette-shadow": "0 16px 48px rgba(0, 0, 0, 0.14)",
  "--palette-icon-json": "#7a6410",
  "--palette-icon-md": "#0b7285",
  "--palette-icon-css": "#5c5c5c",
  "--palette-icon-ts": "#1565c0",
  "--palette-icon-fallback": "#6b6b6b",
} satisfies ThemeTokens;

/** Dark branch defaults (`html.dark` in globals.css, `var()` references resolved). */
export const DEFAULT_THEME_TOKENS_DARK: ThemeTokens = {
  "--background": "#191919",
  "--foreground": "#ffffff",
  "--bg-main": "#191919",
  "--bg-panel": "#1e1e1e",
  "--bg-card": "#393939",
  "--bg-card-hover": "#404040",
  "--bg-tab-active": "#191919",
  "--bg-tab-inactive": "rgba(25, 25, 25, 0.25)",
  "--border-card": "#505050",
  "--border-subtle": "#2a2a2a",
  "--text-primary": "#ffffff",
  "--text-secondary": "#6f6f6f",
  "--text-disabled": "#5b5b5b",
  "--accent": "#ffffff",
  "--accent-dark": "#e8e8e8",
  "--accent-bg": "rgba(255, 255, 255, 0.1)",
  "--plan-accent": "#c2a738",
  "--plan-accent-dark": "#b79e38",
  "--plan-accent-bg": "#494639",
  "--plan-accent-selected-bg": "rgba(194, 167, 56, 0.16)",
  "--plan-accent-selected-border": "rgba(194, 167, 56, 0.42)",
  "--plan-accent-label": "rgba(220, 200, 120, 0.78)",
  "--plan-accent-label-strong": "rgba(232, 210, 130, 0.92)",
  "--debug-accent": "#e59a9a",
  "--debug-accent-dark": "#9b585e",
  "--debug-accent-bg": "#3a2a2a",
  "--ask-accent": "#5e8d6b",
  "--ask-accent-dark": "#456b52",
  "--ask-accent-bg": "#2a322e",
  "--file-tag-bg": "#2a4a7a",
  "--file-tag-text": "#e8f0ff",
  "--file-tag-icon": "#93b4e8",
  "--radius-card": "10px",
  "--radius-tab": "5px",
  "--radius-pill": "50px",
  "--radius-checkbox": "2px",
  "--font-size-body": "14px",
  "--font-size-small": "10.5px",
  "--font-size-meta": "11.9px",
  "--sidebar-width": "290px",
  "--chat-width": "550px",
  "--tab-height": "40px",
  "--palette-surface": "#252526",
  "--palette-border": "#3c3c3c",
  "--palette-divider": "#2a2a2a",
  "--palette-input-text": "#cccccc",
  "--palette-placeholder": "#767676",
  "--palette-footer-text": "#969696",
  "--palette-kbd-bg": "#1e1e1e",
  "--palette-kbd-border": "#3c3c3c",
  "--palette-kbd-text": "#cccccc",
  "--palette-row-text": "#cccccc",
  "--palette-row-muted": "#767676",
  "--palette-row-selected-bg": "#04395e",
  "--palette-row-selected-text": "#ffffff",
  "--palette-row-selected-muted": "rgba(255, 255, 255, 0.62)",
  "--palette-keybinding-on-selected": "#9dc3e6",
  "--palette-keybinding-idle": "#767676",
  "--palette-backdrop": "rgba(0, 0, 0, 0.5)",
  "--palette-shadow": "0 16px 48px rgba(0, 0, 0, 0.55)",
  "--palette-icon-json": "#cbcb41",
  "--palette-icon-md": "#6fb3d2",
  "--palette-icon-css": "#d4d4d4",
  "--palette-icon-ts": "#519aba",
  "--palette-icon-fallback": "#7f7f7f",
} satisfies ThemeTokens;

export type ThemeTokensPartial = Partial<ThemeTokens>;

export function mergeThemeTokens(
  base: ThemeTokens,
  ...partials: ThemeTokensPartial[]
): ThemeTokens {
  let out: ThemeTokens = { ...base };
  for (const p of partials) {
    for (const key of TOKEN_KEYS) {
      const v = p[key];
      if (v !== undefined && v.trim() !== "") {
        out = { ...out, [key]: v } as ThemeTokens;
      }
    }
  }
  return out;
}

/** Strip unknown keys and invalid entries from imported partials. */
export function sanitizeThemeTokensPartial(raw: unknown): ThemeTokensPartial {
  if (!raw || typeof raw !== "object") {
    return {};
  }
  const o = raw as Record<string, unknown>;
  const out: ThemeTokensPartial = {};
  for (const key of TOKEN_KEYS) {
    const v = o[key];
    if (typeof v === "string" && v.trim() !== "") {
      out[key] = v.trim();
    }
  }
  return out;
}
