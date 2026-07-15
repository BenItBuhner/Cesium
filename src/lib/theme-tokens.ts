// Moved to @cesium/design (packages/design/src/theme-tokens.ts) — the single
// token source for web CSS + native tokens. Re-export shim keeps existing
// imports stable.
export {
  DEFAULT_THEME_TOKENS_DARK,
  DEFAULT_THEME_TOKENS_LIGHT,
  THEME_TOKEN_GROUPS,
  mergeThemeTokens,
  sanitizeThemeTokensPartial,
} from "@cesium/design";
export type {
  ThemeTokenKey,
  ThemeTokens,
  ThemeTokensPartial,
} from "@cesium/design";
