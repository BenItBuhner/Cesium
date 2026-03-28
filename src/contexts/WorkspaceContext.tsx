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
import type {
  FileNode,
  FileWatcherEvent,
  TerminalInfo,
  WorkspaceInfo,
  WorkspaceRecord,
} from "@/lib/types";
import {
  createTerminal,
  createWorkspaceSelection,
  fetchFolderChildren,
  fetchTree,
  fetchWorkspaceBootstrap,
  fetchWorkspaceSession,
  getServerBaseUrl,
  listTerminals,
  openWorkspaceSelection,
  saveWorkspaceSession,
  setActiveWorkspaceId,
  setDefaultWorkspaceSelection,
} from "@/lib/server-api";
import {
  createDefaultWorkspaceSession,
  createPersistableWorkspaceSession,
  type WorkspaceSessionState,
} from "@/lib/workspace-session";
import { JsonWebSocket, toWebSocketUrl } from "@/lib/ws-client";
import { useWorkbenchNotifications } from "@/components/notifications/WorkbenchNotificationProvider";
import { WORKBENCH_NOTIFICATION_KIND } from "@/components/notifications/workbench-notification-types";
import { currentModel } from "@/lib/mock-data";

const HEARTBEAT_INTERVAL_MS = 5_000;
const PONG_STALE_MS = 12_000;
const RECONNECT_TOAST_MS = 5_000;
const SESSION_SAVE_DEBOUNCE_MS = 500;
const SESSION_BACKUP_STORAGE_PREFIX = "opencursor.workspace-session.";

type WorkspaceSessionBackup = {
  savedAt: number;
  session: WorkspaceSessionState;
};

type FileChangeNotice = {
  path: string;
  at: number;
};

type WorkspaceContextValue = {
  workspaceInfo: WorkspaceInfo | null;
  activeWorkspaceId: string | null;
  workspaces: WorkspaceRecord[];
  defaultWorkspaceId: string | null;
  recentWorkspaceIds: string[];
  fileTree: FileNode | null;
  loading: boolean;
  sessionReady: boolean;
  workspaceSession: WorkspaceSessionState;
  updateWorkspaceSession: (
    updater: (current: WorkspaceSessionState) => WorkspaceSessionState
  ) => void;
  connected: boolean;
  connectionState: "idle" | "connecting" | "open" | "closed" | "reconnecting";
  lastFileChange: FileChangeNotice | null;
  fsResyncToken: number;
  terminals: TerminalInfo[];
  refreshTree: () => Promise<void>;
  refreshTerminals: () => Promise<void>;
  loadFolderChildren: (path: string) => Promise<void>;
  openFolder: (root: string, name?: string) => Promise<void>;
  openWorkspaceById: (workspaceId: string) => Promise<void>;
  createWorkspace: (input: {
    name?: string;
    parentPath: string;
    directoryName: string;
    setDefault?: boolean;
  }) => Promise<void>;
  setDefaultWorkspace: (workspaceId: string) => Promise<void>;
  createNewTerminal: (shell?: string) => Promise<{ id: string }>;
};

const WorkspaceContext = createContext<WorkspaceContextValue | null>(null);

function createSessionDefaults(): WorkspaceSessionState {
  return createDefaultWorkspaceSession([], currentModel);
}

function getWorkspaceSessionBackupKey(workspaceId: string): string {
  return `${SESSION_BACKUP_STORAGE_PREFIX}${workspaceId}`;
}

function readWorkspaceSessionBackup(workspaceId: string): WorkspaceSessionState | null {
  if (typeof window === "undefined") {
    return null;
  }

  try {
    const raw = window.localStorage.getItem(getWorkspaceSessionBackupKey(workspaceId));
    if (!raw) {
      return null;
    }
    const parsed = JSON.parse(raw) as WorkspaceSessionBackup | null;
    if (!parsed || typeof parsed !== "object") {
      return null;
    }
    return parsed.session ?? null;
  } catch {
    return null;
  }
}

function writeWorkspaceSessionBackup(
  workspaceId: string,
  session: WorkspaceSessionState
): void {
  if (typeof window === "undefined") {
    return;
  }

  try {
    const backup: WorkspaceSessionBackup = {
      savedAt: Date.now(),
      session,
    };
    window.localStorage.setItem(
      getWorkspaceSessionBackupKey(workspaceId),
      JSON.stringify(backup)
    );
  } catch {
    // Ignore local backup failures; server persistence still runs in the background.
  }
}

function normalizeWorkspaceSession(
  raw: WorkspaceSessionState | null | undefined
): WorkspaceSessionState {
  const defaults = createSessionDefaults();
  if (!raw || raw.schemaVersion !== 1) {
    return defaults;
  }

  return {
    schemaVersion: 1,
    editor: {
      ...defaults.editor,
      ...(raw.editor ?? {}),
      leftTabs: Array.isArray(raw.editor?.leftTabs) ? raw.editor.leftTabs : defaults.editor.leftTabs,
      rightTabs: Array.isArray(raw.editor?.rightTabs) ? raw.editor.rightTabs : defaults.editor.rightTabs,
      viewStateByTabId:
        raw.editor?.viewStateByTabId && typeof raw.editor.viewStateByTabId === "object"
          ? raw.editor.viewStateByTabId
          : defaults.editor.viewStateByTabId,
    },
    chat: {
      ...defaults.chat,
      ...(raw.chat ?? {}),
      tabs: Array.isArray(raw.chat?.tabs) && raw.chat.tabs.length > 0 ? raw.chat.tabs : defaults.chat.tabs,
      scrollTopByTabId:
        raw.chat?.scrollTopByTabId && typeof raw.chat.scrollTopByTabId === "object"
          ? raw.chat.scrollTopByTabId
          : defaults.chat.scrollTopByTabId,
      hiddenConversationIds: Array.isArray(raw.chat?.hiddenConversationIds)
        ? raw.chat.hiddenConversationIds.filter(
            (value): value is string => typeof value === "string" && value.length > 0
          )
        : defaults.chat.hiddenConversationIds,
      model: raw.chat?.model ?? defaults.chat.model,
      mode: raw.chat?.mode ?? defaults.chat.mode,
      backendId:
        raw.chat?.backendId === "cursor-acp" ||
        raw.chat?.backendId === "opencode-acp" ||
        raw.chat?.backendId === "codex-adapter" ||
        raw.chat?.backendId === "claude-adapter"
          ? raw.chat.backendId
          : defaults.chat.backendId,
    },
    explorer: {
      ...defaults.explorer,
      ...(raw.explorer ?? {}),
      expandedPaths: Array.isArray(raw.explorer?.expandedPaths)
        ? raw.explorer.expandedPaths
        : defaults.explorer.expandedPaths,
    },
    layout: {
      ...defaults.layout,
      ...(raw.layout ?? {}),
      desktopLayout:
        raw.layout?.desktopLayout && typeof raw.layout.desktopLayout === "object"
          ? raw.layout.desktopLayout
          : defaults.layout.desktopLayout,
    },
    settingsView: {
      ...defaults.settingsView,
      ...(raw.settingsView ?? {}),
    },
  };
}

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
  const { pushNotification, dismissByKind } = useWorkbenchNotifications();
  const [workspaceInfo, setWorkspaceInfo] = useState<WorkspaceInfo | null>(null);
  const [activeWorkspaceId, setActiveWorkspaceIdState] = useState<string | null>(null);
  const [workspaces, setWorkspaces] = useState<WorkspaceRecord[]>([]);
  const [defaultWorkspaceId, setDefaultWorkspaceIdState] = useState<string | null>(null);
  const [recentWorkspaceIds, setRecentWorkspaceIds] = useState<string[]>([]);
  const [fileTree, setFileTree] = useState<FileNode | null>(null);
  const [loading, setLoading] = useState(true);
  const [sessionReady, setSessionReady] = useState(false);
  const [workspaceSession, setWorkspaceSession] = useState<WorkspaceSessionState>(
    createSessionDefaults()
  );
  const [connectionState, setConnectionState] =
    useState<WorkspaceContextValue["connectionState"]>("idle");
  const [lastFileChange, setLastFileChange] = useState<FileChangeNotice | null>(null);
  const [fsResyncToken, setFsResyncToken] = useState(0);
  const [terminals, setTerminals] = useState<TerminalInfo[]>([]);

  const workspaceSessionRef = useRef(workspaceSession);
  const lastSeenSeqRef = useRef(0);
  const hasSyncedOnceRef = useRef(false);
  const sessionSaveTimerRef = useRef<number | null>(null);
  const skipNextSessionSaveRef = useRef(false);

  useEffect(() => {
    workspaceSessionRef.current = workspaceSession;
  }, [workspaceSession]);

  const setServerWorkspace = useCallback((workspace: WorkspaceRecord | null) => {
    setActiveWorkspaceId(workspace?.id ?? null);
    setActiveWorkspaceIdState(workspace?.id ?? null);
    setWorkspaceInfo(
      workspace
        ? {
            id: workspace.id,
            root: workspace.root,
            name: workspace.name,
          }
        : null
    );
  }, []);

  const updateWorkspaceSession = useCallback(
    (updater: (current: WorkspaceSessionState) => WorkspaceSessionState) => {
      setWorkspaceSession((current) => updater(current));
    },
    []
  );

  const flushWorkspaceSessionNow = useCallback(
    async () => {
      if (!workspaceInfo || !sessionReady) {
        return;
      }

      if (sessionSaveTimerRef.current) {
        window.clearTimeout(sessionSaveTimerRef.current);
        sessionSaveTimerRef.current = null;
      }

      const persistableSession = createPersistableWorkspaceSession(
        workspaceSessionRef.current
      );
      writeWorkspaceSessionBackup(workspaceInfo.id, persistableSession);

      await saveWorkspaceSession(workspaceInfo.id, persistableSession).catch(() => {
        // Ignore flush failures; background saves will retry on future changes.
      });
    },
    [sessionReady, workspaceInfo]
  );

  const refreshTree = useCallback(async () => {
    if (!activeWorkspaceId) {
      return;
    }
    const treeResponse = await fetchTree();
    setFileTree(treeResponse.tree);
  }, [activeWorkspaceId]);

  const refreshTerminals = useCallback(async () => {
    if (!activeWorkspaceId) {
      setTerminals([]);
      return;
    }
    const next = await listTerminals();
    setTerminals(next);
  }, [activeWorkspaceId]);

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

  const loadWorkspaceState = useCallback(
    async (workspace: WorkspaceRecord) => {
      setLoading(true);
      setSessionReady(false);
      setLastFileChange(null);
      hasSyncedOnceRef.current = false;
      lastSeenSeqRef.current = 0;
      setServerWorkspace(workspace);

      try {
        const [{ tree }, { session }, terminalList] = await Promise.all([
          fetchTree(),
          fetchWorkspaceSession(workspace.id),
          listTerminals(),
        ]);
        const localBackup = readWorkspaceSessionBackup(workspace.id);
        setFileTree(tree);
        setTerminals(terminalList);
        skipNextSessionSaveRef.current = true;
        setWorkspaceSession(normalizeWorkspaceSession(session ?? localBackup));
        setSessionReady(true);
        setFsResyncToken((value) => value + 1);
      } finally {
        setLoading(false);
      }
    },
    [setServerWorkspace]
  );

  const applyWorkspaceListingUpdate = useCallback(
    (nextWorkspaces: WorkspaceRecord[], nextDefaultWorkspaceId: string | null, nextRecent: string[]) => {
      setWorkspaces(nextWorkspaces);
      setDefaultWorkspaceIdState(nextDefaultWorkspaceId);
      setRecentWorkspaceIds(nextRecent);
    },
    []
  );

  const openWorkspaceById = useCallback(
    async (workspaceId: string) => {
      await flushWorkspaceSessionNow();
      const result = await openWorkspaceSelection({ workspaceId });
      applyWorkspaceListingUpdate(
        result.workspaces,
        result.defaultWorkspaceId,
        result.recentWorkspaceIds
      );
      await loadWorkspaceState(result.workspace);
    },
    [applyWorkspaceListingUpdate, flushWorkspaceSessionNow, loadWorkspaceState]
  );

  const openFolder = useCallback(
    async (root: string, name?: string) => {
      await flushWorkspaceSessionNow();
      const result = await openWorkspaceSelection({ root, name });
      applyWorkspaceListingUpdate(
        result.workspaces,
        result.defaultWorkspaceId,
        result.recentWorkspaceIds
      );
      await loadWorkspaceState(result.workspace);
    },
    [applyWorkspaceListingUpdate, flushWorkspaceSessionNow, loadWorkspaceState]
  );

  const createWorkspace = useCallback(
    async (input: {
      name?: string;
      parentPath: string;
      directoryName: string;
      setDefault?: boolean;
    }) => {
      await flushWorkspaceSessionNow();
      const result = await createWorkspaceSelection(input);
      applyWorkspaceListingUpdate(
        result.workspaces,
        result.defaultWorkspaceId,
        result.recentWorkspaceIds
      );
      await loadWorkspaceState(result.workspace);
    },
    [applyWorkspaceListingUpdate, flushWorkspaceSessionNow, loadWorkspaceState]
  );

  const setDefaultWorkspace = useCallback(async (workspaceId: string) => {
    const result = await setDefaultWorkspaceSelection(workspaceId);
    setDefaultWorkspaceIdState(result.defaultWorkspaceId);
  }, []);

  useEffect(() => {
    let mounted = true;

    async function bootstrap(): Promise<void> {
      setLoading(true);
      try {
        const bootstrapResult = await fetchWorkspaceBootstrap();
        if (!mounted) return;
        applyWorkspaceListingUpdate(
          bootstrapResult.workspaces,
          bootstrapResult.defaultWorkspaceId,
          bootstrapResult.recentWorkspaceIds
        );
        const startupWorkspace = bootstrapResult.workspaces.find(
          (workspace) => workspace.id === bootstrapResult.startupWorkspaceId
        ) ?? bootstrapResult.workspaces[0];
        if (!startupWorkspace) {
          setLoading(false);
          return;
        }
        await loadWorkspaceState(startupWorkspace);
      } catch (nextError) {
        if (!mounted) return;
        const msg =
          nextError instanceof Error ? nextError.message : "Failed to load workspace";
        pushNotification({
          kind: WORKBENCH_NOTIFICATION_KIND.workspaceLoadError,
          severity: "error",
          title: "Workspace error",
          message: msg,
          persistent: false,
          autoDismissMs: 10_000,
        });
        setLoading(false);
      }
    }

    void bootstrap();

    return () => {
      mounted = false;
    };
  }, [applyWorkspaceListingUpdate, loadWorkspaceState, pushNotification]);

  useEffect(() => {
    if (!workspaceInfo || !sessionReady) {
      return;
    }

    if (skipNextSessionSaveRef.current) {
      skipNextSessionSaveRef.current = false;
      return;
    }

    if (sessionSaveTimerRef.current) {
      window.clearTimeout(sessionSaveTimerRef.current);
    }

    sessionSaveTimerRef.current = window.setTimeout(() => {
      const persistableSession = createPersistableWorkspaceSession(
        workspaceSessionRef.current
      );
      writeWorkspaceSessionBackup(workspaceInfo.id, persistableSession);
      void saveWorkspaceSession(workspaceInfo.id, persistableSession).catch(() => {
        // Ignore save failures here; user-visible work continues in memory.
      });
    }, SESSION_SAVE_DEBOUNCE_MS);

    return () => {
      if (sessionSaveTimerRef.current) {
        window.clearTimeout(sessionSaveTimerRef.current);
      }
    };
  }, [workspaceInfo, workspaceSession, sessionReady]);

  useEffect(() => {
    if (!workspaceInfo || !sessionReady) {
      return;
    }

    const flushForPageHide = () => {
      writeWorkspaceSessionBackup(
        workspaceInfo.id,
        createPersistableWorkspaceSession(workspaceSessionRef.current)
      );
    };

    const handleVisibilityChange = () => {
      if (document.visibilityState === "hidden") {
        flushForPageHide();
      }
    };

    window.addEventListener("pagehide", flushForPageHide);
    window.addEventListener("beforeunload", flushForPageHide);
    document.addEventListener("visibilitychange", handleVisibilityChange);

    return () => {
      window.removeEventListener("pagehide", flushForPageHide);
      window.removeEventListener("beforeunload", flushForPageHide);
      document.removeEventListener("visibilitychange", handleVisibilityChange);
    };
  }, [flushWorkspaceSessionNow, sessionReady, workspaceInfo]);

  useEffect(() => {
    if (!activeWorkspaceId) {
      return;
    }

    let active = true;
    let openedAt = Date.now();
    let lastPongAt: number | null = null;
    const suppressedDisconnectRef = { current: false };
    const wasDisconnectedRef = { current: false };
    let connectionLostHandled = false;

    const socket = new JsonWebSocket<FileWatcherEvent>(() => {
      const params = new URLSearchParams({ workspaceId: activeWorkspaceId });
      if (hasSyncedOnceRef.current && lastSeenSeqRef.current > 0) {
        params.set("since", String(lastSeenSeqRef.current));
      }
      return `${toWebSocketUrl(getServerBaseUrl())}/ws/fs?${params.toString()}`;
    });

    function handleConnectionLost(message: string) {
      if (!active) return;
      if (connectionLostHandled) return;
      connectionLostHandled = true;
      wasDisconnectedRef.current = true;
      if (!suppressedDisconnectRef.current) {
        dismissByKind(WORKBENCH_NOTIFICATION_KIND.connectionReconnected);
        dismissByKind(WORKBENCH_NOTIFICATION_KIND.connectionDisconnected);
        pushNotification({
          kind: WORKBENCH_NOTIFICATION_KIND.connectionDisconnected,
          severity: "error",
          title: "Disconnected",
          message,
          persistent: true,
          onDismiss: () => {
            suppressedDisconnectRef.current = true;
          },
          actions: [
            {
              id: "retry",
              label: "Retry",
              primary: true,
              onClick: () => {
                void refreshTree();
                socket.forceCloseConnection();
              },
            },
          ],
        });
      }
    }

    function tryReconnectToast() {
      if (!active) return;
      if (!wasDisconnectedRef.current) return;
      if (lastPongAt == null) return;
      if (Date.now() - lastPongAt > PONG_STALE_MS) return;
      if (!socket.connected) return;
      wasDisconnectedRef.current = false;
      suppressedDisconnectRef.current = false;
      dismissByKind(WORKBENCH_NOTIFICATION_KIND.connectionDisconnected);
      dismissByKind(WORKBENCH_NOTIFICATION_KIND.connectionReconnected);
      pushNotification({
        kind: WORKBENCH_NOTIFICATION_KIND.connectionReconnected,
        severity: "info",
        title: "Reconnected",
        message: "Connection to the IDE backend was restored.",
        persistent: false,
        autoDismissMs: RECONNECT_TOAST_MS,
      });
    }

    const unsubscribers = [
      socket.onState((state) =>
        setConnectionState(state as WorkspaceContextValue["connectionState"])
      ),
      socket.onOpen(() => {
        openedAt = Date.now();
        lastPongAt = null;
        connectionLostHandled = false;
      }),
      socket.onMessage((event) => {
        if (event.type === "workspace_snapshot") {
          setWorkspaceInfo({
            id: event.workspaceId,
            root: event.root,
            name: event.name,
          });
          return;
        }

        if (event.type === "ready") {
          hasSyncedOnceRef.current = true;
          lastSeenSeqRef.current = Math.max(lastSeenSeqRef.current, event.latestSeq);
          return;
        }

        if (event.type === "resync_required") {
          hasSyncedOnceRef.current = true;
          lastSeenSeqRef.current = event.latestSeq;
          setFsResyncToken((value) => value + 1);
          void refreshTree();
          return;
        }

        if (event.type === "pong") {
          lastPongAt = Date.now();
          lastSeenSeqRef.current = Math.max(lastSeenSeqRef.current, event.latestSeq);
          tryReconnectToast();
          return;
        }

        lastSeenSeqRef.current = event.seq;

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
      socket.onClose(() => {
        handleConnectionLost("Lost connection to the IDE backend.");
      }),
      socket.onError(() => {
        handleConnectionLost("Lost connection to the IDE backend.");
      }),
    ];

    const heartbeat = window.setInterval(() => {
      if (!active) return;
      if (!socket.connected) return;
      socket.send({ type: "ping" });
      const stale =
        lastPongAt == null
          ? Date.now() - openedAt > PONG_STALE_MS
          : Date.now() - lastPongAt > PONG_STALE_MS;
      if (stale) {
        handleConnectionLost(
          "No response from the IDE backend. The connection may be stale."
        );
        socket.forceCloseConnection();
      }
    }, HEARTBEAT_INTERVAL_MS);

    socket.connect();

    return () => {
      active = false;
      window.clearInterval(heartbeat);
      unsubscribers.forEach((unsubscribe) => unsubscribe());
      socket.disconnect();
    };
  }, [activeWorkspaceId, dismissByKind, pushNotification, refreshTree]);

  const value = useMemo<WorkspaceContextValue>(
    () => ({
      workspaceInfo,
      activeWorkspaceId,
      workspaces,
      defaultWorkspaceId,
      recentWorkspaceIds,
      fileTree,
      loading,
      sessionReady,
      workspaceSession,
      updateWorkspaceSession,
      connected: connectionState === "open",
      connectionState,
      lastFileChange,
      fsResyncToken,
      terminals,
      refreshTree,
      refreshTerminals,
      loadFolderChildren,
      openFolder,
      openWorkspaceById,
      createWorkspace,
      setDefaultWorkspace,
      createNewTerminal,
    }),
    [
      workspaceInfo,
      activeWorkspaceId,
      workspaces,
      defaultWorkspaceId,
      recentWorkspaceIds,
      fileTree,
      loading,
      sessionReady,
      workspaceSession,
      updateWorkspaceSession,
      connectionState,
      lastFileChange,
      fsResyncToken,
      terminals,
      refreshTree,
      refreshTerminals,
      loadFolderChildren,
      openFolder,
      openWorkspaceById,
      createWorkspace,
      setDefaultWorkspace,
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
