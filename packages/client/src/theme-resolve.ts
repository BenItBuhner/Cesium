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
  CURRENT_DESIGN_LANGUAGE_ID,
  DESIGN_LANGUAGE_PACKS,
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
 * Active design-language pack for the default builtin theme only.
 * Other themes keep full ownership of their surface tokens.
 */
function designLanguageOverlayForTheme(
  themeId: string,
  resolvedDark: boolean
): ThemeTokensPartial {
  if (themeId !== DEFAULT_BUILTIN_THEME_ID) {
    return {};
  }
  const pack = DESIGN_LANGUAGE_PACKS[CURRENT_DESIGN_LANGUAGE_ID];
  return resolvedDark ? pack.dark : pack.light;
}

export function resolveMergedTokens(
  config: ThemeConfig,
  resolvedDark: boolean
): ThemeTokens {
  const base = resolvedDark ? DEFAULT_THEME_TOKENS_DARK : DEFAULT_THEME_TOKENS_LIGHT;
  const themeId = resolveActiveThemeId(config, resolvedDark);
  const partial = partialForThemeId(themeId, resolvedDark, config.customThemes);
  const designOverlay = designLanguageOverlayForTheme(themeId, resolvedDark);
  return mergeThemeTokens(base, designOverlay, partial);
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
