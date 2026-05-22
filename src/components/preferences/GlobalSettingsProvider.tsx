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
  type ModelToggleState,
} from "@/lib/global-settings";
import {
  fetchGlobalSettings,
  saveGlobalSettings,
  fetchModelToggleState,
  refreshModelToggleState,
  saveModelToggles,
  toServerRequestContext,
  type ModelToggleUpdate,
  type ServerRequestContext,
} from "@/lib/server-api";
import { useServerConnections } from "@/components/preferences/ServerConnectionsProvider";
import { recordPerfSample } from "@/lib/dev-perf";

type GlobalSettingsContextValue = {
  settings: GlobalSettingsState;
  ready: boolean;
  settingsServerId: string | null;
  settingsServerMissing: boolean;
  updateSettings: (
    updater: (current: GlobalSettingsState) => GlobalSettingsState
  ) => void;
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

function createDefaultState(): GlobalSettingsState {
  return createDefaultGlobalSettings();
}

export function GlobalSettingsProvider({
  children,
  serverSettingsEnabled = true,
}: {
  children: ReactNode;
  serverSettingsEnabled?: boolean;
}) {
  const { settingsServer, requiresDefaultServer } = useServerConnections();
  const [settings, setSettings] = useState<GlobalSettingsState>(createDefaultState);
  const [ready, setReady] = useState(false);
  const settingsServerRef = useRef<ServerRequestContext | null>(null);
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

  const settingsRequestContext = useMemo(
    () => (settingsServer ? toServerRequestContext(settingsServer) : null),
    [settingsServer]
  );

  useEffect(() => {
    settingsServerRef.current = settingsRequestContext;
  }, [settingsRequestContext]);

  useEffect(() => {
    settingsRef.current = settings;
  }, [settings]);

  const flushModelToggleUpdates = useCallback(async () => {
    if (modelToggleTimerRef.current) {
      window.clearTimeout(modelToggleTimerRef.current);
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
      const server = settingsServerRef.current;
      if (!server) {
        setModelToggleSaveState({ pending: 0, error: "Choose a default server for shared settings." });
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
      window.clearTimeout(modelToggleTimerRef.current);
    }
    modelToggleTimerRef.current = window.setTimeout(() => {
      void flushModelToggleUpdates();
    }, MODEL_TOGGLE_SAVE_DEBOUNCE_MS);
  }, [flushModelToggleUpdates]);

  const flushGlobalSettingsNow = useCallback(
    async (options?: { keepalive?: boolean }) => {
      if (!ready) {
        return;
      }

      if (saveTimerRef.current) {
        window.clearTimeout(saveTimerRef.current);
        saveTimerRef.current = null;
      }

      await flushModelToggleUpdates();
      const server = settingsServerRef.current;
      if (!server) {
        return;
      }
      await saveGlobalSettings(settingsRef.current, { ...options, server }).catch(() => {});
    },
    [flushModelToggleUpdates, ready]
  );

  useEffect(() => {
    let mounted = true;

    async function load(): Promise<void> {
      if (!settingsRequestContext) {
        if (mounted) {
          skipNextSaveRef.current = true;
          setSettings(createDefaultState());
          setReady(true);
        }
        return;
      }
      if (!serverSettingsEnabled) {
        if (mounted) {
          setReady(false);
        }
        return;
      }
      try {
        const result = await fetchGlobalSettings({ server: settingsRequestContext });
        if (!mounted) return;
        skipNextSaveRef.current = true;
        setSettings(normalizeLoadedGlobalSettings(result.settings));
      } catch {
        // Logged-out, offline, or stale-auth startup should keep defaults and let AuthGate own the UI.
      } finally {
        if (mounted) {
          setReady(true);
        }
      }
    }

    setReady(false);
    void load();

    return () => {
      mounted = false;
    };
  }, [serverSettingsEnabled, settingsRequestContext]);

  const syncModelToggleState = useCallback(async () => {
    const server = settingsServerRef.current;
    if (!server) {
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
  }, []);

  const refetchGlobalSettingsFromServer = useCallback(async () => {
    const server = settingsServerRef.current;
    if (!server) {
      return;
    }
    try {
      const result = await fetchGlobalSettings({ server });
      skipNextSaveRef.current = true;
      setSettings(normalizeLoadedGlobalSettings(result.settings));
    } catch {
      // Offline or auth; keep in-memory state.
    }
  }, []);

  const refreshModels = useCallback(async () => {
    const server = settingsServerRef.current;
    if (!server) {
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
  }, []);

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
    if (ready) {
      void syncModelToggleState();
    }
  }, [ready, syncModelToggleState]);

  useEffect(() => {
    if (!ready || !settingsServerRef.current) {
      return;
    }

    if (skipNextSaveRef.current) {
      skipNextSaveRef.current = false;
      return;
    }

    if (saveTimerRef.current) {
      window.clearTimeout(saveTimerRef.current);
    }

    saveTimerRef.current = window.setTimeout(() => {
      const server = settingsServerRef.current;
      if (!server) {
        return;
      }
      void saveGlobalSettings(settingsRef.current, { server }).catch(() => {});
    }, SAVE_DEBOUNCE_MS);

    return () => {
      if (saveTimerRef.current) {
        window.clearTimeout(saveTimerRef.current);
      }
    };
  }, [ready, settings]);

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
          await refetchGlobalSettingsFromServer();
          await syncModelToggleState();
        })();
      }
    };

    const intervalId = window.setInterval(() => {
      void syncModelToggleState();
    }, MODEL_SYNC_INTERVAL_MS);

    window.addEventListener("pagehide", flushForPageHide);
    window.addEventListener("beforeunload", flushForPageHide);
    document.addEventListener("visibilitychange", handleVisibilityChange);

    return () => {
      window.clearInterval(intervalId);
      window.removeEventListener("pagehide", flushForPageHide);
      window.removeEventListener("beforeunload", flushForPageHide);
      document.removeEventListener("visibilitychange", handleVisibilityChange);
    };
  }, [
    flushGlobalSettingsNow,
    ready,
    refetchGlobalSettingsFromServer,
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
      settingsServerId: settingsServer?.id ?? null,
      settingsServerMissing: requiresDefaultServer,
      updateSettings,
      refreshModels,
      modelsRefreshing,
      modelToggleSaveState,
      saveModelToggleUpdates,
    }),
    [
      ready,
      requiresDefaultServer,
      settings,
      settingsServer?.id,
      updateSettings,
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
