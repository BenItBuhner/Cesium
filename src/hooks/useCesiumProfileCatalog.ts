"use client";

import { useEffect, useSyncExternalStore } from "react";
import { fetchCesiumAgentSettings } from "@/lib/server-api";

export type CesiumProfileCatalogEntry = {
  id: string;
  name: string;
  description: string;
  builtIn: boolean;
};

export type CesiumProfileCatalogState = {
  catalog: CesiumProfileCatalogEntry[];
  defaultProfileId: string;
  loaded: boolean;
};

/** Profiles offered in the new-chat toggle. Missing flags stay visible (legacy). */
export function visibleCesiumProfiles<T extends { id: string }>(
  catalog: T[],
  enabledProfiles?: Record<string, boolean> | null
): T[] {
  return catalog.filter((profile) => enabledProfiles?.[profile.id] !== false);
}

/** Hide the Code/Work toggle when only one profile is actually configured. */
export function shouldShowCesiumProfileToggle(visibleCount: number): boolean {
  return visibleCount > 1;
}

const EMPTY_STATE: CesiumProfileCatalogState = {
  catalog: [],
  defaultProfileId: "code",
  loaded: false,
};

let state: CesiumProfileCatalogState = EMPTY_STATE;
let inflight: Promise<void> | null = null;
const listeners = new Set<() => void>();

function notify() {
  for (const listener of listeners) {
    listener();
  }
}

function loadCatalog(): Promise<void> {
  if (inflight) {
    return inflight;
  }
  inflight = fetchCesiumAgentSettings()
    .then(({ settings }) => {
      state = {
        catalog: visibleCesiumProfiles(
          settings.profileCatalog,
          settings.enabledProfiles
        ).map((profile) => ({
          id: profile.id,
          name: profile.name,
          description: profile.description,
          builtIn: profile.builtIn,
        })),
        defaultProfileId: settings.defaultProfileId || "code",
        loaded: true,
      };
      notify();
    })
    .catch(() => {
      // Leave the previous state; the composer degrades to no profile chip.
    })
    .finally(() => {
      inflight = null;
    });
  return inflight;
}

/** Drop the cached catalog (e.g. after saving profiles in Settings) and refetch for subscribers. */
export function invalidateCesiumProfileCatalog(): void {
  state = { ...state, loaded: false };
  if (listeners.size > 0) {
    void loadCatalog();
  }
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

function getSnapshot(): CesiumProfileCatalogState {
  return state;
}

function getServerSnapshot(): CesiumProfileCatalogState {
  return EMPTY_STATE;
}

/**
 * Cesium capability-profile catalog (enabled built-in Code/Work presets +
 * custom profiles), cached module-wide across composer instances. Disabled
 * profiles stay in Settings so they can be turned back on.
 */
export function useCesiumProfileCatalog(enabled: boolean): CesiumProfileCatalogState {
  const snapshot = useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);
  useEffect(() => {
    if (enabled && !snapshot.loaded) {
      void loadCatalog();
    }
  }, [enabled, snapshot.loaded]);
  return enabled ? snapshot : EMPTY_STATE;
}
