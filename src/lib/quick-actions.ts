"use client";

import { useCallback, useEffect, useSyncExternalStore } from "react";
import {
  createDefaultQuickActionsConfig,
  resolveEffectiveQuickActions,
  type QuickActionDefinition,
  type QuickActionsConfig,
} from "@cesium/core";
import {
  fetchQuickActions,
  removeCustomQuickAction,
  runQuickAction,
  updateQuickActionPresetStates,
  upsertCustomQuickAction,
} from "@/lib/server-api";

export {
  QUICK_ACTION_PRESETS,
  QUICK_ACTION_UI_COMMANDS,
  QUICK_ACTION_VISIBILITY_OPTIONS,
  isQuickActionVisibleInContext,
  resolveEffectiveQuickActions,
} from "@cesium/core";
export type {
  QuickActionDefinition,
  QuickActionKind,
  QuickActionPreset,
  QuickActionRunResult,
  QuickActionsConfig,
  QuickActionVisibility,
} from "@cesium/core";

type QuickActionsStoreState = {
  config: QuickActionsConfig;
  loaded: boolean;
  loading: boolean;
  error: string | null;
};

let state: QuickActionsStoreState = {
  config: createDefaultQuickActionsConfig(),
  loaded: false,
  loading: false,
  error: null,
};

const listeners = new Set<() => void>();

function emit(): void {
  for (const listener of [...listeners]) {
    listener();
  }
}

function setState(patch: Partial<QuickActionsStoreState>): void {
  state = { ...state, ...patch };
  emit();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

function getSnapshot(): QuickActionsStoreState {
  return state;
}

let loadPromise: Promise<void> | null = null;

export function ensureQuickActionsLoaded(force = false): Promise<void> {
  if (loadPromise && !force) {
    return loadPromise;
  }
  if (state.loaded && !force) {
    return Promise.resolve();
  }
  setState({ loading: true });
  const promise = fetchQuickActions()
    .then((response) => {
      setState({ config: response.config, loaded: true, loading: false, error: null });
    })
    .catch((error: unknown) => {
      setState({
        loading: false,
        error: error instanceof Error ? error.message : "Failed to load quick actions",
      });
    })
    .finally(() => {
      loadPromise = null;
    });
  loadPromise = promise;
  return promise;
}

export function applyQuickActionsConfig(config: QuickActionsConfig): void {
  setState({ config, loaded: true, error: null });
}

export async function saveCustomQuickActionToServer(
  action: Partial<QuickActionDefinition> & { id: string }
): Promise<void> {
  const response = await upsertCustomQuickAction(action.id, action);
  applyQuickActionsConfig(response.config);
}

export async function deleteCustomQuickActionFromServer(actionId: string): Promise<void> {
  const response = await removeCustomQuickAction(actionId);
  applyQuickActionsConfig(response.config);
}

export async function setQuickActionPresetStatesOnServer(
  states: Record<string, boolean>
): Promise<void> {
  const response = await updateQuickActionPresetStates(states);
  applyQuickActionsConfig(response.config);
}

export { runQuickAction };

/**
 * Shared quick actions config. All consumers (composer pills, keyboard layer,
 * settings panel) observe the same module store, so a settings edit updates
 * pills immediately.
 */
export function useQuickActionsConfig(): QuickActionsStoreState & {
  effectiveActions: QuickActionDefinition[];
  refresh: () => Promise<void>;
} {
  const snapshot = useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
  useEffect(() => {
    void ensureQuickActionsLoaded();
  }, []);
  const refresh = useCallback(() => ensureQuickActionsLoaded(true), []);
  return {
    ...snapshot,
    effectiveActions: resolveEffectiveQuickActions(snapshot.config),
    refresh,
  };
}
