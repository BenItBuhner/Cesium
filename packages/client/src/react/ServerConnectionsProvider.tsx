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
  omitBrowserMachineFromState,
  requiresDefaultServerSelection,
  setDefaultServerConnection,
  updateRendezvousServerEndpoint,
  upsertServerConnection,
  createUnconfiguredServerConnection,
  isUnconfiguredServerConnection,
  type ServerConnection,
  type ServerConnectionsState,
} from "../server-connections";
import {
  BROWSER_MACHINE_NATIVE_UNAVAILABLE_MESSAGE,
  isBrowserMachineUrl,
} from "../browser-machine";
import { isBrowserMachineOffered } from "../platform-feature-flags";
import {
  parseConnectSessionHash,
  parseRendezvousBootstrapHash,
  resolveRendezvousEndpoint,
  resolveRendezvousEndpoints,
  resolveRendezvousRecord,
  stripRendezvousBootstrapFromLocation,
  RendezvousLookupError,
  type RendezvousBootstrap,
  type RendezvousLocator,
} from "../rendezvous";
import {
  RENDEZVOUS_REFRESH_DEGRADED_MS,
  nextServerRetryState,
  rendezvousServerJustWentOffline,
  shouldAttemptServer,
  type ServerRetryState,
} from "../rendezvous-refresh";
import {
  subscribeCloudRendezvousSnapshot,
  type CloudRendezvousSnapshot,
} from "../rendezvous-subscription";
import { migrateStoredAuthServerBaseUrl, setStoredSessionToken } from "../auth-client";
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
  timeoutSignal,
  type ServerProbeResult,
} from "../server-connection-health";
import {
  applyServerEngineNameProbes,
  engineNamesForServers,
  readStoredServerEngineNames,
  writeStoredServerEngineNames,
  type ServerEngineNames,
} from "../server-engine-names";
import { assertEngineServerUrlAllowed } from "../engine-url-policy";
import { clientKeyValueStore, clientLocation, getClientPlatform } from "../platform";

type ServerConnectionsContextValue = {
  ready: boolean;
  state: ServerConnectionsState;
  servers: ServerConnection[];
  serverStatusById: Record<string, ServerRuntimeStatus>;
  /** Names engines reported for themselves, by server id; missing when unknown. */
  engineNameById: Record<string, string>;
  onlineServers: ServerConnection[];
  activeServer: ServerConnection;
  /** False when the user has no saved engines (fresh account / account site). */
  hasServer: boolean;
  settingsServer: ServerConnection | null;
  requiresDefaultServer: boolean;
  setActiveServer: (serverId: string) => void;
  setDefaultServer: (serverId: string) => void;
  saveServer: (input: {
    id?: string;
    label?: string;
    baseUrl: string;
    /** Tunnel-backed engines keep their locator so URL rotations follow. */
    rendezvous?: RendezvousLocator;
  }) => ServerConnection;
  removeServer: (serverId: string) => void;
  probeServer: (baseUrl: string) => Promise<ServerProbeResult>;
  refreshServerHealth: () => Promise<Record<string, ServerRuntimeStatus>>;
};

const ServerConnectionsContext = createContext<ServerConnectionsContextValue | null>(null);

/** Registry lookups must never block app readiness or pile up between polls. */
const RENDEZVOUS_RESOLVE_TIMEOUT_MS = 8_000;
const RENDEZVOUS_RETRY_STORAGE_KEY = "cesium-rendezvous-retry-v1";
const SERVER_PROBE_RETRY_STORAGE_KEY = "cesium-server-probe-retry-v1";

function readRetryStates(storageKey: string): Map<string, ServerRetryState> {
  try {
    const parsed: unknown = JSON.parse(clientKeyValueStore().getItem(storageKey) ?? "{}");
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return new Map();
    }
    const states = new Map<string, ServerRetryState>();
    for (const [key, value] of Object.entries(parsed)) {
      if (
        value &&
        typeof value === "object" &&
        "failures" in value &&
        "firstFailureAt" in value &&
        "nextAttemptAt" in value &&
        typeof value.failures === "number" &&
        (value.firstFailureAt === null || typeof value.firstFailureAt === "number") &&
        typeof value.nextAttemptAt === "number"
      ) {
        states.set(key, {
          failures: value.failures,
          firstFailureAt: value.firstFailureAt,
          nextAttemptAt: value.nextAttemptAt,
        });
      }
    }
    return states;
  } catch {
    return new Map();
  }
}

function writeRetryStates(
  storageKey: string,
  states: Map<string, ServerRetryState>
): void {
  clientKeyValueStore().setItem(
    storageKey,
    JSON.stringify(Object.fromEntries(states))
  );
}

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

function readSurfaceServerConnectionsState(): ServerConnectionsState {
  const state = readStoredServerConnectionsState();
  if (isBrowserMachineOffered()) {
    return state;
  }
  const stripped = omitBrowserMachineFromState(state);
  if (stripped !== state) {
    writeStoredServerConnectionsState(stripped);
  }
  return stripped;
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
  const [state, setState] = useState<ServerConnectionsState>(() =>
    readSurfaceServerConnectionsState()
  );
  const [serverStatusById, setServerStatusById] = useState<Record<string, ServerRuntimeStatus>>({});
  const [engineNames, setEngineNames] = useState<ServerEngineNames>(() =>
    readStoredServerEngineNames()
  );
  const healthRecoveryRanRef = useRef(false);
  const healthRefreshEpochRef = useRef(0);
  const rendezvousRefreshInFlightRef = useRef(false);
  const rendezvousRetryByServerRef = useRef(
    readRetryStates(RENDEZVOUS_RETRY_STORAGE_KEY)
  );
  const serverProbeRetryByIdRef = useRef(
    readRetryStates(SERVER_PROBE_RETRY_STORAGE_KEY)
  );
  const globalRendezvousRetryRef = useRef<ServerRetryState | undefined>(undefined);
  const cloudRendezvousServerIdsRef = useRef(new Set<string>());
  const serversRef = useRef<ServerConnection[]>(state.servers);
  serversRef.current = state.servers;
  const serverStatusRef = useRef(serverStatusById);
  serverStatusRef.current = serverStatusById;

  useEffect(() => {
    const sync = () => {
      setState(readSurfaceServerConnectionsState());
    };
    let cancelled = false;
    void (async () => {
      // The whole shell (rail load, auth, workspace bootstrap) gates on
      // `ready`. Nothing in this bootstrap may block readiness forever: every
      // network call is time-boxed and any unexpected failure still resolves.
      let next = readSurfaceServerConnectionsState();
      try {
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
          const sessionToken = location?.href
            ? parseConnectSessionHash(new URL(location.href).hash)
            : null;
          let resolvedBaseUrl = bootstrap.initialBaseUrl ?? null;
          let resolvedLabel = bootstrap.label;
          try {
            const resolved = await resolveRendezvousEndpoint(bootstrap, {
              signal: timeoutSignal(RENDEZVOUS_RESOLVE_TIMEOUT_MS),
            });
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
            if (sessionToken) {
              setStoredSessionToken(sessionToken, null, resolvedBaseUrl);
            }
          }
          stripRendezvousBootstrapFromLocation();
        }
      } catch {
        // Never let a bootstrap failure hold the app on the loading screen.
      } finally {
        if (!cancelled) {
          setState(next);
          setReady(true);
        }
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
      const now = Date.now();
      if (!shouldAttemptServer(serverProbeRetryByIdRef.current.get(active.id), now)) {
        return;
      }
      const activeProbe = await probeServerBaseUrl(active.baseUrl);
      serverProbeRetryByIdRef.current.set(
        active.id,
        nextServerRetryState({
          previous: serverProbeRetryByIdRef.current.get(active.id),
          now,
          reachable: activeProbe.ok,
          healthyIntervalMs: 30_000,
        })
      );
      writeRetryStates(
        SERVER_PROBE_RETRY_STORAGE_KEY,
        serverProbeRetryByIdRef.current
      );
      setServerStatusById((current) =>
        upsertRuntimeStatusIfChanged(current, active.id, statusFromProbe(active.baseUrl, activeProbe))
      );
      if (cancelled || activeProbe.ok) {
        return;
      }
      const candidates = [...current.servers].sort((a, b) => b.lastUsedAt - a.lastUsedAt);
      for (const candidate of candidates) {
        if (
          candidate.id === active.id ||
          !shouldAttemptServer(
            serverProbeRetryByIdRef.current.get(candidate.id),
            Date.now()
          )
        ) {
          continue;
        }
        const probe = await probeServerBaseUrl(candidate.baseUrl);
        serverProbeRetryByIdRef.current.set(
          candidate.id,
          nextServerRetryState({
            previous: serverProbeRetryByIdRef.current.get(candidate.id),
            now: Date.now(),
            reachable: probe.ok,
            healthyIntervalMs: 30_000,
          })
        );
        writeRetryStates(
          SERVER_PROBE_RETRY_STORAGE_KEY,
          serverProbeRetryByIdRef.current
        );
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

  const applyResolvedRendezvousEndpoints = useCallback(
    (resolved: Map<string, Awaited<ReturnType<typeof resolveRendezvousRecord>>>) => {
      for (const [serverId, endpoint] of resolved) {
        if (!endpoint) continue;
        setState((current) => {
          const existing = current.servers.find(
            (server) => server.rendezvous?.serverId === serverId
          );
          if (!existing || existing.baseUrl === endpoint.baseUrl) {
            return current;
          }
          migrateStoredAuthServerBaseUrl(existing.baseUrl, endpoint.baseUrl);
          const next = updateRendezvousServerEndpoint(current, {
            serverId,
            baseUrl: endpoint.baseUrl,
            label: endpoint.label,
          });
          if (next !== current) {
            writeStoredServerConnectionsState(next);
          }
          return next;
        });
      }
    },
    []
  );

  const refreshRendezvousEndpoints = useCallback(async (force = false) => {
    if (
      rendezvousRefreshInFlightRef.current ||
      (typeof document !== "undefined" && document.visibilityState === "hidden")
    ) {
      return;
    }
    const now = Date.now();
    if (!shouldAttemptServer(globalRendezvousRetryRef.current, now, force)) {
      return;
    }
    const rendezvousServers = serversRef.current.filter(
      (server): server is ServerConnection & { rendezvous: NonNullable<ServerConnection["rendezvous"]> } =>
        Boolean(server.rendezvous) &&
        !cloudRendezvousServerIdsRef.current.has(server.rendezvous!.serverId) &&
        shouldAttemptServer(
          rendezvousRetryByServerRef.current.get(server.rendezvous!.serverId),
          now,
          force
        )
    );
    if (rendezvousServers.length === 0) {
      return;
    }
    rendezvousRefreshInFlightRef.current = true;
    try {
      const resolved = await resolveRendezvousEndpoints(
        rendezvousServers.map((server) => server.rendezvous),
        { signal: timeoutSignal(RENDEZVOUS_RESOLVE_TIMEOUT_MS) }
      );
      globalRendezvousRetryRef.current = undefined;
      for (const server of rendezvousServers) {
        const serverId = server.rendezvous.serverId;
        rendezvousRetryByServerRef.current.set(
          serverId,
          nextServerRetryState({
            previous: rendezvousRetryByServerRef.current.get(serverId),
            now,
            reachable: Boolean(resolved.get(serverId)),
          })
        );
      }
      writeRetryStates(
        RENDEZVOUS_RETRY_STORAGE_KEY,
        rendezvousRetryByServerRef.current
      );
      applyResolvedRendezvousEndpoints(resolved);
    } catch (error) {
      const retryAfterMs =
        error instanceof RendezvousLookupError ? error.retryAfterMs : null;
      for (const server of rendezvousServers) {
        const serverId = server.rendezvous.serverId;
        rendezvousRetryByServerRef.current.set(
          serverId,
          nextServerRetryState({
            previous: rendezvousRetryByServerRef.current.get(serverId),
            now,
            reachable: false,
            retryAfterMs,
          })
        );
      }
      writeRetryStates(
        RENDEZVOUS_RETRY_STORAGE_KEY,
        rendezvousRetryByServerRef.current
      );
      if (!(error instanceof RendezvousLookupError) || error.isGlobalFailure) {
        globalRendezvousRetryRef.current = nextServerRetryState({
          previous: globalRendezvousRetryRef.current,
          now,
          reachable: false,
          retryAfterMs,
        });
      }
    } finally {
      rendezvousRefreshInFlightRef.current = false;
    }
  }, [applyResolvedRendezvousEndpoints]);

  useEffect(() => {
    return subscribeCloudRendezvousSnapshot((snapshot: CloudRendezvousSnapshot | null) => {
      cloudRendezvousServerIdsRef.current = new Set(snapshot?.serverIds ?? []);
      if (!snapshot) {
        return;
      }
      const currentByServerId = new Map(
        serversRef.current.flatMap((server) =>
          server.rendezvous ? [[server.rendezvous.serverId, server] as const] : []
        )
      );
      void (async () => {
        const resolved = new Map<
          string,
          Awaited<ReturnType<typeof resolveRendezvousRecord>>
        >();
        await Promise.all(
          snapshot.serverIds.map(async (serverId, index) => {
            const server = currentByServerId.get(serverId);
            if (!server?.rendezvous) return;
            try {
              resolved.set(
                serverId,
                await resolveRendezvousRecord(
                  server.rendezvous,
                  snapshot.records[index] ?? null
                )
              );
            } catch {
              resolved.set(serverId, null);
            }
          })
        );
        const now = Date.now();
        for (const [serverId, endpoint] of resolved) {
          if (endpoint) {
            rendezvousRetryByServerRef.current.set(
              serverId,
              nextServerRetryState({ now, reachable: true })
            );
          }
        }
        writeRetryStates(
          RENDEZVOUS_RETRY_STORAGE_KEY,
          rendezvousRetryByServerRef.current
        );
        applyResolvedRendezvousEndpoints(resolved);
      })();
    });
  }, [applyResolvedRendezvousEndpoints]);

  useEffect(() => {
    if (!ready) {
      return;
    }
    void refreshRendezvousEndpoints();
    // The tick only evaluates per-server/global retry deadlines. Hidden tabs
    // make no requests; Convex-backed servers are updated by the one batched
    // reactive subscription and are excluded from this HTTP fallback.
    const interval = window.setInterval(() => {
      void refreshRendezvousEndpoints();
    }, RENDEZVOUS_REFRESH_DEGRADED_MS);
    const onVisible = () => {
      if (document.visibilityState === "visible") {
        void refreshRendezvousEndpoints();
      }
    };
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      window.clearInterval(interval);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [ready, refreshRendezvousEndpoints]);

  const runServerHealthRefresh = useCallback(async (force = false) => {
    const epoch = ++healthRefreshEpochRef.current;
    const now = Date.now();
    const servers = serversRef.current.filter((server) =>
      shouldAttemptServer(serverProbeRetryByIdRef.current.get(server.id), now, force)
    );
    const probes = await Promise.all(
      servers.map(async (server) => ({
        server,
        probe: await probeServerBaseUrl(server.baseUrl),
      }))
    );
    for (const { server, probe } of probes) {
      serverProbeRetryByIdRef.current.set(
        server.id,
        nextServerRetryState({
          previous: serverProbeRetryByIdRef.current.get(server.id),
          now,
          reachable: probe.ok,
          healthyIntervalMs: 30_000,
        })
      );
    }
    if (probes.length > 0) {
      writeRetryStates(
        SERVER_PROBE_RETRY_STORAGE_KEY,
        serverProbeRetryByIdRef.current
      );
    }
    const next = {
      ...serverStatusRef.current,
      ...Object.fromEntries(
        probes.map(({ server, probe }) => [server.id, statusFromProbe(server.baseUrl, probe)])
      ),
    };
    if (epoch !== healthRefreshEpochRef.current) {
      return next;
    }
    setEngineNames((current) => {
      const updated = applyServerEngineNameProbes(
        current,
        probes.map(({ server, probe }) => ({ server, engineName: probe.engineName })),
        serversRef.current
      );
      if (updated !== current) {
        writeStoredServerEngineNames(updated);
      }
      return updated;
    });
    // A tunnel-backed engine dropping offline is the usual first sign of a
    // rotated public URL: look the new endpoint up right away instead of
    // waiting for the slow registry cadence.
    const rotated = servers.some(
      (server) =>
        server.rendezvous &&
        rendezvousServerJustWentOffline(
          serverStatusRef.current[server.id]?.health,
          next[server.id]?.health
        )
    );
    if (rotated) {
      void refreshRendezvousEndpoints();
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
  }, [refreshRendezvousEndpoints]);

  const refreshServerHealth = useCallback(
    async () => await runServerHealthRefresh(true),
    [runServerHealthRefresh]
  );

  useEffect(() => {
    if (!ready) {
      return;
    }
    void runServerHealthRefresh().catch(() => undefined);
    // Hidden tabs skip health probes (N servers × 30s adds up); a probe runs
    // immediately on return so statuses never look stale to the user.
    const interval = window.setInterval(() => {
      if (typeof document !== "undefined" && document.visibilityState === "hidden") {
        return;
      }
      void runServerHealthRefresh().catch(() => undefined);
    }, 30_000);
    const onVisible = () => {
      if (document.visibilityState === "visible") {
        void runServerHealthRefresh().catch(() => undefined);
      }
    };
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      window.clearInterval(interval);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [ready, runServerHealthRefresh]);

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

  const saveServer = useCallback((input: {
    id?: string;
    label?: string;
    baseUrl: string;
    rendezvous?: RendezvousLocator;
  }) => {
    const normalizedBaseUrl = normalizeServerBaseUrl(input.baseUrl);
    assertEngineServerUrlAllowed(normalizedBaseUrl);
    if (isBrowserMachineUrl(normalizedBaseUrl) && !isBrowserMachineOffered()) {
      throw new Error(BROWSER_MACHINE_NATIVE_UNAVAILABLE_MESSAGE);
    }
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

  // Every health probe rewrites `serverStatusById` (fresh lastCheckedAt), so a
  // plain useMemo here would hand consumers a new array every 30s and re-run
  // every effect keyed on it (the workspace directory used to refetch
  // `/api/workspaces` on each probe). Keep the previous array while the set
  // of online servers is unchanged.
  const onlineServersRef = useRef<ServerConnection[]>([]);
  const onlineServers = useMemo(() => {
    const next = dedupedServers.filter((server) => {
      const health = serverStatusById[server.id]?.health ?? "unknown";
      return health === "online" || health === "auth_required";
    });
    const previous = onlineServersRef.current;
    const unchanged =
      previous.length === next.length &&
      previous.every((server, index) => server === next[index]);
    if (unchanged) {
      return previous;
    }
    onlineServersRef.current = next;
    return next;
  }, [dedupedServers, serverStatusById]);

  const engineNameById = useMemo(
    () => engineNamesForServers(engineNames, state.servers),
    [engineNames, state.servers]
  );

  const value = useMemo<ServerConnectionsContextValue>(() => {
    const selected =
      state.servers.find((server) => server.id === state.activeServerId) ??
      state.servers[0] ??
      null;
    const hasServer = selected !== null && !isUnconfiguredServerConnection(selected);
    const activeServer = selected ?? createUnconfiguredServerConnection();
    const configuredSettingsServer = getSettingsServerConnection(state);
    const configuredSettingsHealth = configuredSettingsServer
      ? serverStatusById[configuredSettingsServer.id]?.health ?? "unknown"
      : "unknown";
    const settingsServer =
      configuredSettingsServer && configuredSettingsHealth !== "offline"
        ? configuredSettingsServer
        : hasServer
          ? activeServer
          : null;
    return {
      ready,
      state,
      servers: state.servers,
      serverStatusById,
      engineNameById,
      onlineServers,
      activeServer,
      hasServer,
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
    engineNameById,
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
