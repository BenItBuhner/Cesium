"use client";

import { useSyncExternalStore } from "react";
import {
  HOVER_CAPABLE_MEDIA_QUERY,
  isHoverCapablePointer,
} from "@/lib/hover-capability";

function subscribe(onStoreChange: () => void) {
  if (typeof window.matchMedia !== "function") {
    return () => {};
  }
  const mediaQuery = window.matchMedia(HOVER_CAPABLE_MEDIA_QUERY);
  mediaQuery.addEventListener("change", onStoreChange);
  return () => mediaQuery.removeEventListener("change", onStoreChange);
}

function getSnapshot(): boolean {
  return isHoverCapablePointer();
}

function getServerSnapshot(): boolean {
  return true;
}

/**
 * Whether a hover-capable fine pointer is available (live: updates when e.g.
 * a mouse is plugged into a tablet). Use to gate JS hover-open/hover-close
 * interactions that must not run on touch taps — see lib/hover-capability.
 */
export function useHoverCapable(): boolean {
  return useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);
}
