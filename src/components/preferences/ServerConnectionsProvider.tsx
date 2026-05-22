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
  applyServerUrlBootstrap,
  getSettingsServerConnection,
  requiresDefaultServerSelection,
  setDefaultServerConnection,
  upsertServerConnection,
  type ServerConnection,
  type ServerConnectionsState,
} from "@/lib/server-connections";
import {
  SERVER_CONNECTIONS_EVENT,
  getActiveServerConnection,
  getServerConnectionKey,
  markServerConnectionUsed,
  normalizeServerBaseUrl,
  readStoredServerConnectionsState,
  removeServerConnection,
  writeStoredServerConnectionsState,
} from "@/lib/server-connections-provider-shared";
import {
  parseServerUrlSearchParam,
  stripServerUrlSearchParamFromLocation,
} from "@/lib/resolve-server-base-url";
import {
  probeServerBaseUrl,
  type ServerProbeResult,
} from "@/lib/server-connection-health";

type ServerConnectionsContextValue = {
  ready: boolean;
  state: ServerConnectionsState;
  servers: ServerConnection[];
  serverStatusById: Record<string, ServerRuntimeStatus>;
  onlineServers: ServerConnection[];
  activeServer: ServerConnection;
  settingsServer: ServerConnection | null;
  requiresDefaultServer: boolean;
  setActiveServer: (serverId: string) => void;
  setDefaultServer: (serverId: string) => void;
  saveServer: (input: { id?: string; label?: string; baseUrl: string }) => ServerConnection;
  removeServer: (serverId: string) => void;
  probeServer: (baseUrl: string) => Promise<ServerProbeResult>;
  refreshServerHealth: () => Promise<Record<string, ServerRuntimeStatus>>;
};

const ServerConnectionsContext = createContext<ServerConnectionsContextValue | null>(null);

export type ServerRuntimeHealth = "unknown" | "online" | "offline" | "auth_required" | "degraded";

export type ServerRuntimeStatus = {
  health: ServerRuntimeHealth;
  lastCheckedAt: number | null;
  lastOnlineAt: number | null;
  error: string | null;
  authEnabled: boolean | null;
  authenticated: boolean | null;
};

function statusFromProbe(probe: ServerProbeResult, now = Date.now()): ServerRuntimeStatus {
  const health: ServerRuntimeHealth = probe.ok
    ? probe.authEnabled && probe.authenticated === false
      ? "auth_required"
      : "online"
    : "offline";
  return {
    health,
    lastCheckedAt: now,
    lastOnlineAt: probe.ok ? now : null,
    error: probe.error,
    authEnabled: probe.authEnabled,
    authenticated: probe.authenticated,
  };
}

function connectionDedupeKey(server: ServerConnection): string {
  return getServerConnectionKey(server.baseUrl);
}

function dedupeServersByResolvedBaseUrl(servers: ServerConnection[]): ServerConnection[] {
  const byResolved = new Map<string, ServerConnection>();
  for (const server of servers) {
    const key = connectionDedupeKey(server);
    const existing = byResolved.get(key);
    if (!existing || server.lastUsedAt > existing.lastUsedAt) {
      byResolved.set(key, server);
    }
  }
  return [...byResolved.values()];
}

export function ServerConnectionsProvider({ children }: { children: ReactNode }) {
  const [ready, setReady] = useState(false);
  const [state, setState] = useState<ServerConnectionsState>(() => readStoredServerConnectionsState());
  const [serverStatusById, setServerStatusById] = useState<Record<string, ServerRuntimeStatus>>({});
  const healthRecoveryRanRef = useRef(false);

  useEffect(() => {
    const sync = () => {
      setState(readStoredServerConnectionsState());
      setReady(true);
    };
    sync();
    const onStorage = (event: StorageEvent) => {
      if (event.key !== null && event.key !== "opencursor.server-connections") {
        return;
      }
      sync();
    };
    window.addEventListener("storage", onStorage);
    window.addEventListener(SERVER_CONNECTIONS_EVENT, sync as EventListener);
    return () => {
      window.removeEventListener("storage", onStorage);
      window.removeEventListener(SERVER_CONNECTIONS_EVENT, sync as EventListener);
    };
  }, []);

  useEffect(() => {
    if (typeof window === "undefined") {
      return;
    }
    const candidate = parseServerUrlSearchParam(window.location.search);
    if (!candidate) {
      return;
    }
    const isElectron = Boolean(
      (window as Window & { cesiumDesktop?: { isElectron?: boolean } }).cesiumDesktop?.isElectron
    );
    setState((current) => {
      const next = applyServerUrlBootstrap(current, candidate, {
        force: isElectron,
        isElectron,
      });
      if (next !== current) {
        writeStoredServerConnectionsState(next);
      }
      return next;
    });
    stripServerUrlSearchParamFromLocation();
  }, []);

  useEffect(() => {
    if (!ready || healthRecoveryRanRef.current) {
      return;
    }
    healthRecoveryRanRef.current = true;
    let cancelled = false;

    void (async () => {
      await new Promise<void>((resolve) => {
        queueMicrotask(resolve);
      });
      const current = readStoredServerConnectionsState();
      const active =
        current.servers.find((server) => server.id === current.activeServerId) ??
        current.servers[0];
      if (!active) {
        return;
      }
      const activeProbe = await probeServerBaseUrl(active.baseUrl);
      setServerStatusById((current) => ({
        ...current,
        [active.id]: statusFromProbe(activeProbe),
      }));
      if (cancelled || activeProbe.ok) {
        return;
      }
      const candidates = [...current.servers].sort((a, b) => b.lastUsedAt - a.lastUsedAt);
      for (const candidate of candidates) {
        if (candidate.id === active.id) {
          continue;
        }
        const probe = await probeServerBaseUrl(candidate.baseUrl);
        setServerStatusById((current) => ({
          ...current,
          [candidate.id]: statusFromProbe(probe),
        }));
        if (!probe.ok) {
          continue;
        }
        if (cancelled) {
          return;
        }
        setState((current) => {
          const next = markServerConnectionUsed(current, candidate.id);
          writeStoredServerConnectionsState(next);
          return next;
        });
        return;
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [ready]);

  const refreshServerHealth = useCallback(async () => {
    const entries = await Promise.all(
      state.servers.map(async (server) => {
        const probe = await probeServerBaseUrl(server.baseUrl);
        return [server.id, statusFromProbe(probe)] as const;
      })
    );
    const next = Object.fromEntries(entries);
    setServerStatusById(next);
    return next;
  }, [state.servers]);

  useEffect(() => {
    if (!ready) {
      return;
    }
    void refreshServerHealth().catch(() => undefined);
    const interval = window.setInterval(() => {
      void refreshServerHealth().catch(() => undefined);
    }, 30_000);
    return () => window.clearInterval(interval);
  }, [ready, refreshServerHealth]);

  const setActiveServer = useCallback((serverId: string) => {
    setState((current) => {
      const next = markServerConnectionUsed(current, serverId);
      writeStoredServerConnectionsState(next);
      return next;
    });
  }, []);

  const setDefaultServer = useCallback((serverId: string) => {
    setState((current) => {
      const next = setDefaultServerConnection(current, serverId);
      writeStoredServerConnectionsState(next);
      return next;
    });
  }, []);

  const saveServer = useCallback((input: { id?: string; label?: string; baseUrl: string }) => {
    let savedServer: ServerConnection | null = null;
    setState((current) => {
      const next = upsertServerConnection(current, input);
      savedServer =
        next.servers.find((server) => server.id === input.id) ??
        next.servers.find(
          (server) =>
            getServerConnectionKey(server.baseUrl) ===
            getServerConnectionKey(normalizeServerBaseUrl(input.baseUrl))
        ) ??
        next.servers[0] ??
        null;
      writeStoredServerConnectionsState(next);
      return next;
    });
    return savedServer ?? getActiveServerConnection();
  }, []);

  const deleteServer = useCallback((serverId: string) => {
    setState((current) => {
      const next = removeServerConnection(current, serverId);
      writeStoredServerConnectionsState(next);
      return next;
    });
  }, []);

  const value = useMemo<ServerConnectionsContextValue>(() => {
    const activeServer =
      state.servers.find((server) => server.id === state.activeServerId) ??
      state.servers[0] ??
      getActiveServerConnection();
    const onlineServers = dedupeServersByResolvedBaseUrl(state.servers).filter((server) => {
      const health = serverStatusById[server.id]?.health ?? "unknown";
      return health === "online" || health === "auth_required";
    });
    const settingsServer = getSettingsServerConnection(state);
    return {
      ready,
      state,
      servers: state.servers,
      serverStatusById,
      onlineServers,
      activeServer,
      settingsServer,
      requiresDefaultServer: requiresDefaultServerSelection(state),
      setActiveServer,
      setDefaultServer,
      saveServer,
      removeServer: deleteServer,
      probeServer: probeServerBaseUrl,
      refreshServerHealth,
    };
  }, [
    deleteServer,
    ready,
    refreshServerHealth,
    saveServer,
    serverStatusById,
    setActiveServer,
    setDefaultServer,
    state,
  ]);

  return (
    <ServerConnectionsContext.Provider value={value}>
      {children}
    </ServerConnectionsContext.Provider>
  );
}

export function useServerConnections(): ServerConnectionsContextValue {
  const context = useContext(ServerConnectionsContext);
  if (!context) {
    throw new Error("useServerConnections must be used within ServerConnectionsProvider");
  }
  return context;
}
