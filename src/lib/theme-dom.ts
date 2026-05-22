import {
  createDefaultThemeConfig,
  type ThemeConfig,
} from "@/lib/theme-config";
import type { ThemePreference } from "@/lib/theme";
import {
  resolveColorSchemeDark,
  resolveMergedTokens,
} from "@/lib/theme-resolve";

/** Apply merged CSS variables + `html.dark` from a full theme config (browser only). */
export function applyThemeConfigToDom(config: ThemeConfig): void {
  if (typeof document === "undefined") {
    return;
  }
  const resolvedDark = resolveColorSchemeDark(config.appearance);
  const tokens = resolveMergedTokens(config, resolvedDark);
  const el = document.documentElement;
  el.classList.toggle("dark", resolvedDark);
  el.style.colorScheme = resolvedDark ? "dark" : "light";
  el.dataset.uiDesign = config.uiDesignMode;
  for (const key of Object.keys(tokens) as (keyof typeof tokens)[]) {
    el.style.setProperty(key, tokens[key]);
  }
}

/**
 * Legacy: appearance only, default built-in themes for both branches.
 * Prefer `applyThemeConfigToDom` when full config is available.
 */
export function applyDomTheme(pref: ThemePreference): void {
  applyThemeConfigToDom({
    ...createDefaultThemeConfig(),
    appearance: pref,
  });
}
