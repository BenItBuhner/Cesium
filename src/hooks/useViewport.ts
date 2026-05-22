"use client";

import { useSyncExternalStore } from "react";

export type Breakpoint = "desktop" | "tablet" | "mobile";

function subscribe(onStoreChange: () => void) {
  window.addEventListener("resize", onStoreChange);
  return () => {
    window.removeEventListener("resize", onStoreChange);
  };
}

function getSnapshot(): string {
  return [window.innerWidth, window.innerHeight].join(":");
}

function getServerSnapshot(): string {
  return "1920:1080:web";
}

export function useViewport() {
  const snapshot = useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);
  const [widthText, heightText] = snapshot.split(":");
  const width = Number(widthText) || 1920;
  const height = Number(heightText) || 1080;
  const isMobile = width < 768;

  const breakpoint: Breakpoint =
    isMobile ? "mobile" : width >= 1024 ? "desktop" : "tablet";

  return {
    width,
    height,
    breakpoint,
    showSidebar: !isMobile && width >= 1024,
    showChat: !isMobile && width >= 768,
    isMobile,
  };
}
