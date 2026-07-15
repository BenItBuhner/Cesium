/**
 * Canonical theme tokens now live in @cesium/design (single token source for
 * web CSS and native token objects). This shim keeps the historical
 * `@cesium/client` export surface stable.
 */
export {
  THEME_TOKEN_GROUPS,
  DEFAULT_THEME_TOKENS_LIGHT,
  DEFAULT_THEME_TOKENS_DARK,
  mergeThemeTokens,
  sanitizeThemeTokensPartial,
  type ThemeTokens,
  type ThemeTokenKey,
  type ThemeTokensPartial,
} from "@cesium/design";
