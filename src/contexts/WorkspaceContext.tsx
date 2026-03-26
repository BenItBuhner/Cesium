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
import type {
  FileNode,
  FileWatcherEvent,
  TerminalInfo,
  WorkspaceInfo,
} from "@/lib/types";
import {
  createTerminal,
  fetchFolderChildren,
  fetchTree,
  getServerBaseUrl,
  getWorkspace,
  listTerminals,
  openWorkspace,
} from "@/lib/server-api";
import { JsonWebSocket, toWebSocketUrl } from "@/lib/ws-client";

type FileChangeNotice = {
  path: string;
  at: number;
};

type WorkspaceContextValue = {
  workspaceInfo: WorkspaceInfo | null;
  fileTree: FileNode | null;
  loading: boolean;
  connected: boolean;
  connectionState: "idle" | "connecting" | "open" | "closed" | "reconnecting";
  error: string | null;
  lastFileChange: FileChangeNotice | null;
  terminals: TerminalInfo[];
  refreshTree: () => Promise<void>;
  refreshTerminals: () => Promise<void>;
  loadFolderChildren: (path: string) => Promise<void>;
  openFolder: (root: string) => Promise<void>;
  createNewTerminal: (shell?: string) => Promise<{ id: string }>;
};

const WorkspaceContext = createContext<WorkspaceContextValue | null>(null);

function cloneFolder(node: FileNode): FileNode {
  return {
    ...node,
    children: node.children ? [...node.children] : [],
  };
}

function compareNodes(a: FileNode, b: FileNode): number {
  if (a.type !== b.type) {
    return a.type === "folder" ? -1 : 1;
  }
  return a.name.localeCompare(b.name, undefined, { sensitivity: "base" });
}

function createNodeFromEvent(relativePath: string, isDir: boolean): FileNode {
  const name = relativePath.split("/").at(-1) ?? relativePath;
  return isDir
    ? { name, type: "folder", children: [], hasChildren: false, childrenLoaded: true }
    : { name, type: "file" };
}

function addNodeToTree(tree: FileNode, relativePath: string, node: FileNode): FileNode {
  const segments = relativePath.split("/").filter(Boolean);
  if (segments.length === 0) return tree;

  function visit(current: FileNode, depth: number): FileNode {
    if (current.type !== "folder") return current;
    const next = cloneFolder(current);
    const currentSegment = segments[depth];
    if (!currentSegment) return next;

    if (depth === segments.length - 1) {
      const withoutExisting = (next.children ?? []).filter(
        (child) => child.name !== currentSegment
      );
      next.children = [...withoutExisting, node].sort(compareNodes);
      next.hasChildren = next.children.length > 0;
      next.childrenLoaded = true;
      return next;
    }

    const children = next.children ?? [];
    const existingIndex = children.findIndex((child) => child.name === currentSegment);
    if (existingIndex === -1) {
      const createdFolder: FileNode = {
        name: currentSegment,
        type: "folder",
        children: [],
      };
      next.children = [...children, visit(createdFolder, depth + 1)].sort(compareNodes);
      return next;
    }

    next.children = children.map((child, index) =>
      index === existingIndex ? visit(child, depth + 1) : child
    );
    next.hasChildren = (next.children ?? []).length > 0;
    return next;
  }

  return visit(tree, 0);
}

function removeNodeFromTree(tree: FileNode, relativePath: string): FileNode {
  const segments = relativePath.split("/").filter(Boolean);
  if (segments.length === 0) return tree;

  function visit(current: FileNode, depth: number): FileNode {
    if (current.type !== "folder" || !current.children) return current;
    const next = cloneFolder(current);
    const currentSegment = segments[depth];
    if (!currentSegment) return next;

    if (depth === segments.length - 1) {
      next.children = (next.children ?? []).filter((child) => child.name !== currentSegment);
      next.hasChildren = (next.children ?? []).length > 0;
      return next;
    }

    next.children = (next.children ?? []).map((child) =>
      child.name === currentSegment ? visit(child, depth + 1) : child
    );
    next.hasChildren = (next.children ?? []).length > 0;
    return next;
  }

  return visit(tree, 0);
}

function replaceFolderChildren(
  tree: FileNode,
  relativePath: string,
  children: FileNode[]
): FileNode {
  const segments = relativePath.split("/").filter(Boolean);

  function visit(current: FileNode, depth: number): FileNode {
    if (current.type !== "folder") return current;
    const next = cloneFolder(current);

    if (depth === segments.length) {
      next.children = [...children].sort(compareNodes);
      next.hasChildren = next.children.length > 0;
      next.childrenLoaded = true;
      return next;
    }

    const currentSegment = segments[depth];
    if (!currentSegment) return next;

    next.children = (next.children ?? []).map((child) =>
      child.name === currentSegment ? visit(child, depth + 1) : child
    );
    next.hasChildren = (next.children ?? []).length > 0;
    return next;
  }

  return visit(tree, 0);
}

export function WorkspaceProvider({ children }: { children: ReactNode }) {
  const [workspaceInfo, setWorkspaceInfo] = useState<WorkspaceInfo | null>(null);
  const [fileTree, setFileTree] = useState<FileNode | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [connectionState, setConnectionState] =
    useState<WorkspaceContextValue["connectionState"]>("idle");
  const [lastFileChange, setLastFileChange] = useState<FileChangeNotice | null>(null);
  const [terminals, setTerminals] = useState<TerminalInfo[]>([]);

  const refreshTree = useCallback(async () => {
    const [{ root, name }, treeResponse] = await Promise.all([
      getWorkspace(),
      fetchTree(),
    ]);
    setWorkspaceInfo({ root, name });
    setFileTree(treeResponse.tree);
  }, []);

  const refreshTerminals = useCallback(async () => {
    const next = await listTerminals();
    setTerminals(next);
  }, []);

  const loadFolderChildren = useCallback(async (path: string) => {
    const next = await fetchFolderChildren(path);
    setFileTree((currentTree) => {
      if (!currentTree) return currentTree;
      return replaceFolderChildren(currentTree, next.path, next.children);
    });
  }, []);

  const createNewTerminal = useCallback(async (shell?: string) => {
    const terminal = await createTerminal(shell);
    await refreshTerminals();
    return terminal;
  }, [refreshTerminals]);

  const openFolder = useCallback(async (root: string) => {
    setLoading(true);
    try {
      const next = await openWorkspace(root);
      setWorkspaceInfo({ root: next.root, name: next.name });
      setFileTree(next.tree);
      setError(null);
      await refreshTerminals();
    } catch (nextError) {
      setError(nextError instanceof Error ? nextError.message : "Failed to open workspace");
      throw nextError;
    } finally {
      setLoading(false);
    }
  }, [refreshTerminals]);

  useEffect(() => {
    let mounted = true;

    async function load(): Promise<void> {
      setLoading(true);
      try {
        const [{ root, name }, treeResponse, terminalList] = await Promise.all([
          getWorkspace(),
          fetchTree(),
          listTerminals(),
        ]);
        if (!mounted) return;
        setWorkspaceInfo({ root, name });
        setFileTree(treeResponse.tree);
        setTerminals(terminalList);
        setError(null);
      } catch (nextError) {
        if (!mounted) return;
        setError(nextError instanceof Error ? nextError.message : "Failed to load workspace");
      } finally {
        if (mounted) {
          setLoading(false);
        }
      }
    }

    void load();

    return () => {
      mounted = false;
    };
  }, []);

  useEffect(() => {
    const socket = new JsonWebSocket<FileWatcherEvent>(
      `${toWebSocketUrl(getServerBaseUrl())}/ws/fs`
    );

    const unsubscribers = [
      socket.onState((state) =>
        setConnectionState(state as WorkspaceContextValue["connectionState"])
      ),
      socket.onMessage((event) => {
        if (event.type === "workspace_changed") {
          setWorkspaceInfo({ root: event.root, name: event.name });
          void refreshTree();
          return;
        }

        if (event.type === "change") {
          setLastFileChange({ path: event.path, at: Date.now() });
          return;
        }

        if (event.type === "add" || event.type === "addDir") {
          setFileTree((currentTree) => {
            if (!currentTree) return currentTree;
            return addNodeToTree(
              currentTree,
              event.path,
              createNodeFromEvent(event.path, event.isDir)
            );
          });
          return;
        }

        if (event.type === "unlink" || event.type === "unlinkDir") {
          setFileTree((currentTree) => {
            if (!currentTree) return currentTree;
            return removeNodeFromTree(currentTree, event.path);
          });
        }
      }),
      socket.onError(() => {
        setError("Lost connection to the IDE backend.");
      }),
      socket.onOpen(() => {
        setError(null);
      }),
    ];

    socket.connect();

    return () => {
      unsubscribers.forEach((unsubscribe) => unsubscribe());
      socket.disconnect();
    };
  }, [refreshTree]);

  const value = useMemo<WorkspaceContextValue>(
    () => ({
      workspaceInfo,
      fileTree,
      loading,
      connected: connectionState === "open",
      connectionState,
      error,
      lastFileChange,
      terminals,
      refreshTree,
      refreshTerminals,
      loadFolderChildren,
      openFolder,
      createNewTerminal,
    }),
    [
      connectionState,
      error,
      fileTree,
      lastFileChange,
      loadFolderChildren,
      loading,
      openFolder,
      refreshTerminals,
      refreshTree,
      terminals,
      workspaceInfo,
      createNewTerminal,
    ]
  );

  return (
    <WorkspaceContext.Provider value={value}>
      {children}
    </WorkspaceContext.Provider>
  );
}

export function useWorkspace(): WorkspaceContextValue {
  const context = useContext(WorkspaceContext);
  if (!context) {
    throw new Error("useWorkspace must be used within WorkspaceProvider");
  }
  return context;
}
