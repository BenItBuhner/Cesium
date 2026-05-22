/** Inset from the chat scrollport’s top edge; must match `StickyChatHeader`’s `top` style. */
export const CHAT_STICKY_RAIL_INSET_PX = 10;

export function readMobileSafeAreaTopPx(): number {
  if (typeof document === "undefined" || typeof window === "undefined") {
    return 0;
  }
  const raw = window
    .getComputedStyle(document.documentElement)
    .getPropertyValue("--opencursor-mobile-safe-area-top");
  const parsed = Number.parseFloat(raw);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 0;
}

export function getChatStickyRailInsetPx(): number {
  return CHAT_STICKY_RAIL_INSET_PX + readMobileSafeAreaTopPx();
}
