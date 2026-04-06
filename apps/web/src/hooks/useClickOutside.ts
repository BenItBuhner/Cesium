"use client";

import { useEffect, type RefObject } from "react";

export function useClickOutside(
  ref: RefObject<HTMLElement | null>,
  handler: () => void,
  active = true,
  excludeRefs?: RefObject<HTMLElement | null>[]
) {
  useEffect(() => {
    if (!active) return;

    function onPointerDown(e: PointerEvent) {
      const target = e.target as Node;
      if (ref.current && ref.current.contains(target)) return;
      if (excludeRefs?.some((r) => r.current?.contains(target))) return;
      handler();
    }

    document.addEventListener("pointerdown", onPointerDown);
    return () => document.removeEventListener("pointerdown", onPointerDown);
  }, [ref, handler, active, excludeRefs]);
}
