"use client";

import {
  useCallback,
  useLayoutEffect,
  useRef,
  useState,
  type ReactNode,
  type RefObject,
} from "react";

export type HorizontalScrollFadeState = {
  left: boolean;
  right: boolean;
};

/**
 * Tracks left/right edge fades for a horizontally scrollable element (same thresholds as
 * `AgentWorkspaceRail` / `HorizontalFadedScroll`).
 */
export function useHorizontalScrollFade(
  scrollRef: RefObject<HTMLElement | null>,
  measureKey?: string | number | boolean | null
): {
  fade: HorizontalScrollFadeState;
  updateFade: () => void;
} {
  const [fade, setFade] = useState<HorizontalScrollFadeState>({
    left: false,
    right: false,
  });

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
  }, [scrollRef]);

  useLayoutEffect(() => {
    updateFade();
  }, [measureKey, updateFade]);

  useLayoutEffect(() => {
    const el = scrollRef.current;
    if (!el || typeof ResizeObserver === "undefined") {
      return;
    }
    const ro = new ResizeObserver(() => updateFade());
    ro.observe(el);
    return () => ro.disconnect();
  }, [scrollRef, updateFade]);

  return { fade, updateFade };
}

export function HorizontalScrollFadeOverlays({
  fade,
  edgeColorVar,
}: {
  fade: HorizontalScrollFadeState;
  edgeColorVar: string;
}) {
  const gradLeft = `linear-gradient(to right, ${edgeColorVar}, transparent)`;
  const gradRight = `linear-gradient(to left, ${edgeColorVar}, transparent)`;

  return (
    <>
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
    </>
  );
}

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
  const { fade, updateFade } = useHorizontalScrollFade(scrollRef, measureKey);

  return (
    <div className="relative min-h-[1.25rem] min-w-0">
      <HorizontalScrollFadeOverlays fade={fade} edgeColorVar={edgeColorVar} />
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
