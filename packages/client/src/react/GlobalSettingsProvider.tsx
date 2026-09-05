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
  readCachedGlobalSettings,
  writeCachedGlobalSettings,
} from "../global-settings-cache";
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

type GlobalSettingsContextValue = {
  settings: GlobalSettingsState;
  ready: boolean;
  /**
   * True once the in-memory settings were fetched from the current settings
   * server (as opposed to factory defaults or the offline cache). One-time
   * migrations and cloud pushes gate on this so a failed boot fetch can never
   * leak stale or default state into a durable store.
   */
  hydrated: boolean;
  /**
   * Increments on every user-originated edit (`updateSettings` returning a
   * new object). Hydration from an engine, cache seeding, and model-toggle
   * syncs do not bump it, so account sync can tell "the user changed
   * something here" apart from "this device loaded another engine's copy".
   */
  editVersion: number;
  settingsServerId: string | null;
  settingsServerMissing: boolean;
  updateSettings: (
    updater: (current: GlobalSettingsState) => GlobalSettingsState
  ) => void;
  /**
   * Replace settings from the account document. Behaves like a hydration for
   * edit tracking (no `editVersion` bump) but, unlike a server fetch, is
   * persisted to the settings server as soon as one is hydrated.
   */
  applyAccountSettings: (
    updater: (current: GlobalSettingsState) => GlobalSettingsState
  ) => void;
  /** Re-fetch global settings from the server without writing local state back. */
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
  /**
   * True only after global settings were successfully fetched for the current
   * settings server. Every PUT is gated on this: a client that has never seen
   * the server's real settings holds factory defaults (or another context's
   * state) in memory, and persisting that would permanently overwrite the
   * user's saved customizations — the "server hiccuped and everything
   * reverted" wipe.
   */
  const hydratedFromServerRef = useRef(false);
  const [hydrated, setHydrated] = useState(false);
  const markHydrated = useCallback((value: boolean) => {
    hydratedFromServerRef.current = value;
    setHydrated(value);
  }, []);
  const settingsServerIdRef = useRef<string | null>(null);
  const seededCacheServerIdRef = useRef<string | null>(null);
  const saveTimerRef = useRef<number | null>(null);
  const modelToggleQueueRef = useRef<Map<string, ModelToggleUpdate>>(new Map());
  const modelToggleTimerRef = useRef<number | null>(null);
  const modelToggleEpochRef = useRef(0);

  const settingsRequestContext = useMemo(
    () => (settingsServer ? toServerRequestContext(settingsServer) : null),
    [settingsServer]
  );
  const settingsServerId = settingsServer?.id ?? null;

  useEffect(() => {
    settingsServerRef.current = settingsRequestContext;
  }, [settingsRequestContext]);

  useEffect(() => {
    settingsServerIdRef.current = settingsServerId;
  }, [settingsServerId]);

  // Seed last-known-good settings from the per-server local cache so a boot
  // while the settings server is unreachable renders the user's customizations
  // instead of factory defaults. The server stays the source of truth: a
  // successful fetch below replaces this state, and the hydration gate keeps
  // seeded state from ever being saved back.
  useEffect(() => {
    if (!settingsServerId || seededCacheServerIdRef.current === settingsServerId) {
      return;
    }
    seededCacheServerIdRef.current = settingsServerId;
    const cached = readCachedGlobalSettings(settingsServerId);
    if (cached) {
      skipNextSaveRef.current = true;
      setSettings(cached);
    }
  }, [settingsServerId]);

  useEffect(() => {
    settingsRef.current = settings;
  }, [settings]);

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

      await flushModelToggleUpdates();
      const server = settingsServerRef.current;
      if (!server) {
        return;
      }
      if (!hydratedFromServerRef.current) {
        // Never flush state that was not hydrated from the server. After a
        // failed boot fetch this is factory defaults; the pagehide/visibility
        // flush would persist them and wipe the user's saved customizations.
        return;
      }
      await saveGlobalSettings(settingsRef.current, { ...options, server }).catch(() => {});
    },
    [flushModelToggleUpdates, ready]
  );

  useEffect(() => {
    let mounted = true;

    // Any settings-server/context change invalidates hydration; saves stay
    // blocked until a fetch against the new context succeeds.
    markHydrated(false);

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
        const normalized = normalizeLoadedGlobalSettings(result.settings);
        markHydrated(true);
        const serverId = settingsServerIdRef.current;
        if (serverId) {
          writeCachedGlobalSettings(serverId, normalized);
        }
        skipNextSaveRef.current = true;
        setSettings(normalized);
      } catch {
        // Logged-out, offline, or stale-auth startup keeps the cache-seeded
        // state (or defaults); the workbench stays mounted and in-app surfaces
        // own connect/sign-in UX. hydratedFromServerRef stays false so this
        // state can never be saved over the server's copy; the visibility
        // handler refetches once the app regains focus/connectivity.
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
  }, [markHydrated, serverSettingsEnabled, settingsRequestContext]);

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
      const normalized = normalizeLoadedGlobalSettings(result.settings);
      markHydrated(true);
      const serverId = settingsServerIdRef.current;
      if (serverId) {
        writeCachedGlobalSettings(serverId, normalized);
      }
      skipNextSaveRef.current = true;
      setSettings(normalized);
    } catch {
      // Offline or auth; keep in-memory state.
    }
  }, [markHydrated]);

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

    if (!hydratedFromServerRef.current) {
      // A failed boot fetch leaves factory defaults (or cache-seeded state) in
      // memory; without this gate the `ready` flip alone scheduled a PUT that
      // permanently overwrote the server's saved settings with defaults.
      // Edits made before hydration stay in memory until a fetch succeeds.
      return;
    }

    const serverId = settingsServerIdRef.current;
    if (serverId) {
      // Mirror hydrated local edits so an offline relaunch keeps them visible.
      writeCachedGlobalSettings(serverId, settings);
    }

    if (saveTimerRef.current) {
      cancelTimeout(saveTimerRef.current);
    }

    saveTimerRef.current = scheduleTimeout(() => {
      const server = settingsServerRef.current;
      if (!server) {
        return;
      }
      void saveGlobalSettings(settingsRef.current, { server }).catch(() => {});
    }, SAVE_DEBOUNCE_MS);

    return () => {
      if (saveTimerRef.current) {
        cancelTimeout(saveTimerRef.current);
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

    const intervalId = setInterval(() => {
      void syncModelToggleState();
    }, MODEL_SYNC_INTERVAL_MS);

    // Page lifecycle hooks only exist on web; RN relies on AppState-driven
    // flushes from the host app plus the periodic sync above.
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
    refetchGlobalSettingsFromServer,
    syncModelToggleState,
  ]);

  const [editVersion, setEditVersion] = useState(0);
  const updateSettings = useCallback(
    (updater: (current: GlobalSettingsState) => GlobalSettingsState) => {
      setSettings((current) => {
        const next = updater(current);
        if (next !== current) {
          setEditVersion((version) => version + 1);
        }
        return next;
      });
    },
    []
  );

  const applyAccountSettings = useCallback(
    (updater: (current: GlobalSettingsState) => GlobalSettingsState) => {
      setSettings((current) => updater(current));
    },
    []
  );

  const value = useMemo(
    () => ({
      settings,
      ready,
      hydrated,
      editVersion,
      settingsServerId: settingsServer?.id ?? null,
      settingsServerMissing: requiresDefaultServer,
      updateSettings,
      applyAccountSettings,
      refreshSettings: refetchGlobalSettingsFromServer,
      refreshModels,
      modelsRefreshing,
      modelToggleSaveState,
      saveModelToggleUpdates,
    }),
    [
      applyAccountSettings,
      editVersion,
      hydrated,
      ready,
      requiresDefaultServer,
      settings,
      settingsServer?.id,
      updateSettings,
      refetchGlobalSettingsFromServer,
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
