import {
  BUILTIN_THEME_CATALOG,
  DEFAULT_BUILTIN_THEME_ID,
} from "@/lib/theme-presets";
import type { ThemeConfig, CustomThemeEntry } from "@/lib/theme-config";
import type { ThemePreference } from "@/lib/theme";
import {
  DEFAULT_THEME_TOKENS_DARK,
  DEFAULT_THEME_TOKENS_LIGHT,
  mergeThemeTokens,
  type ThemeTokens,
} from "@/lib/theme-tokens";

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
  return window.matchMedia("(prefers-color-scheme: dark)").matches;
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
): import("@/lib/theme-tokens").ThemeTokensPartial {
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

export function resolveMergedTokens(
  config: ThemeConfig,
  resolvedDark: boolean
): ThemeTokens {
  const base = resolvedDark ? DEFAULT_THEME_TOKENS_DARK : DEFAULT_THEME_TOKENS_LIGHT;
  const themeId = resolveActiveThemeId(config, resolvedDark);
  const partial = partialForThemeId(themeId, resolvedDark, config.customThemes);
  return mergeThemeTokens(base, partial);
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
