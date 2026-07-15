/**
 * Structured design tokens derived from the canonical CSS-variable defaults in
 * [theme-tokens.ts](./theme-tokens.ts). This is the RN/NativeWind-friendly
 * shape; the values are literally the same strings the web theme resolves to,
 * so there is a single source of truth and zero drift.
 */
import {
  DEFAULT_THEME_TOKENS_DARK,
  DEFAULT_THEME_TOKENS_LIGHT,
  type ThemeTokens,
} from "./theme-tokens";

export type ColorToken =
  | "background"
  | "foreground"
  | "bgMain"
  | "bgPanel"
  | "bgCard"
  | "bgCardHover"
  | "borderCard"
  | "borderSubtle"
  | "textPrimary"
  | "textSecondary"
  | "textDisabled"
  | "accent"
  | "accentDark"
  | "accentBg"
  | "planAccent"
  | "debugAccent"
  | "askAccent";

export type RadiusToken = "card" | "tab" | "pill" | "checkbox";
export type FontSizeToken = "body" | "small" | "meta";

export type CesiumDesignTokens = {
  color: Record<ColorToken, string>;
  radius: Record<RadiusToken, string>;
  fontSize: Record<FontSizeToken, string>;
  layout: {
    sidebarWidth: string;
    chatWidth: string;
    tabHeight: string;
  };
};

function fromThemeTokens(tokens: ThemeTokens): CesiumDesignTokens {
  return {
    color: {
      background: tokens["--background"],
      foreground: tokens["--foreground"],
      bgMain: tokens["--bg-main"],
      bgPanel: tokens["--bg-panel"],
      bgCard: tokens["--bg-card"],
      bgCardHover: tokens["--bg-card-hover"],
      borderCard: tokens["--border-card"],
      borderSubtle: tokens["--border-subtle"],
      textPrimary: tokens["--text-primary"],
      textSecondary: tokens["--text-secondary"],
      textDisabled: tokens["--text-disabled"],
      accent: tokens["--accent"],
      accentDark: tokens["--accent-dark"],
      accentBg: tokens["--accent-bg"],
      planAccent: tokens["--plan-accent"],
      debugAccent: tokens["--debug-accent"],
      askAccent: tokens["--ask-accent"],
    },
    radius: {
      card: tokens["--radius-card"],
      tab: tokens["--radius-tab"],
      pill: tokens["--radius-pill"],
      checkbox: tokens["--radius-checkbox"],
    },
    fontSize: {
      body: tokens["--font-size-body"],
      small: tokens["--font-size-small"],
      meta: tokens["--font-size-meta"],
    },
    layout: {
      sidebarWidth: tokens["--sidebar-width"],
      chatWidth: tokens["--chat-width"],
      tabHeight: tokens["--tab-height"],
    },
  };
}

export const lightTokens: CesiumDesignTokens = fromThemeTokens(
  DEFAULT_THEME_TOKENS_LIGHT
);

export const darkTokens: CesiumDesignTokens = fromThemeTokens(
  DEFAULT_THEME_TOKENS_DARK
);

export type ColorScheme = "light" | "dark";

export function getTokens(scheme: ColorScheme): CesiumDesignTokens {
  return scheme === "dark" ? darkTokens : lightTokens;
}
