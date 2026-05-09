"use client";

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from "react";
import {
  SERVER_CONNECTIONS_EVENT,
  type ServerConnection,
  type ServerConnectionsState,
  getActiveServerConnection,
  markServerConnectionUsed,
  normalizeServerBaseUrl,
  readStoredServerConnectionsState,
  removeServerConnection,
  upsertServerConnection,
  writeStoredServerConnectionsState,
} from "@/lib/server-connections-provider-shared";

type ServerProbeResult = {
  ok: boolean;
  healthOk: boolean;
  authEnabled: boolean | null;
  authenticated: boolean | null;
  error: string | null;
};

type ServerConnectionsContextValue = {
  ready: boolean;
  state: ServerConnectionsState;
  servers: ServerConnection[];
  activeServer: ServerConnection;
  setActiveServer: (serverId: string) => void;
  saveServer: (input: { id?: string; label?: string; baseUrl: string }) => ServerConnection;
  removeServer: (serverId: string) => void;
  probeServer: (baseUrl: string) => Promise<ServerProbeResult>;
};

const ServerConnectionsContext = createContext<ServerConnectionsContextValue | null>(null);

async function probeServerBaseUrl(baseUrl: string): Promise<ServerProbeResult> {
  const normalizedBaseUrl = normalizeServerBaseUrl(baseUrl);
  try {
    const healthResponse = await fetch(`${normalizedBaseUrl}/health`, {
      method: "GET",
      cache: "no-store",
    });
    if (!healthResponse.ok) {
      return {
        ok: false,
        healthOk: false,
        authEnabled: null,
        authenticated: null,
        error: `Health check failed (${healthResponse.status}).`,
      };
    }

    try {
      const authResponse = await fetch(`${normalizedBaseUrl}/api/auth/status`, {
        method: "GET",
        credentials: "include",
        cache: "no-store",
      });
      if (!authResponse.ok) {
        return {
          ok: true,
          healthOk: true,
          authEnabled: null,
          authenticated: null,
          error: null,
        };
      }
      const payload = (await authResponse.json()) as {
        enabled?: boolean;
        authenticated?: boolean;
      };
      return {
        ok: true,
        healthOk: true,
        authEnabled: payload.enabled === true,
        authenticated:
          typeof payload.authenticated === "boolean" ? payload.authenticated : null,
        error: null,
      };
    } catch {
      return {
        ok: true,
        healthOk: true,
        authEnabled: null,
        authenticated: null,
        error: null,
      };
    }
  } catch (error) {
    return {
      ok: false,
      healthOk: false,
      authEnabled: null,
      authenticated: null,
      error: error instanceof Error ? error.message : "Failed to reach server.",
    };
  }
}

export function ServerConnectionsProvider({ children }: { children: ReactNode }) {
  const [ready, setReady] = useState(false);
  const [state, setState] = useState<ServerConnectionsState>(() => readStoredServerConnectionsState());

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
    const raw = new URLSearchParams(window.location.search).get("serverUrl")?.trim();
    if (!raw) {
      return;
    }
    let baseUrl: string;
    try {
      baseUrl = normalizeServerBaseUrl(raw);
    } catch {
      return;
    }
    setState((current) => {
      const upserted = upsertServerConnection(current, {
        label: new URL(baseUrl).host,
        baseUrl,
      });
      const server = upserted.servers.find((candidate) => candidate.baseUrl === baseUrl);
      const next = server
        ? markServerConnectionUsed(upserted, server.id)
        : upserted;
      writeStoredServerConnectionsState(next);
      return next;
    });
  }, []);

  const setActiveServer = useCallback((serverId: string) => {
    setState((current) => {
      const next = markServerConnectionUsed(current, serverId);
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
        next.servers.find((server) => server.baseUrl === normalizeServerBaseUrl(input.baseUrl)) ??
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
    return {
      ready,
      state,
      servers: state.servers,
      activeServer,
      setActiveServer,
      saveServer,
      removeServer: deleteServer,
      probeServer: probeServerBaseUrl,
    };
  }, [deleteServer, ready, saveServer, setActiveServer, state]);

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
