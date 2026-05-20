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
import { useServerConnections } from "@/components/preferences/ServerConnectionsProvider";
import { fetchWorkspacesForServer } from "@/lib/server-api";
import type { WorkspaceRecord } from "@/lib/types";

export type DirectoryWorkspaceRecord = WorkspaceRecord & {
  serverId: string;
  serverLabel: string;
  serverBaseUrl: string;
  workspaceKey: string;
};

type WorkspaceDirectoryContextValue = {
  ready: boolean;
  refreshing: boolean;
  workspaces: DirectoryWorkspaceRecord[];
  byWorkspaceKey: Map<string, DirectoryWorkspaceRecord>;
  byServerId: Map<string, DirectoryWorkspaceRecord[]>;
  refreshWorkspaceDirectory: () => Promise<void>;
};

const WorkspaceDirectoryContext =
  createContext<WorkspaceDirectoryContextValue | null>(null);

export function WorkspaceDirectoryProvider({ children }: { children: ReactNode }) {
  const { ready: serversReady, onlineServers, serverStatusById } = useServerConnections();
  const [ready, setReady] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [workspaces, setWorkspaces] = useState<DirectoryWorkspaceRecord[]>([]);

  const refreshWorkspaceDirectory = useCallback(async () => {
    if (!serversReady) {
      return;
    }
    setRefreshing(true);
    try {
      const results = await Promise.all(
        onlineServers.map(async (server) => {
          const status = serverStatusById[server.id]?.health ?? "unknown";
          if (status === "offline") {
            return [];
          }
          try {
            const payload = await fetchWorkspacesForServer({
              serverId: server.id,
              baseUrl: server.baseUrl,
            });
            return payload.workspaces.map((workspace): DirectoryWorkspaceRecord => ({
              ...workspace,
              serverId: server.id,
              serverLabel: server.label,
              serverBaseUrl: server.baseUrl,
              workspaceKey: `${server.id}:${workspace.id}`,
            }));
          } catch {
            return [];
          }
        })
      );
      setWorkspaces(results.flat());
      setReady(true);
    } finally {
      setRefreshing(false);
    }
  }, [onlineServers, serverStatusById, serversReady]);

  useEffect(() => {
    void refreshWorkspaceDirectory();
  }, [refreshWorkspaceDirectory]);

  const byWorkspaceKey = useMemo(
    () => new Map(workspaces.map((workspace) => [workspace.workspaceKey, workspace])),
    [workspaces]
  );

  const byServerId = useMemo(() => {
    const map = new Map<string, DirectoryWorkspaceRecord[]>();
    for (const workspace of workspaces) {
      const list = map.get(workspace.serverId) ?? [];
      list.push(workspace);
      map.set(workspace.serverId, list);
    }
    return map;
  }, [workspaces]);

  const value = useMemo<WorkspaceDirectoryContextValue>(
    () => ({
      ready,
      refreshing,
      workspaces,
      byWorkspaceKey,
      byServerId,
      refreshWorkspaceDirectory,
    }),
    [byServerId, byWorkspaceKey, ready, refreshWorkspaceDirectory, refreshing, workspaces]
  );

  return (
    <WorkspaceDirectoryContext.Provider value={value}>
      {children}
    </WorkspaceDirectoryContext.Provider>
  );
}

export function useWorkspaceDirectory(): WorkspaceDirectoryContextValue {
  const context = useContext(WorkspaceDirectoryContext);
  if (!context) {
    throw new Error("useWorkspaceDirectory must be used within WorkspaceDirectoryProvider");
  }
  return context;
}
