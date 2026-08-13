"use client";

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import {
  createDefaultGlobalSettings,
  normalizeLoadedGlobalSettings,
  type GlobalSettingsState,
} from "../global-settings";
import {
  CLIENT_SETTINGS_EVENT,
  clientSettingsHavePersonalization,
  hasMigratedClientSettingsFromEngine,
  markClientSettingsMigratedFromEngine,
  mergeEngineBoundSettings,
  readClientSettings,
  stripEngineBoundSettings,
  writeClientSettings,
} from "../client-settings";
import {
  fetchGlobalSettings,
  saveGlobalSettings,
  fetchModelToggleState,
  refreshModelToggleState,
  saveModelToggles,
  toServerRequestContext,
  type ModelToggleUpdate,
  type ServerRequestContext,
} from "../server-api";
import { useServerConnections } from "./ServerConnectionsProvider";
import { recordPerfSample } from "../dev-perf";
import { getClientPlatform } from "../platform";

type GlobalSettingsContextValue = {
  settings: GlobalSettingsState;
  ready: boolean;
  settingsServerId: string | null;
  settingsServerMissing: boolean;
  updateSettings: (
    updater: (current: GlobalSettingsState) => GlobalSettingsState
  ) => void;
  /** Re-fetch engine-bound settings (models / remembered permissions) without clobbering client prefs. */
  refreshSettings: () => Promise<void>;
  refreshModels: () => Promise<void>;
  modelsRefreshing: boolean;
  modelToggleSaveState: { pending: number; error: string | null };
  saveModelToggleUpdates: (updates: ModelToggleUpdate[]) => Promise<void>;
};

const GlobalSettingsContext =
  createContext<GlobalSettingsContextValue | null>(null);

const SAVE_DEBOUNCE_MS = 500;
const MODEL_TOGGLE_SAVE_DEBOUNCE_MS = 160;
const MODEL_SYNC_INTERVAL_MS = 5 * 60 * 1000;

/** Prefer globalThis so timers work on React Native where `window` may be absent. */
const scheduleTimeout = (handler: () => void, delay: number): number =>
  globalThis.setTimeout(handler, delay) as unknown as number;
const cancelTimeout = (handle: number | null): void => {
  if (handle != null) {
    globalThis.clearTimeout(handle);
  }
};

function createDefaultState(): GlobalSettingsState {
  return createDefaultGlobalSettings();
}

export function GlobalSettingsProvider({
  children,
  serverSettingsEnabled = true,
}: {
  children: ReactNode;
  /** When true and an engine is reachable, sync model catalogs and remembered permissions. */
  serverSettingsEnabled?: boolean;
}) {
  const { activeServer } = useServerConnections();
  const [settings, setSettings] = useState<GlobalSettingsState>(createDefaultState);
  const [ready, setReady] = useState(false);
  const engineServerRef = useRef<ServerRequestContext | null>(null);
  const [modelsRefreshing, setModelsRefreshing] = useState(false);
  const [modelToggleSaveState, setModelToggleSaveState] = useState<{
    pending: number;
    error: string | null;
  }>({ pending: 0, error: null });
  const settingsRef = useRef(settings);
  const skipNextSaveRef = useRef(false);
  const saveTimerRef = useRef<number | null>(null);
  const modelToggleQueueRef = useRef<Map<string, ModelToggleUpdate>>(new Map());
  const modelToggleTimerRef = useRef<number | null>(null);
  const modelToggleEpochRef = useRef(0);

  const engineRequestContext = useMemo(
    () => (activeServer ? toServerRequestContext(activeServer) : null),
    [activeServer]
  );

  useEffect(() => {
    engineServerRef.current = engineRequestContext;
  }, [engineRequestContext]);

  useEffect(() => {
    settingsRef.current = settings;
  }, [settings]);

  const persistClientSettings = useCallback((next: GlobalSettingsState) => {
    writeClientSettings(next);
  }, []);

  const flushModelToggleUpdates = useCallback(async () => {
    if (modelToggleTimerRef.current) {
      cancelTimeout(modelToggleTimerRef.current);
      modelToggleTimerRef.current = null;
    }
    const updates = [...modelToggleQueueRef.current.values()];
    modelToggleQueueRef.current.clear();
    if (updates.length === 0) {
      setModelToggleSaveState((current) =>
        current.pending === 0 ? current : { ...current, pending: 0 }
      );
      return;
    }
    const epoch = ++modelToggleEpochRef.current;
    const startedAt = performance.now();
    setModelToggleSaveState({ pending: updates.length, error: null });
    try {
      const server = engineServerRef.current;
      if (!server) {
        setModelToggleSaveState({
          pending: 0,
          error: "Connect a server to save model availability.",
        });
        return;
      }
      const result = await saveModelToggles(updates, { server });
      recordPerfSample("settings.models.toggle_save_ack", startedAt, {
        updates: updates.length,
      });
      if (epoch === modelToggleEpochRef.current) {
        setSettings((current) => ({
          ...current,
          models: { byBackend: result.byBackend },
        }));
        setModelToggleSaveState({ pending: 0, error: null });
      }
    } catch (error) {
      const message =
        error instanceof Error ? error.message : "Failed to save model toggle changes.";
      setModelToggleSaveState({ pending: 0, error: message });
    }
  }, []);

  const scheduleModelToggleFlush = useCallback(() => {
    if (modelToggleTimerRef.current) {
      cancelTimeout(modelToggleTimerRef.current);
    }
    modelToggleTimerRef.current = scheduleTimeout(() => {
      void flushModelToggleUpdates();
    }, MODEL_TOGGLE_SAVE_DEBOUNCE_MS);
  }, [flushModelToggleUpdates]);

  const flushGlobalSettingsNow = useCallback(
    async (options?: { keepalive?: boolean }) => {
      if (!ready) {
        return;
      }

      if (saveTimerRef.current) {
        cancelTimeout(saveTimerRef.current);
        saveTimerRef.current = null;
      }

      persistClientSettings(settingsRef.current);
      await flushModelToggleUpdates();
      const server = engineServerRef.current;
      if (!server || !serverSettingsEnabled) {
        return;
      }
      await saveGlobalSettings(settingsRef.current, { ...options, server }).catch(() => {});
    },
    [flushModelToggleUpdates, persistClientSettings, ready, serverSettingsEnabled]
  );

  useEffect(() => {
    skipNextSaveRef.current = true;
    setSettings(readClientSettings());
    setReady(true);
  }, []);

  useEffect(() => {
    const platform = getClientPlatform();
    return platform.addEventListener(CLIENT_SETTINGS_EVENT, () => {
      const next = readClientSettings();
      setSettings((current) => {
        const merged = mergeEngineBoundSettings(next, current);
        if (
          JSON.stringify(stripEngineBoundSettings(current)) ===
          JSON.stringify(stripEngineBoundSettings(merged))
        ) {
          return current;
        }
        skipNextSaveRef.current = true;
        return merged;
      });
    });
  }, []);

  useEffect(() => {
    let mounted = true;

    async function loadEngineBound(): Promise<void> {
      if (!engineRequestContext || !serverSettingsEnabled) {
        return;
      }
      try {
        const result = await fetchGlobalSettings({ server: engineRequestContext });
        if (!mounted) return;
        const engineSettings = normalizeLoadedGlobalSettings(result.settings);
        setSettings((current) => {
          let next = current;
          if (
            !hasMigratedClientSettingsFromEngine() &&
            !clientSettingsHavePersonalization(current)
          ) {
            next = stripEngineBoundSettings(engineSettings);
            persistClientSettings(next);
            markClientSettingsMigratedFromEngine();
          } else if (!hasMigratedClientSettingsFromEngine()) {
            markClientSettingsMigratedFromEngine();
          }
          skipNextSaveRef.current = true;
          return mergeEngineBoundSettings(next, engineSettings);
        });
      } catch {
        // Offline, unsigned, or guest-without-engine: client prefs still apply.
      }
    }

    void loadEngineBound();
    return () => {
      mounted = false;
    };
  }, [engineRequestContext, persistClientSettings, serverSettingsEnabled]);

  const syncModelToggleState = useCallback(async () => {
    const server = engineServerRef.current;
    if (!server || !serverSettingsEnabled) {
      return;
    }
    try {
      const result = await fetchModelToggleState({ server });
      setSettings((current) => ({
        ...current,
        models: { byBackend: result.byBackend },
      }));
    } catch {
      // Silently ignore; existing state remains valid.
    }
  }, [serverSettingsEnabled]);

  const refetchEngineBoundFromServer = useCallback(async () => {
    const server = engineServerRef.current;
    if (!server || !serverSettingsEnabled) {
      return;
    }
    try {
      const result = await fetchGlobalSettings({ server });
      skipNextSaveRef.current = true;
      setSettings((current) =>
        mergeEngineBoundSettings(
          current,
          normalizeLoadedGlobalSettings(result.settings)
        )
      );
    } catch {
      // Offline or auth; keep in-memory state.
    }
  }, [serverSettingsEnabled]);

  const refreshModels = useCallback(async () => {
    const server = engineServerRef.current;
    if (!server || !serverSettingsEnabled) {
      return;
    }
    setModelsRefreshing(true);
    const startedAt = performance.now();
    try {
      const result = await refreshModelToggleState({ server });
      recordPerfSample("settings.models.refresh_ack", startedAt, {
        backends: Object.keys(result.byBackend).length,
      });
      setSettings((current) => ({
        ...current,
        models: { byBackend: result.byBackend },
      }));
    } catch {
      // Silently ignore refresh failures; existing state remains valid.
    } finally {
      setModelsRefreshing(false);
    }
  }, [serverSettingsEnabled]);

  const saveModelToggleUpdates = useCallback(
    async (updates: ModelToggleUpdate[]) => {
      if (updates.length === 0) return;
      for (const update of updates) {
        modelToggleQueueRef.current.set(`${update.backendId}:${update.modelId}`, update);
      }
      setModelToggleSaveState({
        pending: modelToggleQueueRef.current.size,
        error: null,
      });
      scheduleModelToggleFlush();
    },
    [scheduleModelToggleFlush]
  );

  useEffect(() => {
    if (ready && serverSettingsEnabled) {
      void syncModelToggleState();
    }
  }, [ready, serverSettingsEnabled, syncModelToggleState]);

  useEffect(() => {
    if (!ready) {
      return;
    }

    if (skipNextSaveRef.current) {
      skipNextSaveRef.current = false;
      persistClientSettings(settingsRef.current);
      return;
    }

    if (saveTimerRef.current) {
      cancelTimeout(saveTimerRef.current);
    }

    saveTimerRef.current = scheduleTimeout(() => {
      persistClientSettings(settingsRef.current);
      const server = engineServerRef.current;
      if (!server || !serverSettingsEnabled) {
        return;
      }
      void saveGlobalSettings(settingsRef.current, { server }).catch(() => {});
    }, SAVE_DEBOUNCE_MS);

    return () => {
      if (saveTimerRef.current) {
        cancelTimeout(saveTimerRef.current);
      }
    };
  }, [persistClientSettings, ready, serverSettingsEnabled, settings]);

  useEffect(() => {
    if (!ready) {
      return;
    }

    const flushForPageHide = () => {
      void flushGlobalSettingsNow({ keepalive: true });
    };

    const handleVisibilityChange = () => {
      if (document.visibilityState === "hidden") {
        flushForPageHide();
      } else if (document.visibilityState === "visible") {
        void (async () => {
          await flushGlobalSettingsNow();
          await refetchEngineBoundFromServer();
          await syncModelToggleState();
        })();
      }
    };

    const intervalId = setInterval(() => {
      void syncModelToggleState();
    }, MODEL_SYNC_INTERVAL_MS);

    const canUsePageLifecycle =
      typeof window !== "undefined" &&
      typeof window.addEventListener === "function" &&
      typeof document !== "undefined" &&
      typeof document.addEventListener === "function";
    if (canUsePageLifecycle) {
      window.addEventListener("pagehide", flushForPageHide);
      window.addEventListener("beforeunload", flushForPageHide);
      document.addEventListener("visibilitychange", handleVisibilityChange);
    }

    return () => {
      clearInterval(intervalId);
      if (canUsePageLifecycle) {
        window.removeEventListener("pagehide", flushForPageHide);
        window.removeEventListener("beforeunload", flushForPageHide);
        document.removeEventListener("visibilitychange", handleVisibilityChange);
      }
    };
  }, [
    flushGlobalSettingsNow,
    ready,
    refetchEngineBoundFromServer,
    syncModelToggleState,
  ]);

  const updateSettings = useCallback(
    (updater: (current: GlobalSettingsState) => GlobalSettingsState) => {
      setSettings((current) => updater(current));
    },
    []
  );

  const value = useMemo(
    () => ({
      settings,
      ready,
      settingsServerId: activeServer?.id ?? null,
      settingsServerMissing: false,
      updateSettings,
      refreshSettings: refetchEngineBoundFromServer,
      refreshModels,
      modelsRefreshing,
      modelToggleSaveState,
      saveModelToggleUpdates,
    }),
    [
      activeServer?.id,
      ready,
      settings,
      updateSettings,
      refetchEngineBoundFromServer,
      refreshModels,
      modelsRefreshing,
      modelToggleSaveState,
      saveModelToggleUpdates,
    ]
  );

  return (
    <GlobalSettingsContext.Provider value={value}>
      {children}
    </GlobalSettingsContext.Provider>
  );
}

export function useGlobalSettings(): GlobalSettingsContextValue {
  const context = useContext(GlobalSettingsContext);
  if (!context) {
    throw new Error("useGlobalSettings must be used within GlobalSettingsProvider");
  }
  return context;
}
