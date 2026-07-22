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
import type { AgentRailRepositoryInfo } from "@/lib/agent-types";
import type { WorkspaceRecord } from "@/lib/types";
import { isStandaloneChatWorkspace } from "@/lib/types";

export type DirectoryWorkspaceRecord = WorkspaceRecord & {
  serverId: string;
  serverLabel: string;
  serverBaseUrl: string;
  workspaceKey: string;
  repository?: AgentRailRepositoryInfo;
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

function sameWorkspaceDirectory(
  current: DirectoryWorkspaceRecord[],
  next: DirectoryWorkspaceRecord[]
): boolean {
  if (current.length !== next.length) return false;
  for (let index = 0; index < current.length; index += 1) {
    const a = current[index];
    const b = next[index];
    if (
      a.id !== b.id ||
      a.name !== b.name ||
      a.root !== b.root ||
      a.serverId !== b.serverId ||
      a.serverLabel !== b.serverLabel ||
      a.serverBaseUrl !== b.serverBaseUrl ||
      a.workspaceKey !== b.workspaceKey ||
      a.repository?.repositoryId !== b.repository?.repositoryId ||
      a.repository?.repoKey !== b.repository?.repoKey ||
      a.repository?.repoRoot !== b.repository?.repoRoot ||
      a.repository?.currentBranch !== b.repository?.currentBranch ||
      a.updatedAt !== b.updatedAt ||
      a.lastOpenedAt !== b.lastOpenedAt
    ) {
      return false;
    }
  }
  return true;
}

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
            return payload.workspaces
              .filter((workspace) => !isStandaloneChatWorkspace(workspace))
              .map((workspace): DirectoryWorkspaceRecord => ({
              ...workspace,
              serverId: server.id,
              serverLabel: server.label,
              serverBaseUrl: server.baseUrl,
              workspaceKey: `${server.id}:${workspace.id}`,
              repository: payload.repositoriesByWorkspaceId?.[workspace.id],
            }));
          } catch {
            return [];
          }
        })
      );
      const nextWorkspaces = results.flat();
      setWorkspaces((current) =>
        sameWorkspaceDirectory(current, nextWorkspaces) ? current : nextWorkspaces
      );
      setReady((current) => current || true);
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
