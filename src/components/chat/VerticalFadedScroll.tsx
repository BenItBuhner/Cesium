"use client";

import { useRef, type CSSProperties, type ReactNode, type RefObject } from "react";
import {
  edgeFadeMaskStyle,
  useVerticalScrollEdgeFade,
} from "@/components/ui/scroll-edge-fade";

type VerticalFadedScrollProps = {
  children: ReactNode;
  /** Classes on the outer wrapper (e.g. `min-h-0 flex-1` inside a flex popover). */
  wrapperClassName?: string;
  /** Classes for the scrollport (overflow-y, max-height, scrollbar hide, padding, etc.). */
  scrollClassName: string;
  /** Inline styles for the scrollport, e.g. fixed popover max height. */
  scrollStyle?: CSSProperties;
  /** Optional external ref for the scrollport (keyboard nav scroll-into-view). */
  scrollRef?: RefObject<HTMLDivElement | null>;
  /** Bust fade layout when content changes (filter text, list length, etc.). */
  measureKey?: string | number | boolean | null;
};

/**
 * Vertically scrollable region whose content dissolves to transparent at the
 * top/bottom edges when it overflows. The fade is a `mask-image` on the
 * scrollport itself — theme-agnostic, no surface color involved — so it stays
 * clean over the aurora backdrop and translucent popovers alike.
 */
export function VerticalFadedScroll({
  children,
  wrapperClassName,
  scrollClassName,
  scrollStyle,
  scrollRef: externalScrollRef,
  measureKey,
}: VerticalFadedScrollProps) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const { fade, update } = useVerticalScrollEdgeFade(scrollRef, measureKey);

  const wrapperClass = wrapperClassName
    ? `relative min-h-0 min-w-0 ${wrapperClassName}`
    : "relative min-h-0 min-w-0";

  return (
    <div className={wrapperClass}>
      <div
        ref={(node) => {
          scrollRef.current = node;
          if (externalScrollRef) {
            externalScrollRef.current = node;
          }
        }}
        onScroll={update}
        className={scrollClassName}
        style={{ ...scrollStyle, ...edgeFadeMaskStyle(fade, 24) }}
      >
        {children}
      </div>
    </div>
  );
}
