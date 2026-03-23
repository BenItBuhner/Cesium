"use client";

import { useSyncExternalStore } from "react";

function subscribe(onChange: () => void) {
  const el = document.documentElement;
  const mo = new MutationObserver(onChange);
  mo.observe(el, { attributes: true, attributeFilter: ["class"] });
  return () => mo.disconnect();
}

function getSnapshot() {
  return document.documentElement.classList.contains("dark");
}

/** SSR / first client paint: light tokens match `:root` before theme script runs. */
function getServerSnapshot() {
  return false;
}

/** True when `<html>` has `dark` — same signal as app CSS variables. */
export function useHtmlDarkClass(): boolean {
  return useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);
}
