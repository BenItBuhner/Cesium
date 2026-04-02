"use client";

import { useRef, useState, useLayoutEffect, type ReactNode } from "react";

/** Max height (px) for user + melded todo to stay sticky; taller blocks scroll with the thread. */
const MAX_STICKY_HEIGHT_PX = 320;
const STICKY_TOP_GAP_PX = 10;

interface StickyChatHeaderProps {
  /** Main chat: each user turn participates in sticky stacking; transcript tabs: off. */
  enabled: boolean;
  stackOrder: number;
  /** Pixels to shift this sticky block upward while the next user turn approaches (scroll-driven). */
  pushUpPx?: number;
  registerStickyEl?: (order: number, el: HTMLDivElement | null) => void;
  children: ReactNode;
}

/**
 * Each user prompt (+ optional melded todo row) uses `position: sticky` with `top` driven by
 * `pushUpPx` so the previous turn slides out progressively instead of being covered by z-index.
 */
export function StickyChatHeader({
  enabled,
  stackOrder,
  pushUpPx = 0,
  registerStickyEl,
  children,
}: StickyChatHeaderProps) {
  const ref = useRef<HTMLDivElement>(null);
  const [allowSticky, setAllowSticky] = useState(true);

  useLayoutEffect(() => {
    if (!enabled) {
      setAllowSticky((current) => (current ? current : true));
      return;
    }
    const el = ref.current;
    if (!el) return;

    const measure = () => {
      const nextAllowSticky = el.scrollHeight <= MAX_STICKY_HEIGHT_PX;
      setAllowSticky((current) =>
        current === nextAllowSticky ? current : nextAllowSticky
      );
    };

    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, [enabled]);

  function setRefs(el: HTMLDivElement | null) {
    ref.current = el;
    registerStickyEl?.(stackOrder, el);
  }

  if (!enabled) {
    return <div className="shrink-0">{children}</div>;
  }

  return (
    <div
      ref={setRefs}
      style={allowSticky ? { top: STICKY_TOP_GAP_PX - pushUpPx } : undefined}
      className={
        allowSticky
          ? "sticky z-10 shrink-0 bg-transparent pb-[10px]"
          : "relative z-10 shrink-0 bg-transparent"
      }
    >
      {children}
    </div>
  );
}
