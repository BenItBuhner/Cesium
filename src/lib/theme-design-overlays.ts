import type { ThemeTokensPartial } from "@/lib/theme-tokens";

/**
 * Cursor 3.1 "New Design" palette overlay when `uiDesignMode === "new"` and the
 * active theme id is `default` (builtin).
 *
 * Dark and light each define surface/border tokens only; accents and semantic
 * mode colors stay on the classic palette for that color scheme.
 */
export const NEW_DESIGN_DEFAULT_DARK_OVERLAY: ThemeTokensPartial = {
  "--background": "#141414",
  "--bg-main": "#141414",
  "--bg-panel": "#141414",
  "--bg-card": "#212121",
  "--bg-card-hover": "#2a2a2a",
  "--bg-tab-active": "#141414",
  "--bg-tab-inactive": "rgba(20, 20, 20, 0.35)",
  "--border-card": "#383838",
  "--border-subtle": "#242424",
};

/** Light: Cursor 3.1 surfaces (default builtin theme + `uiDesignMode === "new"` only). */
export const NEW_DESIGN_DEFAULT_LIGHT_OVERLAY: ThemeTokensPartial = {
  "--background": "#f6f6f6",
  "--bg-main": "#f6f6f6",
  "--bg-panel": "#f3f3f3",
  "--bg-card": "#fcfcfc",
  "--bg-card-hover": "#f2f2f2",
  "--bg-tab-active": "#f6f6f6",
  "--bg-tab-inactive": "rgba(246, 246, 246, 0.55)",
  "--border-card": "#eaeaea",
  "--border-subtle": "#eaeaea",
};
