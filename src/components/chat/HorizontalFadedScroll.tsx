"use client";

import {
  useCallback,
  useLayoutEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";

type HorizontalFadedScrollProps = {
  children: ReactNode;
  /** Classes for the scrollport (overflow-x, typography, etc.). */
  scrollClassName: string;
  /** CSS color for the fade, e.g. `var(--bg-card)`. */
  edgeColorVar: string;
  /** Bust fade layout when content changes (e.g. permission detail string). */
  measureKey?: string | number | boolean | null;
};

/**
 * Horizontally scrollable row with left/right edge fades when content overflows,
 * matching the vertical fade pattern used on overflowing tool lists.
 */
export function HorizontalFadedScroll({
  children,
  scrollClassName,
  edgeColorVar,
  measureKey,
}: HorizontalFadedScrollProps) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const [fade, setFade] = useState({ left: false, right: false });

  const updateFade = useCallback(() => {
    const el = scrollRef.current;
    if (!el) {
      return;
    }
    const { scrollLeft, scrollWidth, clientWidth } = el;
    const maxScroll = scrollWidth - clientWidth;
    setFade({
      left: scrollLeft > 2,
      right: maxScroll > 2 && scrollLeft < maxScroll - 2,
    });
  }, []);

  useLayoutEffect(() => {
    updateFade();
  }, [measureKey, updateFade]);

  useLayoutEffect(() => {
    const el = scrollRef.current;
    if (!el) {
      return;
    }
    const ro = new ResizeObserver(() => updateFade());
    ro.observe(el);
    return () => ro.disconnect();
  }, [updateFade]);

  const gradLeft = `linear-gradient(to right, ${edgeColorVar}, transparent)`;
  const gradRight = `linear-gradient(to left, ${edgeColorVar}, transparent)`;

  return (
    <div className="relative min-h-[1.25rem] min-w-0">
      {fade.left ? (
        <div
          className="pointer-events-none absolute inset-y-0 left-0 z-[1] w-[28px]"
          style={{ backgroundImage: gradLeft }}
          aria-hidden
        />
      ) : null}
      {fade.right ? (
        <div
          className="pointer-events-none absolute inset-y-0 right-0 z-[1] w-[28px]"
          style={{ backgroundImage: gradRight }}
          aria-hidden
        />
      ) : null}
      <div
        ref={scrollRef}
        onScroll={updateFade}
        className={scrollClassName}
      >
        {children}
      </div>
    </div>
  );
}
