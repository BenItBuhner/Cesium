"use client";

import { useSyncExternalStore } from "react";

export type Breakpoint = "desktop" | "tablet" | "mobile";

function subscribe(onStoreChange: () => void) {
  window.addEventListener("resize", onStoreChange);
  return () => window.removeEventListener("resize", onStoreChange);
}

function getSnapshot(): number {
  return window.innerWidth;
}

function getServerSnapshot(): number {
  return 1920;
}

export function useViewport() {
  const width = useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);

  const breakpoint: Breakpoint =
    width >= 1024 ? "desktop" : width >= 768 ? "tablet" : "mobile";

  return {
    width,
    breakpoint,
    showSidebar: width >= 1024,
    showChat: width >= 768,
    isMobile: width < 768,
  };
}
