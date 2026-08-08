/**
 * Hover-capable pointer detection for JS-driven hover UI (hover-open flyouts,
 * hover-close timers). Mirrors the `(any-hover: hover) and (any-pointer: fine)`
 * media gate globals.css applies to Tailwind hover styles so JS and CSS agree
 * on when hover interactions exist.
 *
 * On touch-only devices (Android/iOS WebViews included), a tap synthesizes a
 * mouseenter → mousedown → mouseup → click burst. Hover-open UI wired to those
 * synthetic events opens on the mouseenter and is immediately re-toggled or
 * timer-closed by the rest of the burst, so popovers flicker open and shut.
 * Gate any mouseenter/mouseleave open-close logic behind this check.
 */

export const HOVER_CAPABLE_MEDIA_QUERY =
  "(any-hover: hover) and (any-pointer: fine)";

export type HoverCapabilityWindow = {
  matchMedia?: (query: string) => { matches: boolean };
};

export function isHoverCapablePointer(win?: HoverCapabilityWindow): boolean {
  const target =
    win ?? (typeof window === "undefined" ? null : (window as HoverCapabilityWindow));
  // Without a window or matchMedia there is nothing to detect; defaulting to
  // hover-capable preserves classic desktop behavior (tap fallbacks still work).
  if (!target || typeof target.matchMedia !== "function") return true;
  try {
    return target.matchMedia(HOVER_CAPABLE_MEDIA_QUERY).matches === true;
  } catch {
    return true;
  }
}
