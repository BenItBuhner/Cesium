"use client";

import {
  type CSSProperties,
  useCallback,
  useLayoutEffect,
  useRef,
  useState,
  type ReactNode,
  type RefObject,
} from "react";
import { scrollEdgeMaskStyle } from "./scroll-edge-mask";

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
 * Vertically scrollable region with top/bottom edge fades when content overflows,
 * matching {@link ModelDropdown} harness and model list treatment.
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
  const [fade, setFade] = useState({ top: false, bottom: false });

  const updateFade = useCallback(() => {
    const el = scrollRef.current;
    if (!el) {
      return;
    }
    const { scrollTop, scrollHeight, clientHeight } = el;
    const maxScrollY = scrollHeight - clientHeight;
    setFade({
      top: scrollTop > 2,
      bottom: maxScrollY > 2 && scrollTop < maxScrollY - 2,
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
        onScroll={updateFade}
        className={scrollClassName}
        style={{ ...scrollStyle, ...scrollEdgeMaskStyle(fade) }}
      >
        {children}
      </div>
    </div>
  );
}
