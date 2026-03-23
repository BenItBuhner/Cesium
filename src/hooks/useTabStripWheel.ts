import { useEffect, type RefObject } from "react";

export type TabStripWheelOptions = {
  /** >1 scrolls the strip faster than the raw wheel delta (trackpads feel less sluggish). */
  speed?: number;
};

/**
 * Makes vertical wheel / trackpad gestures scroll a horizontal tab strip instead of doing nothing
 * (or fighting the parent). Uses a non-passive listener so we can preventDefault only when we
 * actually consume the scroll.
 */
export function useTabStripWheel(
  ref: RefObject<HTMLElement | null>,
  options?: TabStripWheelOptions
) {
  const speed = options?.speed ?? 1.75;

  useEffect(() => {
    const el = ref.current;
    if (!el) return;

    const onWheel = (e: WheelEvent) => {
      if (el.scrollWidth <= el.clientWidth + 1) return;

      // Let the browser handle dominant horizontal deltas (trackpad two-finger horizontal).
      if (Math.abs(e.deltaX) > Math.abs(e.deltaY)) return;

      const raw = e.shiftKey ? e.deltaY : e.deltaY;
      if (raw === 0) return;

      const delta = raw * speed;
      const max = el.scrollWidth - el.clientWidth;
      const next = el.scrollLeft + delta;
      const clamped = Math.max(0, Math.min(max, next));

      if (clamped === el.scrollLeft) return;

      el.scrollLeft = clamped;
      e.preventDefault();
    };

    el.addEventListener("wheel", onWheel, { passive: false });
    return () => el.removeEventListener("wheel", onWheel);
  }, [speed]);
}
