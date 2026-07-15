import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from "react";
import type { WorkspaceRecord } from "@cesium/core";
import {
  clientKeyValueStore,
  fetchWorkspaceBootstrap,
  markWorkspaceActivity,
  setActiveWorkspaceId as setServerApiActiveWorkspaceId,
} from "@cesium/client";
import { useServerConnections } from "@cesium/client/react";
import { useNativeAuth } from "./NativeAuthProvider";

/**
 * Native workspace registry: mirrors the workspace-selection responsibilities
 * of the web `WorkspaceContext` (bootstrap list, active workspace, server-api
 * header sync). File-tree/git/terminal state stays with the surfaces that use
 * it — the chat workbench only needs the active workspace identity.
 */

const ACTIVE_WORKSPACE_STORAGE_KEY = "cesium.native.active-workspace";

type NativeWorkspaceContextValue = {
  loading: boolean;
  error: string | null;
  workspaces: WorkspaceRecord[];
  activeWorkspaceId: string | null;
  activeWorkspace: WorkspaceRecord | null;
  setActiveWorkspace: (workspaceId: string) => void;
  refreshWorkspaces: () => Promise<void>;
};

const NativeWorkspaceContext = createContext<NativeWorkspaceContextValue | null>(null);

function readPersistedWorkspaceId(serverKey: string): string | null {
  try {
    return clientKeyValueStore().getItem(`${ACTIVE_WORKSPACE_STORAGE_KEY}:${serverKey}`);
  } catch {
    return null;
  }
}

function persistWorkspaceId(serverKey: string, workspaceId: string | null): void {
  try {
    const key = `${ACTIVE_WORKSPACE_STORAGE_KEY}:${serverKey}`;
    if (workspaceId) {
      clientKeyValueStore().setItem(key, workspaceId);
    } else {
      clientKeyValueStore().removeItem(key);
    }
  } catch {
    // Persistence is best-effort.
  }
}

export function NativeWorkspaceProvider({ children }: { children: ReactNode }) {
  const { activeServer } = useServerConnections();
  const { ready: authReady, enabled: authEnabled, authenticated } = useNativeAuth();
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [workspaces, setWorkspaces] = useState<WorkspaceRecord[]>([]);
  const [activeWorkspaceId, setActiveWorkspaceIdState] = useState<string | null>(null);

  const canFetch = authReady && (!authEnabled || authenticated);

  const applyActiveWorkspace = useCallback(
    (workspaceId: string | null) => {
      setActiveWorkspaceIdState(workspaceId);
      setServerApiActiveWorkspaceId(workspaceId);
      persistWorkspaceId(activeServer.baseUrl, workspaceId);
    },
    [activeServer.baseUrl]
  );

  const refreshWorkspaces = useCallback(async () => {
    setError(null);
    try {
      const result = await fetchWorkspaceBootstrap();
      setWorkspaces(result.workspaces);
      const persisted = readPersistedWorkspaceId(activeServer.baseUrl);
      const candidates = [
        persisted,
        result.startupWorkspaceId,
        result.defaultWorkspaceId,
        result.recentWorkspaceIds[0],
        result.workspaces[0]?.id,
      ];
      const nextActive =
        candidates.find(
          (id): id is string =>
            Boolean(id) && result.workspaces.some((workspace) => workspace.id === id)
        ) ?? null;
      applyActiveWorkspace(nextActive);
    } catch (nextError) {
      setError(
        nextError instanceof Error ? nextError.message : "Failed to load workspaces."
      );
    }
  }, [activeServer.baseUrl, applyActiveWorkspace]);

  useEffect(() => {
    if (!canFetch) {
      return;
    }
    let cancelled = false;
    setLoading(true);
    void refreshWorkspaces().finally(() => {
      if (!cancelled) {
        setLoading(false);
      }
    });
    return () => {
      cancelled = true;
    };
  }, [canFetch, refreshWorkspaces]);

  const setActiveWorkspace = useCallback(
    (workspaceId: string) => {
      applyActiveWorkspace(workspaceId);
      void markWorkspaceActivity(workspaceId).catch(() => undefined);
    },
    [applyActiveWorkspace]
  );

  const value = useMemo<NativeWorkspaceContextValue>(() => {
    const activeWorkspace =
      workspaces.find((workspace) => workspace.id === activeWorkspaceId) ?? null;
    return {
      loading,
      error,
      workspaces,
      activeWorkspaceId,
      activeWorkspace,
      setActiveWorkspace,
      refreshWorkspaces,
    };
  }, [activeWorkspaceId, error, loading, refreshWorkspaces, setActiveWorkspace, workspaces]);

  return (
    <NativeWorkspaceContext.Provider value={value}>
      {children}
    </NativeWorkspaceContext.Provider>
  );
}

export function useNativeWorkspace(): NativeWorkspaceContextValue {
  const context = useContext(NativeWorkspaceContext);
  if (!context) {
    throw new Error("useNativeWorkspace must be used within NativeWorkspaceProvider");
  }
  return context;
}
