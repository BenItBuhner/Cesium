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
  applyRendezvousBootstrap,
  applyServerUrlBootstrap,
  getSettingsServerConnection,
  requiresDefaultServerSelection,
  setDefaultServerConnection,
  updateRendezvousServerEndpoint,
  upsertServerConnection,
  type ServerConnection,
  type ServerConnectionsState,
} from "../server-connections";
import {
  parseRendezvousBootstrapHash,
  resolveRendezvousEndpoint,
  stripRendezvousBootstrapFromLocation,
  type RendezvousBootstrap,
} from "../rendezvous";
import { migrateStoredAuthServerBaseUrl } from "../auth-client";
import {
  SERVER_CONNECTIONS_EVENT,
  getActiveServerConnectionFromDefaults as getActiveServerConnection,
  getServerConnectionKey,
  markServerConnectionUsed,
  normalizeServerBaseUrl,
  readActiveServerConnectionsState as readStoredServerConnectionsState,
  removeServerConnectionWithDefaults as removeServerConnection,
  writeStoredServerConnectionsState,
} from "../server-connections-provider-shared";
import {
  parseServerUrlSearchParam,
  stripServerUrlSearchParamFromLocation,
} from "../resolve-server-base-url";
import {
  probeServerBaseUrl,
  type ServerProbeResult,
} from "../server-connection-health";
import { clientLocation, getClientPlatform } from "../platform";

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
  baseUrl: string;
  health: ServerRuntimeHealth;
  lastCheckedAt: number | null;
  lastOnlineAt: number | null;
  error: string | null;
  authEnabled: boolean | null;
  authenticated: boolean | null;
};

function statusFromProbe(
  baseUrl: string,
  probe: ServerProbeResult,
  now = Date.now()
): ServerRuntimeStatus {
  const health: ServerRuntimeHealth = probe.ok
    ? probe.authEnabled && probe.authenticated === false
      ? "auth_required"
      : "online"
    : "offline";
  return {
    baseUrl,
    health,
    lastCheckedAt: now,
    lastOnlineAt: probe.ok ? now : null,
    error: probe.error,
    authEnabled: probe.authEnabled,
    authenticated: probe.authenticated,
  };
}

function sameRuntimeStatus(
  current: ServerRuntimeStatus | undefined,
  next: ServerRuntimeStatus | undefined
): boolean {
  if (!current || !next) return current === next;
  return (
    current.health === next.health &&
    current.baseUrl === next.baseUrl &&
    current.lastCheckedAt === next.lastCheckedAt &&
    current.lastOnlineAt === next.lastOnlineAt &&
    current.error === next.error &&
    current.authEnabled === next.authEnabled &&
    current.authenticated === next.authenticated
  );
}

function upsertRuntimeStatusIfChanged(
  current: Record<string, ServerRuntimeStatus>,
  serverId: string,
  nextStatus: ServerRuntimeStatus
): Record<string, ServerRuntimeStatus> {
  const previous = current[serverId];
  const mergedStatus =
    nextStatus.lastOnlineAt === null && previous?.baseUrl === nextStatus.baseUrl
      ? { ...nextStatus, lastOnlineAt: previous.lastOnlineAt }
      : nextStatus;
  if (sameRuntimeStatus(previous, mergedStatus)) {
    return current;
  }
  return {
    ...current,
    [serverId]: mergedStatus,
  };
}

function mergeRuntimeStatusesIfChanged(
  current: Record<string, ServerRuntimeStatus>,
  next: Record<string, ServerRuntimeStatus>
): Record<string, ServerRuntimeStatus> {
  const currentKeys = Object.keys(current);
  const nextKeys = Object.keys(next);
  if (
    currentKeys.length === nextKeys.length &&
    nextKeys.every((key) => sameRuntimeStatus(current[key], next[key]))
  ) {
    return current;
  }
  return next;
}

function connectionDedupeKey(server: ServerConnection): string {
  return server.rendezvous
    ? `rendezvous:${server.rendezvous.serverId}`
    : getServerConnectionKey(server.baseUrl);
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
  const healthRefreshEpochRef = useRef(0);
  const serversRef = useRef<ServerConnection[]>(state.servers);
  serversRef.current = state.servers;

  useEffect(() => {
    const sync = () => {
      setState(readStoredServerConnectionsState());
    };
    let cancelled = false;
    void (async () => {
      let next = readStoredServerConnectionsState();
      const location = clientLocation();
      let bootstrap: RendezvousBootstrap | null = null;
      if (location?.href) {
        try {
          bootstrap = parseRendezvousBootstrapHash(new URL(location.href).hash);
        } catch {
          bootstrap = null;
        }
      }
      if (bootstrap) {
        let resolvedBaseUrl = bootstrap.initialBaseUrl ?? null;
        let resolvedLabel = bootstrap.label;
        try {
          const resolved = await resolveRendezvousEndpoint(bootstrap);
          if (resolved) {
            resolvedBaseUrl = resolved.baseUrl;
            resolvedLabel = resolved.label ?? resolvedLabel;
          }
        } catch {
          // The encrypted identity is still persisted below when the link carries
          // its initial endpoint; polling will recover a temporarily unavailable registry.
        }
        if (resolvedBaseUrl) {
          next = applyRendezvousBootstrap(next, {
            locator: {
              version: 1,
              serverId: bootstrap.serverId,
              secret: bootstrap.secret,
              registryBaseUrl: bootstrap.registryBaseUrl,
            },
            baseUrl: resolvedBaseUrl,
            label: resolvedLabel,
          });
          writeStoredServerConnectionsState(next);
        }
        stripRendezvousBootstrapFromLocation();
      }
      if (!cancelled) {
        setState(next);
        setReady(true);
      }
    })();
    const unsubscribeChange = getClientPlatform().addEventListener(
      SERVER_CONNECTIONS_EVENT,
      sync
    );
    const onStorage = (event: StorageEvent) => {
      if (event.key !== null && event.key !== "opencursor.server-connections") {
        return;
      }
      sync();
    };
    const canUseWindowEvents =
      typeof window !== "undefined" && typeof window.addEventListener === "function";
    if (canUseWindowEvents) {
      window.addEventListener("storage", onStorage);
    }
    return () => {
      cancelled = true;
      unsubscribeChange();
      if (canUseWindowEvents) {
        window.removeEventListener("storage", onStorage);
      }
    };
  }, []);

  useEffect(() => {
    const location = clientLocation();
    if (!location) {
      return;
    }
    const candidate = parseServerUrlSearchParam(location.search);
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
      setServerStatusById((current) =>
        upsertRuntimeStatusIfChanged(current, active.id, statusFromProbe(active.baseUrl, activeProbe))
      );
      if (cancelled || activeProbe.ok) {
        return;
      }
      const candidates = [...current.servers].sort((a, b) => b.lastUsedAt - a.lastUsedAt);
      for (const candidate of candidates) {
        if (candidate.id === active.id) {
          continue;
        }
        const probe = await probeServerBaseUrl(candidate.baseUrl);
        setServerStatusById((current) =>
          upsertRuntimeStatusIfChanged(
            current,
            candidate.id,
            statusFromProbe(candidate.baseUrl, probe)
          )
        );
        if (!probe.ok) {
          continue;
        }
        if (cancelled) {
          return;
        }
        if (readStoredServerConnectionsState().activeServerId !== active.id) {
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

  const refreshRendezvousEndpoints = useCallback(async () => {
    const rendezvousServers = serversRef.current.filter(
      (server): server is ServerConnection & { rendezvous: NonNullable<ServerConnection["rendezvous"]> } =>
        Boolean(server.rendezvous)
    );
    const resolved = await Promise.all(
      rendezvousServers.map(async (server) => {
        try {
          const endpoint = await resolveRendezvousEndpoint(server.rendezvous);
          return endpoint ? { endpoint, serverId: server.rendezvous.serverId } : null;
        } catch {
          return null;
        }
      })
    );
    for (const result of resolved) {
      if (!result) continue;
      setState((current) => {
        const existing = current.servers.find(
          (server) => server.rendezvous?.serverId === result.serverId
        );
        if (!existing || existing.baseUrl === result.endpoint.baseUrl) {
          return current;
        }
        migrateStoredAuthServerBaseUrl(existing.baseUrl, result.endpoint.baseUrl);
        const next = updateRendezvousServerEndpoint(current, {
          serverId: result.serverId,
          baseUrl: result.endpoint.baseUrl,
          label: result.endpoint.label,
        });
        if (next !== current) {
          writeStoredServerConnectionsState(next);
        }
        return next;
      });
    }
  }, []);

  useEffect(() => {
    if (!ready) {
      return;
    }
    void refreshRendezvousEndpoints();
    const interval = window.setInterval(() => {
      void refreshRendezvousEndpoints();
    }, 10_000);
    return () => window.clearInterval(interval);
  }, [ready, refreshRendezvousEndpoints]);

  const refreshServerHealth = useCallback(async () => {
    const epoch = ++healthRefreshEpochRef.current;
    const servers = serversRef.current;
    const entries = await Promise.all(
      servers.map(async (server) => {
        const probe = await probeServerBaseUrl(server.baseUrl);
        return [server.id, statusFromProbe(server.baseUrl, probe)] as const;
      })
    );
    const next = Object.fromEntries(entries);
    if (epoch !== healthRefreshEpochRef.current) {
      return next;
    }
    setServerStatusById((current) => {
      const currentServers = new Map(serversRef.current.map((server) => [server.id, server.baseUrl]));
      const merged = Object.fromEntries(
        Object.entries(next)
          .filter(([serverId, status]) => currentServers.get(serverId) === status.baseUrl)
          .map(([serverId, status]) => {
            const previous = current[serverId];
            return [
              serverId,
              status.lastOnlineAt === null && previous?.baseUrl === status.baseUrl
                ? { ...status, lastOnlineAt: previous.lastOnlineAt }
                : status,
            ];
          })
      );
      return mergeRuntimeStatusesIfChanged(current, merged);
    });
    return next;
  }, []);

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

  const dedupedServers = useMemo(
    () => dedupeServersByResolvedBaseUrl(state.servers),
    [state.servers]
  );

  const onlineServers = useMemo(
    () =>
      dedupedServers.filter((server) => {
        const health = serverStatusById[server.id]?.health ?? "unknown";
        return health === "online" || health === "auth_required";
      }),
    [dedupedServers, serverStatusById]
  );

  const value = useMemo<ServerConnectionsContextValue>(() => {
    const activeServer =
      state.servers.find((server) => server.id === state.activeServerId) ??
      state.servers[0] ??
      getActiveServerConnection();
    const configuredSettingsServer = getSettingsServerConnection(state);
    const configuredSettingsHealth = configuredSettingsServer
      ? serverStatusById[configuredSettingsServer.id]?.health ?? "unknown"
      : "unknown";
    const settingsServer =
      configuredSettingsServer && configuredSettingsHealth !== "offline"
        ? configuredSettingsServer
        : activeServer;
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
    onlineServers,
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
