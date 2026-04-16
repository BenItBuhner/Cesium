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
  deriveServerConnectionName,
  getDefaultServerBaseUrl,
  getServerConnectionsSnapshot,
  normalizeServerBaseUrl,
  resolveServerRequestBaseUrl,
  writeServerConnectionsToStorage,
  type PersistedServerConnectionsState,
  type SavedServerConnection,
} from "@/lib/server-connections";

type SaveServerInput = {
  baseUrl: string;
  name?: string;
  activate?: boolean;
};

type UpdateServerInput = {
  baseUrl?: string;
  name?: string;
  activate?: boolean;
};

type ServerConnectionsContextValue = {
  ready: boolean;
  activeServer: SavedServerConnection;
  activeServerId: string;
  activeRequestBaseUrl: string;
  defaultServerBaseUrl: string;
  servers: SavedServerConnection[];
  activateServer: (serverId: string) => void;
  saveServer: (input: SaveServerInput) => SavedServerConnection;
  updateServer: (serverId: string, input: UpdateServerInput) => SavedServerConnection;
  removeServer: (serverId: string) => void;
};

const ServerConnectionsContext = createContext<ServerConnectionsContextValue | null>(null);

function touchServer(
  server: SavedServerConnection,
  patch?: Partial<SavedServerConnection>
): SavedServerConnection {
  const now = Date.now();
  return {
    ...server,
    ...patch,
    updatedAt: patch?.updatedAt ?? now,
    lastUsedAt: patch?.lastUsedAt ?? now,
  };
}

function getFallbackActiveServer(
  state: PersistedServerConnectionsState
): SavedServerConnection {
  return (
    state.servers.find((server) => server.id === state.activeServerId) ??
    state.servers[0] ??
    {
      id: getDefaultServerBaseUrl(),
      baseUrl: getDefaultServerBaseUrl(),
      name: deriveServerConnectionName(getDefaultServerBaseUrl()),
      createdAt: Date.now(),
      updatedAt: Date.now(),
      lastUsedAt: Date.now(),
    }
  );
}

export function ServerConnectionsProvider({ children }: { children: ReactNode }) {
  const [state, setState] = useState<PersistedServerConnectionsState>(
    getServerConnectionsSnapshot
  );
  const [ready, setReady] = useState(typeof window === "undefined");

  const commitState = useCallback(
    (
      updater: (
        current: PersistedServerConnectionsState
      ) => PersistedServerConnectionsState
    ): PersistedServerConnectionsState => {
      const current = getServerConnectionsSnapshot();
      const next = writeServerConnectionsToStorage(updater(current));
      setState(next);
      return next;
    },
    []
  );

  useEffect(() => {
    setState(getServerConnectionsSnapshot());
    setReady(true);

    const onStorage = (event: StorageEvent) => {
      if (event.key && event.key !== "opencursor.server-connections") {
        return;
      }
      setState(getServerConnectionsSnapshot());
    };

    window.addEventListener("storage", onStorage);
    return () => {
      window.removeEventListener("storage", onStorage);
    };
  }, []);

  const activateServer = useCallback(
    (serverId: string) => {
      commitState((current) => {
        const existing = current.servers.find((server) => server.id === serverId);
        if (!existing) {
          throw new Error("Saved server was not found.");
        }
        return {
          ...current,
          activeServerId: serverId,
          servers: current.servers.map((server) =>
            server.id === serverId ? touchServer(server) : server
          ),
        };
      });
    },
    [commitState]
  );

  const saveServer = useCallback(
    (input: SaveServerInput): SavedServerConnection => {
      const normalizedBaseUrl = normalizeServerBaseUrl(input.baseUrl);
      const trimmedName = input.name?.trim() ?? "";
      const next = commitState((current) => {
        const existing = current.servers.find((server) => server.id === normalizedBaseUrl);
        const nextServer = touchServer(
          existing ?? {
            id: normalizedBaseUrl,
            baseUrl: normalizedBaseUrl,
            name: trimmedName || deriveServerConnectionName(normalizedBaseUrl),
            createdAt: Date.now(),
            updatedAt: Date.now(),
            lastUsedAt: Date.now(),
          },
          {
            name:
              trimmedName ||
              existing?.name?.trim() ||
              deriveServerConnectionName(normalizedBaseUrl),
          }
        );

        const otherServers = current.servers.filter((server) => server.id !== normalizedBaseUrl);
        const activate = input.activate !== false || !current.activeServerId;
        return {
          ...current,
          activeServerId: activate ? normalizedBaseUrl : current.activeServerId,
          servers: [nextServer, ...otherServers],
        };
      });
      return (
        next.servers.find((server) => server.id === normalizedBaseUrl) ??
        getFallbackActiveServer(next)
      );
    },
    [commitState]
  );

  const updateServer = useCallback(
    (serverId: string, input: UpdateServerInput): SavedServerConnection => {
      const current = getServerConnectionsSnapshot();
      const existing = current.servers.find((server) => server.id === serverId);
      if (!existing) {
        throw new Error("Saved server was not found.");
      }
      const normalizedBaseUrl = input.baseUrl
        ? normalizeServerBaseUrl(input.baseUrl)
        : existing.baseUrl;
      const trimmedName = input.name?.trim();
      const next = commitState((stateNow) => {
        const server = stateNow.servers.find((entry) => entry.id === serverId) ?? existing;
        const merged = touchServer(server, {
          id: normalizedBaseUrl,
          baseUrl: normalizedBaseUrl,
          name:
            trimmedName && trimmedName.length > 0
              ? trimmedName
              : server.name?.trim() || deriveServerConnectionName(normalizedBaseUrl),
          createdAt: server.createdAt,
        });
        const deduped = stateNow.servers.filter(
          (entry) => entry.id !== serverId && entry.id !== normalizedBaseUrl
        );
        const activate = input.activate === true || stateNow.activeServerId === serverId;
        return {
          ...stateNow,
          activeServerId: activate ? normalizedBaseUrl : stateNow.activeServerId,
          servers: [merged, ...deduped],
        };
      });
      return (
        next.servers.find((server) => server.id === normalizedBaseUrl) ??
        getFallbackActiveServer(next)
      );
    },
    [commitState]
  );

  const removeServer = useCallback(
    (serverId: string) => {
      commitState((current) => {
        const remaining = current.servers.filter((server) => server.id !== serverId);
        if (remaining.length === 0) {
          throw new Error("At least one saved server is required.");
        }
        const nextActiveServerId =
          current.activeServerId === serverId
            ? remaining[0]!.id
            : current.activeServerId;
        return {
          ...current,
          activeServerId: nextActiveServerId,
          servers: remaining.map((server) =>
            server.id === nextActiveServerId ? touchServer(server) : server
          ),
        };
      });
    },
    [commitState]
  );

  const value = useMemo<ServerConnectionsContextValue>(() => {
    const activeServer = getFallbackActiveServer(state);
    return {
      ready,
      activeServer,
      activeServerId: activeServer.id,
      activeRequestBaseUrl: resolveServerRequestBaseUrl(activeServer.baseUrl),
      defaultServerBaseUrl: getDefaultServerBaseUrl(),
      servers: state.servers,
      activateServer,
      saveServer,
      updateServer,
      removeServer,
    };
  }, [activateServer, ready, removeServer, saveServer, state, updateServer]);

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
