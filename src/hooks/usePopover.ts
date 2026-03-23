"use client";

import { useState, useRef, useCallback, useEffect } from "react";

export type PopoverPlacement = "above" | "below";

export interface PopoverPosition {
  left: number;
  maxHeight: number;
  /** Set when placement is `above` (fixed to viewport bottom). */
  bottom?: number;
  /** Set when placement is `below` (fixed to viewport top). */
  top?: number;
}

export function usePopover(
  open: boolean,
  options?: { placement?: PopoverPlacement }
) {
  const placement = options?.placement ?? "above";
  const triggerRef = useRef<HTMLDivElement>(null);
  const popoverRef = useRef<HTMLDivElement>(null);
  const [position, setPosition] = useState<PopoverPosition>({
    bottom: 0,
    left: 0,
    maxHeight: 400,
  });
  const [ready, setReady] = useState(false);

  const reposition = useCallback(() => {
    if (!triggerRef.current || !popoverRef.current) return;

    const triggerRect = triggerRef.current.getBoundingClientRect();
    const gap = 6;
    const edge = 8;

    let left = triggerRect.left;
    const popoverW = popoverRef.current.scrollWidth;
    if (left + popoverW > window.innerWidth - 4) {
      left = window.innerWidth - popoverW - 4;
    }
    if (left < 4) left = 4;

    if (placement === "below") {
      const top = triggerRect.bottom + gap;
      const maxHeight = Math.max(100, window.innerHeight - triggerRect.bottom - gap - edge);
      setPosition({ top, left, maxHeight });
    } else {
      const distFromBottom = window.innerHeight - triggerRect.top + gap;
      const maxHeight = Math.max(100, triggerRect.top - edge);
      setPosition({ bottom: distFromBottom, left, maxHeight });
    }
    setReady(true);
  }, [placement]);

  useEffect(() => {
    if (!open) {
      setReady(false);
      return;
    }
    requestAnimationFrame(() => {
      requestAnimationFrame(reposition);
    });
  }, [open, reposition]);

  return { triggerRef, popoverRef, position, ready };
}
