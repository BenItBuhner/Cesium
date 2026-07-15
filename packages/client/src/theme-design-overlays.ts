import type { ThemeTokensPartial } from "./theme-tokens";

/**
 * Modular design-language surface packs.
 *
 * The active language (`CURRENT_DESIGN_LANGUAGE_ID`) is the only shipped UI
 * chrome. Packs stay separate from builtin/custom theme presets so future
 * languages can be added (and optionally selected) without forking component
 * trees or collapsing the theme token system.
 *
 * Packs apply only on the default builtin theme id so user-selected themes
 * (builtin or custom) keep full control of their surface tokens.
 */
export type DesignLanguageId = "2.0";

export type DesignLanguagePack = {
  label: string;
  light: ThemeTokensPartial;
  dark: ThemeTokensPartial;
};

export const DESIGN_LANGUAGE_PACKS: Record<DesignLanguageId, DesignLanguagePack> = {
  "2.0": {
    label: "Design 2.0",
    light: {
      "--background": "#f6f6f6",
      "--bg-main": "#f6f6f6",
      "--bg-panel": "#f3f3f3",
      "--bg-card": "#fcfcfc",
      "--bg-card-hover": "#f2f2f2",
      "--bg-tab-active": "#f6f6f6",
      "--bg-tab-inactive": "rgba(246, 246, 246, 0.55)",
      "--border-card": "#eaeaea",
      "--border-subtle": "#eaeaea",
    },
    dark: {
      "--background": "#141414",
      "--bg-main": "#141414",
      "--bg-panel": "#141414",
      "--bg-card": "#212121",
      "--bg-card-hover": "#2a2a2a",
      "--bg-tab-active": "#141414",
      "--bg-tab-inactive": "rgba(20, 20, 20, 0.35)",
      "--border-card": "#383838",
      "--border-subtle": "#242424",
    },
  },
};

/** Sole active design language. Swap / extend via {@link DESIGN_LANGUAGE_PACKS}. */
export const CURRENT_DESIGN_LANGUAGE_ID: DesignLanguageId = "2.0";

/** @deprecated Use {@link DESIGN_LANGUAGE_PACKS}[`2.0`].dark — kept for import stability. */
export const NEW_DESIGN_DEFAULT_DARK_OVERLAY: ThemeTokensPartial =
  DESIGN_LANGUAGE_PACKS["2.0"].dark;

/** @deprecated Use {@link DESIGN_LANGUAGE_PACKS}[`2.0`].light — kept for import stability. */
export const NEW_DESIGN_DEFAULT_LIGHT_OVERLAY: ThemeTokensPartial =
  DESIGN_LANGUAGE_PACKS["2.0"].light;
