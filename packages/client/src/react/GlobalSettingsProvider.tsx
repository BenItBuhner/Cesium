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
  APP_SETTINGS_EVENT,
  APP_SETTINGS_STORAGE_KEY,
  hasCompletedAppSettingsMigration,
  markAppSettingsMigrationComplete,
  mergeEngineOwnedSettings,
  readLegacyDefaultServerId,
  readStoredAppSettings,
  serializeAppSettings,
  writeStoredAppSettings,
} from "../app-settings";
import {
  createDefaultGlobalSettings,
  normalizeLoadedGlobalSettings,
  type GlobalSettingsState,
} from "../global-settings";
import {
  fetchGlobalSettings,
  fetchModelToggleState,
  refreshModelToggleState,
  saveEngineAgentFlags,
  saveModelToggles,
  toServerRequestContext,
  type ModelToggleUpdate,
  type ServerRequestContext,
} from "../server-api";
import {
  createDefaultThemeConfig,
  loadThemeConfigFromStorage,
  serializeThemeConfig,
} from "../theme-config";
import { useServerConnections } from "./ServerConnectionsProvider";
import { getClientPlatform } from "../platform";
import { recordPerfSample } from "../dev-perf";

/**
 * Client-first app settings.
 *
 * The client store ({@link APP_SETTINGS_STORAGE_KEY}) is the source of truth
 * for all personalization: theme, shortcuts, layout, agent UI toggles, and
 * features. It is available synchronously, works offline, and (for signed-in
 * users) is mirrored to the cloud account by the cloud context.
 *
 * The engine-owned residue — model toggles, remembered permission rules, and
 * the enforcement flags the engine reads during agent runs — is hydrated from
 * the ACTIVE server and pushed back to it. There is no "default settings
 * server" anymore.
 */

type GlobalSettingsContextValue = {
  settings: GlobalSettingsState;
  ready: boolean;
  updateSettings: (
    updater: (current: GlobalSettingsState) => GlobalSettingsState
  ) => void;
  /** Re-hydrate engine-owned state (permissions, models) from the active server. */
  refreshSettings: () => Promise<void>;
  refreshModels: () => Promise<void>;
  modelsRefreshing: boolean;
  modelToggleSaveState: { pending: number; error: string | null };
  saveModelToggleUpdates: (updates: ModelToggleUpdate[]) => Promise<void>;
};

const GlobalSettingsContext =
  createContext<GlobalSettingsContextValue | null>(null);

const LOCAL_PERSIST_DEBOUNCE_MS = 250;
const ENGINE_FLAG_PUSH_DEBOUNCE_MS = 400;
const MODEL_TOGGLE_SAVE_DEBOUNCE_MS = 160;
const MODEL_SYNC_INTERVAL_MS = 5 * 60 * 1000;
const LEGACY_IMPORT_TIMEOUT_MS = 5_000;

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

/** Fold whatever theming this device already shows into a settings document. */
function withLocalThemeConfig(settings: GlobalSettingsState): GlobalSettingsState {
  const local = loadThemeConfigFromStorage();
  const baseline = createDefaultThemeConfig();
  if (serializeThemeConfig(local) === serializeThemeConfig(baseline)) {
    return settings;
  }
  return { ...settings, themeConfig: local };
}

type EngineAgentFlags = {
  autoAcceptAllAgentPermissions: boolean;
  mcpProt: boolean;
};

export function GlobalSettingsProvider({
  children,
  serverSettingsEnabled = true,
}: {
  children: ReactNode;
  /** Gates engine-owned hydration (e.g. while the active engine still needs auth). */
  serverSettingsEnabled?: boolean;
}) {
  const { activeServer, servers } = useServerConnections();
  const serversRef = useRef(servers);
  serversRef.current = servers;
  const [settings, setSettings] = useState<GlobalSettingsState>(
    () => readStoredAppSettings() ?? createDefaultState()
  );
  const [ready, setReady] = useState<boolean>(
    () => readStoredAppSettings() !== null
  );
  const [modelsRefreshing, setModelsRefreshing] = useState(false);
  const [modelToggleSaveState, setModelToggleSaveState] = useState<{
    pending: number;
    error: string | null;
  }>({ pending: 0, error: null });

  const settingsRef = useRef(settings);
  const readyRef = useRef(ready);
  /** Serialized client-owned doc that matches what storage currently holds. */
  const lastPersistedRef = useRef<string | null>(
    ready ? serializeAppSettings(settings) : null
  );
  const persistTimerRef = useRef<number | null>(null);
  /** Engine flags as last confirmed on the active engine; null until hydrated. */
  const engineFlagsRef = useRef<EngineAgentFlags | null>(null);
  const engineFlagPushTimerRef = useRef<number | null>(null);
  const engineContextRef = useRef<ServerRequestContext | null>(null);
  const migrationStartedRef = useRef(false);
  const modelToggleQueueRef = useRef<Map<string, ModelToggleUpdate>>(new Map());
  const modelToggleTimerRef = useRef<number | null>(null);
  const modelToggleEpochRef = useRef(0);

  const engineContext = useMemo(
    () => toServerRequestContext(activeServer),
    [activeServer]
  );

  useEffect(() => {
    engineContextRef.current = engineContext;
  }, [engineContext]);

  useEffect(() => {
    settingsRef.current = settings;
  }, [settings]);

  useEffect(() => {
    readyRef.current = ready;
  }, [ready]);

  /* ---------------------------------------------------------------------- */
  /* One-time legacy migration (engine blob → client store)                  */
  /* ---------------------------------------------------------------------- */

  useEffect(() => {
    if (ready || migrationStartedRef.current) {
      return;
    }
    migrationStartedRef.current = true;
    let cancelled = false;

    void (async () => {
      if (hasCompletedAppSettingsMigration()) {
        // Import already ran; the stored doc was cleared out-of-band. Reseed.
        const seeded = withLocalThemeConfig(createDefaultState());
        if (!cancelled) {
          lastPersistedRef.current = serializeAppSettings(seeded);
          writeStoredAppSettings(seeded);
          setSettings((current) => mergeEngineOwnedSettings(seeded, current));
          setReady(true);
        }
        return;
      }
      // Pre-refactor releases kept preferences on the "default settings
      // server" (falling back to the active one). Import that blob once.
      const legacyDefaultId = readLegacyDefaultServerId();
      const legacyDefault = legacyDefaultId
        ? serversRef.current.find((server) => server.id === legacyDefaultId)
        : undefined;
      const importServer = legacyDefault
        ? toServerRequestContext(legacyDefault)
        : engineContextRef.current;
      let imported: GlobalSettingsState | null = null;
      try {
        const timeout = new Promise<never>((_, reject) => {
          scheduleTimeout(
            () => reject(new Error("Legacy settings import timed out.")),
            LEGACY_IMPORT_TIMEOUT_MS
          );
        });
        const result = await Promise.race([
          fetchGlobalSettings({ server: importServer ?? undefined }),
          timeout,
        ]);
        imported = normalizeLoadedGlobalSettings(result.settings);
      } catch {
        imported = null;
      }
      if (cancelled) {
        return;
      }
      if (imported) {
        const seeded = withLocalThemeConfig(imported);
        lastPersistedRef.current = serializeAppSettings(seeded);
        writeStoredAppSettings(seeded);
        markAppSettingsMigrationComplete();
        setSettings((current) => mergeEngineOwnedSettings(seeded, current));
        setReady(true);
        return;
      }
      // Engine unreachable: run with local defaults, but do not persist or
      // mark migration complete — an untouched client retries next launch.
      const seeded = withLocalThemeConfig(createDefaultState());
      lastPersistedRef.current = serializeAppSettings(seeded);
      setSettings((current) => mergeEngineOwnedSettings(seeded, current));
      setReady(true);
    })();

    return () => {
      cancelled = true;
    };
  }, [ready]);

  /* ---------------------------------------------------------------------- */
  /* Local persistence (client store is the source of truth)                 */
  /* ---------------------------------------------------------------------- */

  const flushLocalPersist = useCallback(() => {
    if (persistTimerRef.current) {
      cancelTimeout(persistTimerRef.current);
      persistTimerRef.current = null;
    }
    if (!readyRef.current) {
      return;
    }
    const serialized = serializeAppSettings(settingsRef.current);
    if (serialized === lastPersistedRef.current) {
      return;
    }
    lastPersistedRef.current = serialized;
    writeStoredAppSettings(settingsRef.current);
  }, []);

  useEffect(() => {
    if (!ready) {
      return;
    }
    const serialized = serializeAppSettings(settings);
    if (serialized === lastPersistedRef.current) {
      return;
    }
    if (persistTimerRef.current) {
      cancelTimeout(persistTimerRef.current);
    }
    persistTimerRef.current = scheduleTimeout(() => {
      persistTimerRef.current = null;
      flushLocalPersist();
    }, LOCAL_PERSIST_DEBOUNCE_MS);
    return () => {
      if (persistTimerRef.current) {
        cancelTimeout(persistTimerRef.current);
      }
    };
  }, [ready, settings, flushLocalPersist]);

  // External updates: cloud personalization applies, other tabs, import flows.
  useEffect(() => {
    const applyStored = () => {
      const stored = readStoredAppSettings();
      if (!stored) {
        return;
      }
      const serialized = serializeAppSettings(stored);
      if (serialized === lastPersistedRef.current) {
        return;
      }
      lastPersistedRef.current = serialized;
      setSettings((current) => mergeEngineOwnedSettings(stored, current));
      setReady(true);
    };
    const platform = getClientPlatform();
    const unsubscribe = platform.addEventListener(APP_SETTINGS_EVENT, applyStored);
    const onStorage = (event: StorageEvent) => {
      if (event.key !== null && event.key !== APP_SETTINGS_STORAGE_KEY) {
        return;
      }
      applyStored();
    };
    const canUseWindowEvents =
      typeof window !== "undefined" && typeof window.addEventListener === "function";
    if (canUseWindowEvents) {
      window.addEventListener("storage", onStorage);
    }
    return () => {
      unsubscribe();
      if (canUseWindowEvents) {
        window.removeEventListener("storage", onStorage);
      }
    };
  }, []);

  /* ---------------------------------------------------------------------- */
  /* Engine-owned state: hydrate from + push to the ACTIVE server            */
  /* ---------------------------------------------------------------------- */

  const hydrateEngineState = useCallback(async () => {
    const server = engineContextRef.current;
    if (!server) {
      return;
    }
    try {
      const result = await fetchGlobalSettings({ server });
      const engine = normalizeLoadedGlobalSettings(result.settings);
      if (engineContextRef.current?.baseUrl !== server.baseUrl) {
        return;
      }
      engineFlagsRef.current = {
        autoAcceptAllAgentPermissions: engine.agents.autoAcceptAllAgentPermissions,
        mcpProt: engine.agents.mcpProt,
      };
      setSettings((current) => mergeEngineOwnedSettings(current, engine));
    } catch {
      // Engine offline or auth pending; keep whatever we have.
    }
  }, []);

  const syncModelToggleState = useCallback(async () => {
    const server = engineContextRef.current;
    if (!server) {
      return;
    }
    try {
      const result = await fetchModelToggleState({ server });
      if (engineContextRef.current?.baseUrl !== server.baseUrl) {
        return;
      }
      setSettings((current) => ({
        ...current,
        models: { byBackend: result.byBackend },
      }));
    } catch {
      // Silently ignore; existing state remains valid.
    }
  }, []);

  useEffect(() => {
    if (!ready || !serverSettingsEnabled) {
      return;
    }
    // Server switch: the previous engine's flags are no longer authoritative.
    engineFlagsRef.current = null;
    let cancelled = false;
    void (async () => {
      await hydrateEngineState();
      if (!cancelled) {
        await syncModelToggleState();
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [ready, serverSettingsEnabled, engineContext.baseUrl, hydrateEngineState, syncModelToggleState]);

  // Push engine-enforced flags when the user changes them locally.
  useEffect(() => {
    const engineFlags = engineFlagsRef.current;
    if (!ready || !serverSettingsEnabled || !engineFlags) {
      return;
    }
    const next: EngineAgentFlags = {
      autoAcceptAllAgentPermissions: settings.agents.autoAcceptAllAgentPermissions,
      mcpProt: settings.agents.mcpProt,
    };
    if (
      next.autoAcceptAllAgentPermissions === engineFlags.autoAcceptAllAgentPermissions &&
      next.mcpProt === engineFlags.mcpProt
    ) {
      return;
    }
    if (engineFlagPushTimerRef.current) {
      cancelTimeout(engineFlagPushTimerRef.current);
    }
    engineFlagPushTimerRef.current = scheduleTimeout(() => {
      engineFlagPushTimerRef.current = null;
      const server = engineContextRef.current;
      if (!server) {
        return;
      }
      void saveEngineAgentFlags(next, { server })
        .then(() => {
          engineFlagsRef.current = next;
        })
        .catch(() => {
          // Retry on the next change; the engine remains authoritative.
        });
    }, ENGINE_FLAG_PUSH_DEBOUNCE_MS);
    return () => {
      if (engineFlagPushTimerRef.current) {
        cancelTimeout(engineFlagPushTimerRef.current);
      }
    };
  }, [ready, serverSettingsEnabled, settings.agents.autoAcceptAllAgentPermissions, settings.agents.mcpProt]);

  /* ---------------------------------------------------------------------- */
  /* Model toggles (active server)                                           */
  /* ---------------------------------------------------------------------- */

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
      const server = engineContextRef.current;
      if (!server) {
        setModelToggleSaveState({ pending: 0, error: "No active server to save model toggles." });
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

  const refreshModels = useCallback(async () => {
    const server = engineContextRef.current;
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

  /* ---------------------------------------------------------------------- */
  /* Lifecycle: flush on hide, refresh on show                               */
  /* ---------------------------------------------------------------------- */

  useEffect(() => {
    if (!ready) {
      return;
    }

    const flushForPageHide = () => {
      flushLocalPersist();
      void flushModelToggleUpdates();
    };

    const handleVisibilityChange = () => {
      if (document.visibilityState === "hidden") {
        flushForPageHide();
      } else if (document.visibilityState === "visible") {
        void (async () => {
          await hydrateEngineState();
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
    flushLocalPersist,
    flushModelToggleUpdates,
    hydrateEngineState,
    ready,
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
      refreshSettings: hydrateEngineState,
      refreshModels,
      modelsRefreshing,
      modelToggleSaveState,
      saveModelToggleUpdates,
    }),
    [
      ready,
      settings,
      updateSettings,
      hydrateEngineState,
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
