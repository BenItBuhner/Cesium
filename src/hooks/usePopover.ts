"use client";

import { useState, useRef, useCallback, useEffect } from "react";

interface PopoverPosition {
  bottom: number;
  left: number;
  maxHeight: number;
}

export function usePopover(open: boolean) {
  const triggerRef = useRef<HTMLDivElement>(null);
  const popoverRef = useRef<HTMLDivElement>(null);
  const [position, setPosition] = useState<PopoverPosition>({ bottom: 0, left: 0, maxHeight: 400 });
  const [ready, setReady] = useState(false);

  const reposition = useCallback(() => {
    if (!triggerRef.current || !popoverRef.current) return;

    const triggerRect = triggerRef.current.getBoundingClientRect();

    const distFromBottom = window.innerHeight - triggerRect.top + 6;
    const maxHeight = triggerRect.top - 12;

    let left = triggerRect.left;
    const popoverW = popoverRef.current.scrollWidth;
    if (left + popoverW > window.innerWidth - 4) {
      left = window.innerWidth - popoverW - 4;
    }
    if (left < 4) left = 4;

    setPosition({ bottom: distFromBottom, left, maxHeight: Math.max(maxHeight, 100) });
    setReady(true);
  }, []);

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
