"use client";

/**
 * Client-side store for the currently applied extension color theme.
 *
 * When a user applies a theme contributed by a VS Code extension, we persist
 * the loaded payload here so that:
 *  - extension webviews receive the full `--vscode-*` color table,
 *  - Monaco defines/uses a matching editor theme (base + token rules), and
 *  - the Cesium workbench applies the mapped UI tokens via ThemeProvider's
 *    custom-theme mechanism (handled by the settings panel on apply).
 */

import type { LoadedExtensionTheme } from "@/lib/server-api";

const STORAGE_KEY = "cesium.extensionTheme.v1";

let cached: LoadedExtensionTheme | null | undefined;
const listeners = new Set<() => void>();

function readStorage(): LoadedExtensionTheme | null {
  if (typeof window === "undefined") return null;
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as LoadedExtensionTheme;
    if (!parsed || typeof parsed !== "object" || typeof parsed.label !== "string") {
      return null;
    }
    return parsed;
  } catch {
    return null;
  }
}

export function getActiveExtensionTheme(): LoadedExtensionTheme | null {
  if (typeof cached === "undefined") {
    cached = readStorage();
  }
  return cached;
}

export function setActiveExtensionTheme(theme: LoadedExtensionTheme | null): void {
  cached = theme;
  if (typeof window !== "undefined") {
    try {
      if (theme) {
        window.localStorage.setItem(STORAGE_KEY, JSON.stringify(theme));
      } else {
        window.localStorage.removeItem(STORAGE_KEY);
      }
    } catch {
      /* quota/storage errors are non-fatal */
    }
  }
  for (const listener of [...listeners]) {
    listener();
  }
}

export function subscribeActiveExtensionTheme(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** Stable id used when registering the theme as a Cesium custom theme. */
export function extensionThemeCustomId(theme: Pick<LoadedExtensionTheme, "extensionId" | "label">): string {
  return `ext-theme:${theme.extensionId}:${theme.label}`;
}
