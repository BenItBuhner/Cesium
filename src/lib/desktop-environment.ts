"use client";

import { useSyncExternalStore } from "react";

type CesiumDesktopGlobal = {
  cesiumDesktop?: {
    isElectron?: boolean;
    /** Electron main-process reload of this BrowserWindow; absent in plain web builds. */
    reloadWindow?: () => void | Promise<void>;
  };
};

/**
 * True when the renderer is running inside the Cesium Electron shell (preload
 * sets `window.cesiumDesktop.isElectron = true`). Safe during SSR ΓÇö returns
 * `false` when `window` is not defined.
 *
 * Used as the trigger for window-chrome trailing/leading insets so the
 * inset only ever applies inside Electron and never bleeds into the
 * regular web/PWA build.
 */
export function isCesiumDesktopApp(): boolean {
  if (typeof window === "undefined") {
    return false;
  }
  return Boolean(
    (window as Window & CesiumDesktopGlobal).cesiumDesktop?.isElectron
  );
}

/**
 * Reloads the renderer from the Electron main process when `reloadWindow` is
 * exposed by preload; otherwise performs a normal browser navigation reload.
 */
export function reloadAppWindow(): void {
  if (typeof window === "undefined") {
    return;
  }
  const reload = (window as Window & CesiumDesktopGlobal).cesiumDesktop
    ?.reloadWindow;
  if (reload) {
    void reload();
    return;
  }
  window.location.reload();
}

function subscribeNoop(): () => void {
  return () => undefined;
}

/**
 * React-safe accessor for {@link isCesiumDesktopApp}. The value is fixed for
 * the lifetime of the renderer (preload only injects once), so the store
 * never emits changes ΓÇö we just need a stable snapshot for SSR + hydration.
 */
export function useIsCesiumDesktopApp(): boolean {
  return useSyncExternalStore(
    subscribeNoop,
    isCesiumDesktopApp,
    () => false
  );
}
