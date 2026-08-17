"use client";

import { useRef, type ReactNode } from "react";
import {
  edgeFadeMaskStyle,
  useHorizontalScrollEdgeFade,
} from "@/components/ui/scroll-edge-fade";

type HorizontalFadedScrollProps = {
  children: ReactNode;
  /** Classes for the scrollport (overflow-x, typography, etc.). */
  scrollClassName: string;
  /** Bust fade layout when content changes (e.g. permission detail string). */
  measureKey?: string | number | boolean | null;
};

/**
 * Horizontally scrollable row whose content dissolves to transparent at the
 * left/right edges when it overflows. Uses a `mask-image` on the scrollport
 * (no surface-color overlay), so it is theme-agnostic and safe over the
 * aurora backdrop.
 */
export function HorizontalFadedScroll({
  children,
  scrollClassName,
  measureKey,
}: HorizontalFadedScrollProps) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const { fade, update } = useHorizontalScrollEdgeFade(scrollRef, measureKey);

  return (
    <div className="relative min-h-[1.25rem] min-w-0">
      <div
        ref={scrollRef}
        onScroll={update}
        className={scrollClassName}
        style={edgeFadeMaskStyle(fade)}
      >
        {children}
      </div>
    </div>
  );
}
