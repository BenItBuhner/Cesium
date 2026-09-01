"use client";

import { createContext, useContext } from "react";

/**
 * True inside a workbench tree that is mounted as the hidden preview layer
 * beneath the full-screen settings view (the Android predictive-back reveal
 * keeps the agent shell warm there so the gesture can uncover it without a
 * mid-gesture mount). While a tree is an underlay, its global input surfaces
 * must stand down - document-level key listeners, bridge share intake, the
 * full-screen voice view - so the settings tree's own instances stay the only
 * live ones and nothing reacts invisibly behind the settings surface.
 */
const ShellUnderlayContext = createContext(false);

export const ShellUnderlayProvider = ShellUnderlayContext.Provider;

export function useIsShellUnderlay(): boolean {
  return useContext(ShellUnderlayContext);
}
