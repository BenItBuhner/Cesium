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
  type ModelToggleUpdate,
} from "@/lib/server-api";

type GlobalSettingsContextValue = {
  settings: GlobalSettingsState;
  ready: boolean;
  updateSettings: (
    updater: (current: GlobalSettingsState) => GlobalSettingsState
  ) => void;
  refreshModels: () => Promise<void>;
  modelsRefreshing: boolean;
  saveModelToggleUpdates: (updates: ModelToggleUpdate[]) => Promise<void>;
};

const GlobalSettingsContext =
  createContext<GlobalSettingsContextValue | null>(null);

const SAVE_DEBOUNCE_MS = 500;
const MODEL_SYNC_INTERVAL_MS = 5 * 60 * 1000;

function createDefaultState(): GlobalSettingsState {
  return createDefaultGlobalSettings();
}

export function GlobalSettingsProvider({ children }: { children: ReactNode }) {
  const [settings, setSettings] = useState<GlobalSettingsState>(createDefaultState);
  const [ready, setReady] = useState(false);
  const [modelsRefreshing, setModelsRefreshing] = useState(false);
  const settingsRef = useRef(settings);
  const skipNextSaveRef = useRef(false);
  const saveTimerRef = useRef<number | null>(null);

  useEffect(() => {
    settingsRef.current = settings;
  }, [settings]);

  const flushGlobalSettingsNow = useCallback(
    async (options?: { keepalive?: boolean }) => {
      if (!ready) {
        return;
      }

      if (saveTimerRef.current) {
        window.clearTimeout(saveTimerRef.current);
        saveTimerRef.current = null;
      }

      await saveGlobalSettings(settingsRef.current, options).catch(() => {});
    },
    [ready]
  );

  useEffect(() => {
    let mounted = true;

    async function load(): Promise<void> {
      try {
        const result = await fetchGlobalSettings();
        if (!mounted) return;
        skipNextSaveRef.current = true;
        setSettings(normalizeLoadedGlobalSettings(result.settings));
      } finally {
        if (mounted) {
          setReady(true);
        }
      }
    }

    void load();

    return () => {
      mounted = false;
    };
  }, []);

  const syncModelToggleState = useCallback(async () => {
    try {
      const result = await fetchModelToggleState();
      setSettings((current) => ({
        ...current,
        models: { byBackend: result.byBackend },
      }));
    } catch {
      // Silently ignore; existing state remains valid.
    }
  }, []);

  const refetchGlobalSettingsFromServer = useCallback(async () => {
    try {
      const result = await fetchGlobalSettings();
      skipNextSaveRef.current = true;
      setSettings(normalizeLoadedGlobalSettings(result.settings));
    } catch {
      // Offline or auth; keep in-memory state.
    }
  }, []);

  const refreshModels = useCallback(async () => {
    setModelsRefreshing(true);
    try {
      const result = await refreshModelToggleState();
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
      try {
        const result = await saveModelToggles(updates);
        setSettings((current) => ({
          ...current,
          models: { byBackend: result.byBackend },
        }));
      } catch {
        // Server toggle save failed — the optimistic UI update still stands
        // and the next global settings save cycle will persist the toggles
        // as part of the full settings blob.
      }
    },
    []
  );

  useEffect(() => {
    if (ready) {
      void syncModelToggleState();
    }
  }, [ready, syncModelToggleState]);

  useEffect(() => {
    if (!ready) {
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
      void saveGlobalSettings(settingsRef.current).catch(() => {});
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
      updateSettings,
      refreshModels,
      modelsRefreshing,
      saveModelToggleUpdates,
    }),
    [ready, settings, updateSettings, refreshModels, modelsRefreshing, saveModelToggleUpdates]
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
