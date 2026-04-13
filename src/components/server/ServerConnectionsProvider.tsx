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
  clearServerScopedLocationState,
  createServerConnection,
  persistStoredServerConnections,
  readStoredServerConnections,
  setActiveServerConnectionSnapshot,
  type ServerConnection,
  type ServerConnectionsSnapshot,
} from "@/lib/server-connections";

type SaveServerConnectionInput = {
  baseUrl: string;
  label?: string;
  setActive?: boolean;
};

type ServerConnectionsContextValue = {
  ready: boolean;
  connections: ServerConnection[];
  activeConnection: ServerConnection;
  defaultConnectionId: string;
  saveConnection: (input: SaveServerConnectionInput) => ServerConnection;
  setActiveConnection: (serverId: string) => void;
  removeConnection: (serverId: string) => void;
};

const ServerConnectionsContext =
  createContext<ServerConnectionsContextValue | null>(null);

function sortAndPersistSnapshot(snapshot: ServerConnectionsSnapshot): ServerConnectionsSnapshot {
  persistStoredServerConnections(snapshot);
  return readStoredServerConnections();
}

function sameConnections(
  left: ServerConnectionsSnapshot,
  right: ServerConnectionsSnapshot
): boolean {
  if (
    left.activeServerId !== right.activeServerId ||
    left.defaultServerId !== right.defaultServerId ||
    left.connections.length !== right.connections.length
  ) {
    return false;
  }

  for (let index = 0; index < left.connections.length; index += 1) {
    const leftConnection = left.connections[index];
    const rightConnection = right.connections[index];
    if (
      !rightConnection ||
      leftConnection.id !== rightConnection.id ||
      leftConnection.label !== rightConnection.label ||
      leftConnection.baseUrl !== rightConnection.baseUrl ||
      leftConnection.createdAt !== rightConnection.createdAt ||
      leftConnection.updatedAt !== rightConnection.updatedAt ||
      leftConnection.lastUsedAt !== rightConnection.lastUsedAt
    ) {
      return false;
    }
  }

  return true;
}

function updateConnectionsSnapshot(
  current: ServerConnectionsSnapshot,
  updater: (current: ServerConnectionsSnapshot) => ServerConnectionsSnapshot
): ServerConnectionsSnapshot {
  const next = updater(current);
  const persisted = sortAndPersistSnapshot(next);
  setActiveServerConnectionSnapshot(
    persisted.connections.find((connection) => connection.id === persisted.activeServerId) ??
      persisted.connections[0] ??
      null
  );
  return persisted;
}

export function ServerConnectionsProvider({
  children,
}: {
  children: ReactNode;
}) {
  const [ready, setReady] = useState(false);
  const [snapshot, setSnapshot] = useState<ServerConnectionsSnapshot>(
    readStoredServerConnections
  );

  useEffect(() => {
    const next = readStoredServerConnections();
    setSnapshot(next);
    setActiveServerConnectionSnapshot(
      next.connections.find((connection) => connection.id === next.activeServerId) ??
        next.connections[0] ??
        null
    );
    setReady(true);
  }, []);

  useEffect(() => {
    if (!ready) {
      return;
    }

    const handleStorage = (event: StorageEvent) => {
      if (
        event.key !== null &&
        event.key !== "opencursor.server-connections" &&
        event.key !== "opencursor.server-connections.active"
      ) {
        return;
      }
      const next = readStoredServerConnections();
      setSnapshot((current) => (sameConnections(current, next) ? current : next));
      setActiveServerConnectionSnapshot(
        next.connections.find((connection) => connection.id === next.activeServerId) ??
          next.connections[0] ??
          null
      );
    };

    window.addEventListener("storage", handleStorage);
    return () => {
      window.removeEventListener("storage", handleStorage);
    };
  }, [ready]);

  const activeConnection = useMemo(
    () =>
      snapshot.connections.find((connection) => connection.id === snapshot.activeServerId) ??
      snapshot.connections[0],
    [snapshot.activeServerId, snapshot.connections]
  );

  const setActiveConnection = useCallback((serverId: string) => {
    setSnapshot((current) => {
      if (current.activeServerId === serverId) {
        return current;
      }
      const target = current.connections.find((connection) => connection.id === serverId);
      if (!target) {
        return current;
      }
      clearServerScopedLocationState();
      const now = Date.now();
      return updateConnectionsSnapshot(current, (snapshotToUpdate) => ({
        ...snapshotToUpdate,
        connections: snapshotToUpdate.connections.map((connection) =>
          connection.id === serverId
            ? {
                ...connection,
                lastUsedAt: now,
                updatedAt: Math.max(connection.updatedAt, now),
              }
            : connection
        ),
        activeServerId: serverId,
      }));
    });
  }, []);

  const saveConnection = useCallback((input: SaveServerConnectionInput) => {
    const now = Date.now();
    let savedConnection = createServerConnection({
      baseUrl: input.baseUrl,
      label: input.label,
      createdAt: now,
      updatedAt: now,
      lastUsedAt: input.setActive ? now : 0,
    });

    setSnapshot((current) =>
      updateConnectionsSnapshot(current, (snapshotToUpdate) => {
        const existing = snapshotToUpdate.connections.find(
          (connection) => connection.id === savedConnection.id
        );
        savedConnection = createServerConnection({
          baseUrl: savedConnection.baseUrl,
          label: input.label ?? existing?.label ?? savedConnection.label,
          createdAt: existing?.createdAt ?? savedConnection.createdAt,
          updatedAt: now,
          lastUsedAt: input.setActive
            ? now
            : Math.max(existing?.lastUsedAt ?? 0, savedConnection.lastUsedAt),
        });
        if (input.setActive) {
          clearServerScopedLocationState();
        }
        return {
          ...snapshotToUpdate,
          connections: existing
            ? snapshotToUpdate.connections.map((connection) =>
                connection.id === savedConnection.id ? savedConnection : connection
              )
            : [...snapshotToUpdate.connections, savedConnection],
          activeServerId: input.setActive
            ? savedConnection.id
            : snapshotToUpdate.activeServerId,
        };
      })
    );

    return savedConnection;
  }, []);

  const removeConnection = useCallback(
    (serverId: string) => {
      setSnapshot((current) => {
        if (serverId === current.defaultServerId) {
          return current;
        }

        const remainingConnections = current.connections.filter(
          (connection) => connection.id !== serverId
        );
        if (remainingConnections.length === current.connections.length) {
          return current;
        }

        const nextActiveServerId =
          current.activeServerId === serverId
            ? current.defaultServerId
            : current.activeServerId;
        if (current.activeServerId === serverId) {
          clearServerScopedLocationState();
        }

        return updateConnectionsSnapshot(current, (snapshotToUpdate) => ({
          ...snapshotToUpdate,
          connections: remainingConnections,
          activeServerId: nextActiveServerId,
        }));
      });
    },
    []
  );

  const value = useMemo<ServerConnectionsContextValue>(
    () => ({
      ready,
      connections: snapshot.connections,
      activeConnection,
      defaultConnectionId: snapshot.defaultServerId,
      saveConnection,
      setActiveConnection,
      removeConnection,
    }),
    [
      activeConnection,
      ready,
      removeConnection,
      saveConnection,
      setActiveConnection,
      snapshot.connections,
      snapshot.defaultServerId,
    ]
  );

  return (
    <ServerConnectionsContext.Provider value={value}>
      {children}
    </ServerConnectionsContext.Provider>
  );
}

export function useServerConnections(): ServerConnectionsContextValue {
  const context = useContext(ServerConnectionsContext);
  if (!context) {
    throw new Error(
      "useServerConnections must be used within ServerConnectionsProvider"
    );
  }
  return context;
}
