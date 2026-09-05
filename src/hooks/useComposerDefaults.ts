"use client";

import { useCallback, useMemo } from "react";
import { useGlobalSettings } from "@/components/preferences/GlobalSettingsProvider";
import type { ComposerDefaultsState } from "@cesium/client";

export type ComposerDefaultsUpdater = (
  current: ComposerDefaultsState
) => ComposerDefaultsState;

/**
 * Account-wide new-chat defaults (last-used harness / mode / model, Cesium
 * capability profile, composer chrome). Backed by the global settings
 * document, so a pick made on any device is the default on every device.
 *
 * Updaters that return the same object are dropped before they reach the
 * settings provider, so the debounced save never fires for no-op edits.
 */
export function useComposerDefaults(): {
  composer: ComposerDefaultsState;
  updateComposer: (updater: ComposerDefaultsUpdater) => void;
  /** True once the defaults reflect the account (server fetch succeeded). */
  hydrated: boolean;
} {
  const { settings, hydrated, updateSettings } = useGlobalSettings();
  const composer = settings.composer;
  const updateComposer = useCallback(
    (updater: ComposerDefaultsUpdater) => {
      updateSettings((current) => {
        const next = updater(current.composer);
        return next === current.composer ? current : { ...current, composer: next };
      });
    },
    [updateSettings]
  );
  return useMemo(
    () => ({ composer, updateComposer, hydrated }),
    [composer, updateComposer, hydrated]
  );
}
