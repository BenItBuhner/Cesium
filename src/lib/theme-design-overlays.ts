import type { ThemeTokensPartial } from "@/lib/theme-tokens";

/**
 * Cursor 3.1 "New Design" palette overlay applied on top of the dark baseline
 * when `uiDesignMode === "new"` and the active theme id is `default`.
 *
 * The overlay only touches surface/border tokens; accents, palette, and mode
 * colors are intentionally left alone so the chip/mode/send semantics carry
 * over unchanged from classic dark.
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

/** Light overlay intentionally empty — new design falls back to classic light. */
export const NEW_DESIGN_DEFAULT_LIGHT_OVERLAY: ThemeTokensPartial = {};
