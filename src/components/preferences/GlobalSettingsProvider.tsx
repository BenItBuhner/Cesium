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
  type GlobalSettingsState,
} from "@/lib/global-settings";
import { availableModels, currentModel } from "@/lib/mock-data";
import { fetchGlobalSettings, saveGlobalSettings } from "@/lib/server-api";

type GlobalSettingsContextValue = {
  settings: GlobalSettingsState;
  ready: boolean;
  updateSettings: (
    updater: (current: GlobalSettingsState) => GlobalSettingsState
  ) => void;
};

const GlobalSettingsContext =
  createContext<GlobalSettingsContextValue | null>(null);

const SAVE_DEBOUNCE_MS = 500;

function createDefaultState(): GlobalSettingsState {
  return createDefaultGlobalSettings(
    availableModels.map((model) => ({
      id: model.id,
      name: model.name,
      on: model.id === currentModel.id,
    }))
  );
}

export function GlobalSettingsProvider({ children }: { children: ReactNode }) {
  const [settings, setSettings] = useState<GlobalSettingsState>(createDefaultState);
  const [ready, setReady] = useState(false);
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

      await saveGlobalSettings(settingsRef.current, options).catch(() => {
        // Ignore flush failures; background saves will retry on future changes.
      });
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
        setSettings(result.settings ?? createDefaultState());
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
      void saveGlobalSettings(settingsRef.current).catch(() => {
        // Ignore background save failures and keep the optimistic UI state.
      });
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
      }
    };

    window.addEventListener("pagehide", flushForPageHide);
    window.addEventListener("beforeunload", flushForPageHide);
    document.addEventListener("visibilitychange", handleVisibilityChange);

    return () => {
      window.removeEventListener("pagehide", flushForPageHide);
      window.removeEventListener("beforeunload", flushForPageHide);
      document.removeEventListener("visibilitychange", handleVisibilityChange);
    };
  }, [flushGlobalSettingsNow, ready]);

  const updateSettings = useCallback(
    (updater: (current: GlobalSettingsState) => GlobalSettingsState) => {
      setSettings((current) => updater(current));
    },
    []
  );

  const value = useMemo(
    () => ({ settings, ready, updateSettings }),
    [ready, settings, updateSettings]
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
