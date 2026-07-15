import {
  BUILTIN_THEME_CATALOG,
  DEFAULT_BUILTIN_THEME_ID,
} from "./theme-presets";
import type { ThemeConfig, CustomThemeEntry } from "./theme-config";
import type { ThemePreference } from "./theme";
import {
  DEFAULT_THEME_TOKENS_DARK,
  DEFAULT_THEME_TOKENS_LIGHT,
  mergeThemeTokens,
  type ThemeTokens,
  type ThemeTokensPartial,
} from "./theme-tokens";
import {
  NEW_DESIGN_DEFAULT_DARK_OVERLAY,
  NEW_DESIGN_DEFAULT_LIGHT_OVERLAY,
} from "./theme-design-overlays";
import { getClientPlatform } from "./platform";

export function resolveColorSchemeDark(appearance: ThemePreference): boolean {
  if (typeof window === "undefined") {
    return false;
  }
  if (appearance === "dark") {
    return true;
  }
  if (appearance === "light") {
    return false;
  }
  return getClientPlatform().prefersDarkColorScheme();
}

export function resolveActiveThemeId(
  config: ThemeConfig,
  resolvedDark: boolean
): string {
  const id = resolvedDark ? config.darkThemeId : config.lightThemeId;
  return id || DEFAULT_BUILTIN_THEME_ID;
}

function partialForThemeId(
  themeId: string,
  resolvedDark: boolean,
  customThemes: CustomThemeEntry[]
): import("./theme-tokens").ThemeTokensPartial {
  const custom = customThemes.find((t) => t.id === themeId);
  if (custom) {
    return resolvedDark ? custom.dark : custom.light;
  }
  const builtin = BUILTIN_THEME_CATALOG[themeId];
  if (builtin) {
    return resolvedDark ? builtin.dark : builtin.light;
  }
  return {};
}

/**
 * The new-design overlay only applies to the default preset so user-selected
 * themes (builtin or custom) stay untouched when `uiDesignMode === "new"`.
 * Dark and light each carry a Cursor 3.1 surface palette for that mode.
 */
function newDesignOverlayForConfig(
  config: ThemeConfig,
  themeId: string,
  resolvedDark: boolean
): ThemeTokensPartial {
  if (config.uiDesignMode !== "new") {
    return {};
  }
  if (themeId !== DEFAULT_BUILTIN_THEME_ID) {
    return {};
  }
  return resolvedDark
    ? NEW_DESIGN_DEFAULT_DARK_OVERLAY
    : NEW_DESIGN_DEFAULT_LIGHT_OVERLAY;
}

export function resolveMergedTokens(
  config: ThemeConfig,
  resolvedDark: boolean
): ThemeTokens {
  const base = resolvedDark ? DEFAULT_THEME_TOKENS_DARK : DEFAULT_THEME_TOKENS_LIGHT;
  const themeId = resolveActiveThemeId(config, resolvedDark);
  const partial = partialForThemeId(themeId, resolvedDark, config.customThemes);
  const newDesignOverlay = newDesignOverlayForConfig(config, themeId, resolvedDark);
  return mergeThemeTokens(base, newDesignOverlay, partial);
}

/** Remap unknown ids to default so import/config cannot reference missing themes. */
export function normalizeThemeIdForConfig(
  id: string,
  customIds: Set<string>
): string {
  if (!id || !id.trim()) {
    return DEFAULT_BUILTIN_THEME_ID;
  }
  const t = id.trim();
  if (t in BUILTIN_THEME_CATALOG || customIds.has(t)) {
    return t;
  }
  return DEFAULT_BUILTIN_THEME_ID;
}
