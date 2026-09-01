"use client";

import { useEffect } from "react";
import {
  WORKBENCH_VIEWPORT_CLASS,
  installVisualViewportLock,
  setWorkbenchViewportClass,
} from "@/lib/visual-viewport";

/**
 * Pins the workbench document to the visual viewport so mobile browser chrome
 * (Edge/Chrome Android bottom bars, iOS URL bar, software keyboard) cannot
 * push the account/settings footer off-screen or make the shell scrollable.
 */
export function VisualViewportLock() {
  useEffect(() => {
    const root = document.documentElement;
    setWorkbenchViewportClass(root, true);
    const uninstall = installVisualViewportLock(window);
    return () => {
      uninstall();
      root.classList.remove(WORKBENCH_VIEWPORT_CLASS);
    };
  }, []);
  return null;
}
