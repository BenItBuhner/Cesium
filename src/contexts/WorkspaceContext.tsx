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
  GitWorkspaceStatus,
  GitWorktreeSetupResult,
  TerminalInfo,
  WorkspaceInfo,
  WorkspaceWindowRecord,
  WorkspaceRecord,
} from "@/lib/types";
import {
  cloneWorkspaceFromGit,
  createWorkspaceGitWorktree,
  createTerminal,
  createWorkspaceSelection,
  createWorkspaceWindow,
  deleteWorkspaceGitWorktree,
  deleteWorkspaceFromRegistry,
  fetchWorkspaceGitStatus,
  fetchWorkspaceWindows,
  fetchFolderChildren,
  fetchTree,
  fetchWorkspaceBootstrap,
  fetchWorkspaceSession,
  getServerBaseUrl,
  listTerminals,
  markWorkspaceActivity as postWorkspaceActivity,
  openWorkspaceSelection,
  saveWorkspaceSession,
  setActiveWorkspaceId,
  setDefaultWorkspaceSelection,
  switchWorkspaceGitBranch,
  updateWorkspaceWindow,
} from "@/lib/server-api";
import {
  createDefaultWorkspaceSession,
  mergeWorkspaceSessionFromImport,
  createPersistableWorkspaceSession,
  type WorkspaceSessionState,
} from "@/lib/workspace-session";
import { normalizeWorkspaceScopedRoute } from "@/lib/workspace-windows";
import {
  WORKBENCH_VIEW_SEARCH_PARAM,
  workbenchViewFromSearchParam,
} from "@/lib/workbench-view";
import { JsonWebSocket, toWebSocketUrl } from "@/lib/ws-client";
import { buildAuthenticatedUrl } from "@/lib/auth-client";
import { getActiveServerStorageKey } from "@/lib/server-connections";
import { getConfiguredServerBaseUrl } from "@/lib/resolve-server-base-url";
import { useWorkbenchNotifications } from "@/components/notifications/WorkbenchNotificationProvider";
import { WORKBENCH_NOTIFICATION_KIND } from "@/components/notifications/workbench-notification-types";
import { currentModel } from "@/lib/mock-data";

const HEARTBEAT_INTERVAL_MS = 3_000;
/** Allow slow pongs, quiet workspaces, and main-thread stalls (heavy chat renders) without killing the FS socket. */
const PONG_STALE_MS = 90_000;
/** If the heartbeat timer fires this late, the event loop was probably stalled — do not infer a dead socket from skewed time. */
const HEARTBEAT_DRIFT_SKIP_STALE_MS = HEARTBEAT_INTERVAL_MS * 12;
/** Number of consecutive stale heartbeat ticks required before declaring the connection dead. Tolerates several dropped pongs on quiet workspaces. */
const STALE_TICK_THRESHOLD = 7;
/** Ignore startup socket flaps while the client and backend settle. */
const STARTUP_CONNECTION_NOTIFICATION_GRACE_MS = 10_000;
const RECONNECT_TOAST_MS = 2_000;
const DISCONNECT_TOAST_MS = 3_000;
const SESSION_SAVE_DEBOUNCE_MS = 350;
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
  activeWindowId: string | null;
  isDedicatedWindow: boolean;
  workspaces: WorkspaceRecord[];
  workspaceWindows: WorkspaceWindowRecord[];
  gitStatus: GitWorkspaceStatus | null;
  gitStatusLoading: boolean;
  defaultWorkspaceId: string | null;
  recentWorkspaceIds: string[];
  fileTree: FileNode | null;
  loading: boolean;
  sessionReady: boolean;
  workspaceSession: WorkspaceSessionState;
  updateWorkspaceSession: (
    updater: (current: WorkspaceSessionState) => WorkspaceSessionState
  ) => void;
  updateWorkspaceSessionNow: (
    updater: (current: WorkspaceSessionState) => WorkspaceSessionState
  ) => Promise<void>;
  flushWorkspaceSessionNow: () => Promise<void>;
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
  refreshGitStatus: () => Promise<GitWorkspaceStatus | null>;
  switchBranch: (branch: string) => Promise<void>;
  createWorktree: (input: {
    branch: string;
    baseBranch?: string;
    newBranch?: boolean;
    targetPath?: string;
    runSetup?: boolean;
    name?: string;
  }) => Promise<{ workspace: WorkspaceRecord; setup: GitWorktreeSetupResult }>;
  deleteWorktree: (input: { path: string; force?: boolean }) => Promise<void>;
  markWorkspaceActivity: (workspaceId?: string) => Promise<void>;
  refreshWorkspaceWindows: () => Promise<void>;
  createWorkspaceWindow: (input?: {
    title?: string;
  }) => Promise<WorkspaceWindowRecord>;
  updateWorkspaceWindow: (
    windowId: string,
    patch: { title?: string; lastFocusedAt?: number }
  ) => Promise<WorkspaceWindowRecord>;
  createWorkspace: (input: {
    name?: string;
    parentPath: string;
    directoryName: string;
    setDefault?: boolean;
  }) => Promise<void>;
  cloneWorkspaceFromGit: (input: {
    repoUrl: string;
    parentPath: string;
    directoryName?: string;
    name?: string;
    setDefault?: boolean;
  }) => Promise<void>;
  deleteWorkspace: (workspaceId: string) => Promise<void>;
  homeWorkspaceId: string | null;
  setDefaultWorkspace: (workspaceId: string) => Promise<void>;
  createNewTerminal: (shell?: string) => Promise<{ id: string }>;
};

const WorkspaceContext = createContext<WorkspaceContextValue | null>(null);

function createSessionDefaults(): WorkspaceSessionState {
  return createDefaultWorkspaceSession([], currentModel);
}

function readWindowLocationContext(): {
  requestedWorkspaceId: string | null;
  windowId: string | null;
} {
  if (typeof window === "undefined") {
    return { requestedWorkspaceId: null, windowId: null };
  }

  const url = new URL(window.location.href);
  const requestedWorkspaceId = url.searchParams.get("workspaceId")?.trim() || null;
  const windowId = url.searchParams.get("windowId")?.trim() || null;
  return { requestedWorkspaceId, windowId };
}

function writeWindowLocationContext(
  workspaceId: string | null,
  windowId: string | null
): void {
  if (typeof window === "undefined") {
    return;
  }

  const url = new URL(window.location.href);
  url.pathname = normalizeWorkspaceScopedRoute(window.location.pathname);
  if (workspaceId) {
    url.searchParams.set("workspaceId", workspaceId);
  } else {
    url.searchParams.delete("workspaceId");
  }
  if (windowId) {
    url.searchParams.set("windowId", windowId);
  } else {
    url.searchParams.delete("windowId");
  }

  const nextUrl = `${url.pathname}${url.search}${url.hash}`;
  const currentUrl = `${window.location.pathname}${window.location.search}${window.location.hash}`;
  if (nextUrl !== currentUrl) {
    window.history.replaceState(null, "", nextUrl);
  }
}

function getWorkspaceSessionScopeId(
  workspaceId: string,
  windowId: string | null
): string {
  return windowId ? `${workspaceId}:window:${windowId}` : workspaceId;
}

function getWorkspaceSessionBackupKey(sessionScopeId: string): string {
  return `${SESSION_BACKUP_STORAGE_PREFIX}${getActiveServerStorageKey(getConfiguredServerBaseUrl())}.${sessionScopeId}`;
}

function getLegacyWorkspaceSessionBackupKey(sessionScopeId: string): string {
  return `${SESSION_BACKUP_STORAGE_PREFIX}${sessionScopeId}`;
}

function readWorkspaceSessionBackup(sessionScopeId: string): WorkspaceSessionState | null {
  if (typeof window === "undefined") {
    return null;
  }

  try {
    const raw =
      window.localStorage.getItem(getWorkspaceSessionBackupKey(sessionScopeId)) ??
      window.localStorage.getItem(getLegacyWorkspaceSessionBackupKey(sessionScopeId));
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
  sessionScopeId: string,
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
      getWorkspaceSessionBackupKey(sessionScopeId),
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
  return mergeWorkspaceSessionFromImport(defaults, raw);
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
  const [{ requestedWorkspaceId, windowId }] = useState(readWindowLocationContext);
  const [workspaceInfo, setWorkspaceInfo] = useState<WorkspaceInfo | null>(null);
  const [activeWorkspaceId, setActiveWorkspaceIdState] = useState<string | null>(null);
  const [workspaces, setWorkspaces] = useState<WorkspaceRecord[]>([]);
  const [workspaceWindows, setWorkspaceWindows] = useState<WorkspaceWindowRecord[]>([]);
  const [gitStatus, setGitStatus] = useState<GitWorkspaceStatus | null>(null);
  const [gitStatusLoading, setGitStatusLoading] = useState(false);
  const [defaultWorkspaceId, setDefaultWorkspaceIdState] = useState<string | null>(null);
  const [recentWorkspaceIds, setRecentWorkspaceIds] = useState<string[]>([]);
  const [homeWorkspaceId, setHomeWorkspaceId] = useState<string | null>(null);
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
  const connectionNotificationGraceEndsAtRef = useRef(
    Date.now() + STARTUP_CONNECTION_NOTIFICATION_GRACE_MS
  );
  const sessionSaveTimerRef = useRef<number | null>(null);
  const skipNextSessionSaveRef = useRef(false);
  /** After the first successful workspace load, cross-workspace hops keep the shell mounted. */
  const hasCompletedWorkspaceHydrationRef = useRef(false);
  const isDedicatedWindow = windowId != null;

  const getSessionScopeId = useCallback(
    (workspaceId: string) => getWorkspaceSessionScopeId(workspaceId, windowId),
    [windowId]
  );

  useEffect(() => {
    workspaceSessionRef.current = workspaceSession;
  }, [workspaceSession]);

  const setServerWorkspace = useCallback((workspace: WorkspaceRecord | null) => {
    setActiveWorkspaceId(workspace?.id ?? null);
    setActiveWorkspaceIdState(workspace?.id ?? null);
    setGitStatus(null);
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

  const updateWorkspaceSessionNow = useCallback(
    async (updater: (current: WorkspaceSessionState) => WorkspaceSessionState) => {
      const current = workspaceSessionRef.current;
      const next = updater(current);
      if (next === current) {
        return;
      }

      workspaceSessionRef.current = next;
      setWorkspaceSession(next);

      if (!workspaceInfo || !sessionReady) {
        return;
      }

      if (sessionSaveTimerRef.current) {
        window.clearTimeout(sessionSaveTimerRef.current);
        sessionSaveTimerRef.current = null;
      }

      const persistableSession = createPersistableWorkspaceSession(next);
      const sessionScopeId = getSessionScopeId(workspaceInfo.id);
      writeWorkspaceSessionBackup(sessionScopeId, persistableSession);
      await saveWorkspaceSession(workspaceInfo.id, persistableSession, {
        windowId,
      }).catch(() => {
        // Ignore immediate save failures; future saves can retry.
      });
    },
    [getSessionScopeId, sessionReady, windowId, workspaceInfo]
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
      const sessionScopeId = getSessionScopeId(workspaceInfo.id);
      writeWorkspaceSessionBackup(sessionScopeId, persistableSession);
      await saveWorkspaceSession(workspaceInfo.id, persistableSession, {
        windowId,
      }).catch(() => {
        // Ignore flush failures; background saves will retry on future changes.
      });
    },
    [getSessionScopeId, sessionReady, windowId, workspaceInfo]
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

  const refreshWorkspaceWindows = useCallback(async () => {
    if (!activeWorkspaceId) {
      setWorkspaceWindows([]);
      return;
    }
    const result = await fetchWorkspaceWindows(activeWorkspaceId);
    setWorkspaceWindows(result.windows);
  }, [activeWorkspaceId]);

  const refreshGitStatus = useCallback(async (): Promise<GitWorkspaceStatus | null> => {
    if (!activeWorkspaceId) {
      setGitStatus(null);
      return null;
    }
    setGitStatusLoading(true);
    try {
      const result = await fetchWorkspaceGitStatus(activeWorkspaceId);
      setGitStatus(result.status);
      return result.status;
    } finally {
      setGitStatusLoading(false);
    }
  }, [activeWorkspaceId]);

  const createPersistentWorkspaceWindow = useCallback(
    async (input?: { title?: string }) => {
      if (!activeWorkspaceId) {
        throw new Error("No active workspace.");
      }
      const result = await createWorkspaceWindow({
        workspaceId: activeWorkspaceId,
        title: input?.title,
      });
      setWorkspaceWindows(result.windows);
      return result.window;
    },
    [activeWorkspaceId]
  );

  const updatePersistentWorkspaceWindow = useCallback(
    async (
      targetWindowId: string,
      patch: { title?: string; lastFocusedAt?: number }
    ) => {
      if (!activeWorkspaceId) {
        throw new Error("No active workspace.");
      }
      const result = await updateWorkspaceWindow({
        workspaceId: activeWorkspaceId,
        windowId: targetWindowId,
        name: patch.title,
        lastFocusedAt: patch.lastFocusedAt,
      });
      setWorkspaceWindows(result.windows);
      return result.window;
    },
    [activeWorkspaceId]
  );

  const loadWorkspaceState = useCallback(
    async (workspace: WorkspaceRecord) => {
      const isRepeatWorkspaceTransition = hasCompletedWorkspaceHydrationRef.current;

      setLoading(true);
      if (!isRepeatWorkspaceTransition) {
        setSessionReady(false);
      }
      setLastFileChange(null);
      hasSyncedOnceRef.current = false;
      lastSeenSeqRef.current = 0;
      setServerWorkspace(workspace);
      if (typeof window !== "undefined") {
        // Keep the URL in sync even while `loading` is true, so effects that return early
        // during `loadWorkspaceState` do not leave a stale `workspaceId` in the address bar
        // (e.g. after “new chat in other workspace” from the rail).
        writeWindowLocationContext(workspace.id, windowId);
      }

      const sessionScopeId = getSessionScopeId(workspace.id);
      if (isRepeatWorkspaceTransition) {
        const localOptimistic = readWorkspaceSessionBackup(sessionScopeId);
        let optimisticSession = normalizeWorkspaceSession(localOptimistic ?? undefined);
        if (!localOptimistic && typeof window !== "undefined") {
          const urlShell = workbenchViewFromSearchParam(
            new URL(window.location.href).searchParams.get(WORKBENCH_VIEW_SEARCH_PARAM)
          );
          if (urlShell !== "default") {
            optimisticSession = {
              ...optimisticSession,
              layout: { ...optimisticSession.layout, shellView: urlShell },
            };
          }
        }
        setWorkspaceSession(optimisticSession);
        setSessionReady(true);
      }

      try {
        // Block first paint only on data that affects initial layout (session +
        // windows). `fetchTree()` and `listTerminals()` are heavy/noisy and not
        // needed for the chat / editor shell, so kick them off but settle the
        // loading state as soon as the session is ready. They hydrate lazily.
        const sessionRequest = fetchWorkspaceSession(workspace.id, { windowId });
        const treePromise = fetchTree();
        const terminalsPromise = listTerminals();
        const gitStatusPromise = fetchWorkspaceGitStatus(workspace.id);

        const [sessionResult, windowsResult] = await Promise.all([
          sessionRequest,
          fetchWorkspaceWindows(workspace.id),
        ]);

        // Hydrate explorer + terminals in the background without blocking UI.
        void treePromise
          .then(({ tree }) => setFileTree(tree))
          .catch(() => undefined);
        void terminalsPromise
          .then((terminalList) => setTerminals(terminalList))
          .catch(() => undefined);
        void gitStatusPromise
          .then((result) => setGitStatus(result.status))
          .catch(() => setGitStatus(null));

        const localBackup = readWorkspaceSessionBackup(sessionScopeId);
        setWorkspaceWindows(windowsResult.windows);
        skipNextSessionSaveRef.current = true;
        let normalized = normalizeWorkspaceSession(localBackup ?? sessionResult.session);
        if (!localBackup && typeof window !== "undefined") {
          const urlShell = workbenchViewFromSearchParam(
            new URL(window.location.href).searchParams.get(WORKBENCH_VIEW_SEARCH_PARAM)
          );
          if (urlShell !== "default") {
            normalized = {
              ...normalized,
              layout: { ...normalized.layout, shellView: urlShell },
            };
          }
        }
        setWorkspaceSession(normalized);
        setSessionReady(true);
        setFsResyncToken((value) => value + 1);
        hasCompletedWorkspaceHydrationRef.current = true;
      } catch (error) {
        throw error;
      } finally {
        setLoading(false);
      }
    },
    [getSessionScopeId, setServerWorkspace, windowId]
  );

  const applyWorkspaceListingUpdate = useCallback(
    (
      nextWorkspaces: WorkspaceRecord[],
      nextDefaultWorkspaceId: string | null,
      nextRecent: string[],
      nextHomeWorkspaceId?: string | null
    ) => {
      setWorkspaces(nextWorkspaces);
      setDefaultWorkspaceIdState(nextDefaultWorkspaceId);
      setRecentWorkspaceIds(nextRecent);
      if (nextHomeWorkspaceId !== undefined) {
        setHomeWorkspaceId(nextHomeWorkspaceId);
      }
    },
    []
  );

  const loadWorkspaceStateRef = useRef(loadWorkspaceState);
  const applyWorkspaceListingUpdateRef = useRef(applyWorkspaceListingUpdate);
  const pushNotificationRef = useRef(pushNotification);
  const dismissByKindRef = useRef(dismissByKind);
  const refreshTreeRef = useRef(refreshTree);

  useEffect(() => {
    loadWorkspaceStateRef.current = loadWorkspaceState;
  }, [loadWorkspaceState]);

  useEffect(() => {
    applyWorkspaceListingUpdateRef.current = applyWorkspaceListingUpdate;
  }, [applyWorkspaceListingUpdate]);

  useEffect(() => {
    pushNotificationRef.current = pushNotification;
  }, [pushNotification]);

  useEffect(() => {
    dismissByKindRef.current = dismissByKind;
  }, [dismissByKind]);

  useEffect(() => {
    refreshTreeRef.current = refreshTree;
  }, [refreshTree]);

  useEffect(() => {
    if (!workspaceInfo || !sessionReady || !windowId) {
      return;
    }
    void updatePersistentWorkspaceWindow(windowId, {
      lastFocusedAt: Date.now(),
    }).catch(() => {
      // Ignore best-effort window activity updates.
    });
  }, [sessionReady, updatePersistentWorkspaceWindow, windowId, workspaceInfo]);

  useEffect(() => {
    if (!workspaceInfo || !windowId) {
      return;
    }
    const markWindowFocused = () => {
      void updatePersistentWorkspaceWindow(windowId, {
        lastFocusedAt: Date.now(),
      }).catch(() => {
        // Ignore best-effort focus updates.
      });
    };
    markWindowFocused();
    window.addEventListener("focus", markWindowFocused);
    return () => {
      window.removeEventListener("focus", markWindowFocused);
    };
  }, [updatePersistentWorkspaceWindow, windowId, workspaceInfo]);

  const openWorkspaceById = useCallback(
    async (workspaceId: string) => {
      await flushWorkspaceSessionNow();
      const result = await openWorkspaceSelection({ workspaceId });
      applyWorkspaceListingUpdate(
        result.workspaces,
        result.defaultWorkspaceId,
        result.recentWorkspaceIds,
        result.homeWorkspaceId
      );
      await loadWorkspaceState(result.workspace);
    },
    [applyWorkspaceListingUpdate, flushWorkspaceSessionNow, loadWorkspaceState]
  );

  const markWorkspaceActivity = useCallback(
    async (workspaceId?: string) => {
      const targetWorkspaceId = workspaceId ?? activeWorkspaceId;
      if (!targetWorkspaceId) {
        return;
      }
      const result = await postWorkspaceActivity(targetWorkspaceId);
      applyWorkspaceListingUpdate(
        result.workspaces,
        result.defaultWorkspaceId,
        result.recentWorkspaceIds,
        result.homeWorkspaceId
      );
    },
    [activeWorkspaceId, applyWorkspaceListingUpdate]
  );

  const openFolder = useCallback(
    async (root: string, name?: string) => {
      await flushWorkspaceSessionNow();
      const result = await openWorkspaceSelection({ root, name });
      applyWorkspaceListingUpdate(
        result.workspaces,
        result.defaultWorkspaceId,
        result.recentWorkspaceIds,
        result.homeWorkspaceId
      );
      await loadWorkspaceState(result.workspace);
    },
    [applyWorkspaceListingUpdate, flushWorkspaceSessionNow, loadWorkspaceState]
  );

  const switchBranch = useCallback(
    async (branch: string) => {
      if (!activeWorkspaceId) {
        throw new Error("No active workspace.");
      }
      await flushWorkspaceSessionNow();
      const result = await switchWorkspaceGitBranch({ workspaceId: activeWorkspaceId, branch });
      if (result.openedWorkspace) {
        await loadWorkspaceState(result.openedWorkspace);
      } else if (result.status) {
        setGitStatus(result.status);
        await Promise.all([
          refreshTree().catch(() => undefined),
          refreshTerminals().catch(() => undefined),
        ]);
        setFsResyncToken((value) => value + 1);
      }
    },
    [
      activeWorkspaceId,
      flushWorkspaceSessionNow,
      loadWorkspaceState,
      refreshTerminals,
      refreshTree,
    ]
  );

  const createWorktree = useCallback(
    async (input: {
      branch: string;
      baseBranch?: string;
      newBranch?: boolean;
      targetPath?: string;
      runSetup?: boolean;
      name?: string;
    }): Promise<{ workspace: WorkspaceRecord; setup: GitWorktreeSetupResult }> => {
      if (!activeWorkspaceId) {
        throw new Error("No active workspace.");
      }
      await flushWorkspaceSessionNow();
      const result = await createWorkspaceGitWorktree({
        workspaceId: activeWorkspaceId,
        ...input,
      });
      applyWorkspaceListingUpdate(
        result.workspaces,
        result.defaultWorkspaceId,
        result.recentWorkspaceIds,
        result.homeWorkspaceId
      );
      await loadWorkspaceState(result.workspace);
      return { workspace: result.workspace, setup: result.setup };
    },
    [
      activeWorkspaceId,
      applyWorkspaceListingUpdate,
      flushWorkspaceSessionNow,
      loadWorkspaceState,
    ]
  );

  const deleteWorktree = useCallback(
    async (input: { path: string; force?: boolean }) => {
      if (!activeWorkspaceId) {
        throw new Error("No active workspace.");
      }
      const result = await deleteWorkspaceGitWorktree({
        workspaceId: activeWorkspaceId,
        path: input.path,
        force: input.force,
      });
      applyWorkspaceListingUpdate(
        result.workspaces,
        result.defaultWorkspaceId,
        result.recentWorkspaceIds,
        result.homeWorkspaceId
      );
      await refreshGitStatus();
    },
    [activeWorkspaceId, applyWorkspaceListingUpdate, refreshGitStatus]
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
        result.recentWorkspaceIds,
        result.homeWorkspaceId
      );
      await loadWorkspaceState(result.workspace);
    },
    [applyWorkspaceListingUpdate, flushWorkspaceSessionNow, loadWorkspaceState]
  );

  const cloneWorkspaceFromGitHandler = useCallback(
    async (input: {
      repoUrl: string;
      parentPath: string;
      directoryName?: string;
      name?: string;
      setDefault?: boolean;
    }) => {
      await flushWorkspaceSessionNow();
      const result = await cloneWorkspaceFromGit(input);
      applyWorkspaceListingUpdate(
        result.workspaces,
        result.defaultWorkspaceId,
        result.recentWorkspaceIds,
        result.homeWorkspaceId
      );
      await loadWorkspaceState(result.workspace);
    },
    [applyWorkspaceListingUpdate, cloneWorkspaceFromGit, flushWorkspaceSessionNow, loadWorkspaceState]
  );

  const deleteWorkspace = useCallback(
    async (workspaceId: string) => {
      await flushWorkspaceSessionNow();
      const result = await deleteWorkspaceFromRegistry(workspaceId);
      applyWorkspaceListingUpdate(
        result.workspaces,
        result.defaultWorkspaceId,
        result.recentWorkspaceIds,
        result.homeWorkspaceId
      );
      if (workspaceId === activeWorkspaceId) {
        const fallback =
          result.workspaces.find((w) => w.id === result.homeWorkspaceId) ??
          result.workspaces[0] ??
          null;
        if (fallback) {
          await loadWorkspaceState(fallback);
        }
      }
    },
    [
      activeWorkspaceId,
      applyWorkspaceListingUpdate,
      flushWorkspaceSessionNow,
      loadWorkspaceState,
    ]
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
        if (requestedWorkspaceId) {
          try {
            const requestedResult = await openWorkspaceSelection({
              workspaceId: requestedWorkspaceId,
            });
            if (!mounted) return;
            applyWorkspaceListingUpdateRef.current(
              requestedResult.workspaces,
              requestedResult.defaultWorkspaceId,
              requestedResult.recentWorkspaceIds,
              requestedResult.homeWorkspaceId
            );
            await loadWorkspaceStateRef.current(requestedResult.workspace);
            return;
          } catch {
            // Fall back to the normal startup workspace when the requested id is invalid.
          }
        }
        applyWorkspaceListingUpdateRef.current(
          bootstrapResult.workspaces,
          bootstrapResult.defaultWorkspaceId,
          bootstrapResult.recentWorkspaceIds,
          bootstrapResult.homeWorkspaceId
        );
        const startupWorkspace = bootstrapResult.workspaces.find(
          (workspace) => workspace.id === bootstrapResult.startupWorkspaceId
        ) ?? bootstrapResult.workspaces[0];
        if (!startupWorkspace) {
          setLoading(false);
          return;
        }
        await loadWorkspaceStateRef.current(startupWorkspace);
      } catch (nextError) {
        if (!mounted) return;
        const msg =
          nextError instanceof Error ? nextError.message : "Failed to load workspace";
    pushNotificationRef.current({
      kind: WORKBENCH_NOTIFICATION_KIND.workspaceLoadError,
      severity: "error",
      title: "Workspace error",
      message: msg,
      persistent: false,
      autoDismissMs: 10_000,
      compact: true,
    });
        setLoading(false);
      }
    }

    void bootstrap();

    return () => {
      mounted = false;
    };
  }, [requestedWorkspaceId]);

  useEffect(() => {
    if (loading) {
      return;
    }
    writeWindowLocationContext(activeWorkspaceId, windowId);
  }, [activeWorkspaceId, loading, windowId]);

  useEffect(() => {
    if (!workspaceInfo || !sessionReady) {
      return;
    }

    writeWorkspaceSessionBackup(
      getSessionScopeId(workspaceInfo.id),
      createPersistableWorkspaceSession(workspaceSession)
    );
  }, [getSessionScopeId, sessionReady, workspaceInfo, workspaceSession]);

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
      writeWorkspaceSessionBackup(getSessionScopeId(workspaceInfo.id), persistableSession);
      void saveWorkspaceSession(workspaceInfo.id, persistableSession, {
        windowId,
      }).catch(() => {
        // Ignore save failures here; user-visible work continues in memory.
      });
    }, SESSION_SAVE_DEBOUNCE_MS);

    return () => {
      if (sessionSaveTimerRef.current) {
        window.clearTimeout(sessionSaveTimerRef.current);
      }
    };
  }, [getSessionScopeId, sessionReady, windowId, workspaceInfo, workspaceSession]);

  useEffect(() => {
    if (!workspaceInfo || !sessionReady) {
      return;
    }

    const flushForPageHide = () => {
      if (sessionSaveTimerRef.current) {
        window.clearTimeout(sessionSaveTimerRef.current);
        sessionSaveTimerRef.current = null;
      }
      const persistableSession = createPersistableWorkspaceSession(
        workspaceSessionRef.current
      );
      writeWorkspaceSessionBackup(getSessionScopeId(workspaceInfo.id), persistableSession);
      void saveWorkspaceSession(workspaceInfo.id, persistableSession, {
        keepalive: true,
        windowId,
      }).catch(() => {
        // Ignore flush failures.
      });
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
  }, [getSessionScopeId, sessionReady, windowId, workspaceInfo]);

  useEffect(() => {
    if (!activeWorkspaceId) {
      return;
    }

    let active = true;
    let openedAt = Date.now();
    /** Updated on every inbound message (not only `pong`) so chat/streaming stalls cannot skew pong-only liveness. */
    let lastServerContactAt: number | null = null;
    let startupDisconnectTimer: number | null = null;
    const suppressedDisconnectRef = { current: false };
    const wasDisconnectedRef = { current: false };
    const disconnectToastShownRef = { current: false };
    const pendingStartupDisconnectMessageRef = { current: null as string | null };
    let connectionLostHandled = false;

    const socket = new JsonWebSocket<FileWatcherEvent>(() => {
      const params = new URLSearchParams({ workspaceId: activeWorkspaceId });
      if (hasSyncedOnceRef.current && lastSeenSeqRef.current > 0) {
        params.set("since", String(lastSeenSeqRef.current));
      }
      return buildAuthenticatedUrl(
        `${toWebSocketUrl(getServerBaseUrl())}/ws/fs?${params.toString()}`
      );
    });

    function clearStartupDisconnectTimer() {
      if (startupDisconnectTimer != null) {
        window.clearTimeout(startupDisconnectTimer);
        startupDisconnectTimer = null;
      }
    }

    function clearPendingStartupDisconnect() {
      pendingStartupDisconnectMessageRef.current = null;
      clearStartupDisconnectTimer();
    }

    function shouldSuppressConnectionNotifications() {
      return Date.now() < connectionNotificationGraceEndsAtRef.current;
    }

    function showDisconnectToast(message: string) {
      if (!active || suppressedDisconnectRef.current) {
        disconnectToastShownRef.current = false;
        return;
      }

      disconnectToastShownRef.current = true;
      dismissByKindRef.current(WORKBENCH_NOTIFICATION_KIND.connectionReconnected);
      dismissByKindRef.current(WORKBENCH_NOTIFICATION_KIND.connectionDisconnected);
    pushNotificationRef.current({
      kind: WORKBENCH_NOTIFICATION_KIND.connectionDisconnected,
      severity: "error",
      title: "Disconnected",
      message,
      persistent: false,
      autoDismissMs: DISCONNECT_TOAST_MS,
      compact: true,
      onDismiss: () => {
        suppressedDisconnectRef.current = true;
      },
      actions: [
        {
          id: "retry",
          label: "Retry",
          primary: true,
          onClick: () => {
            void refreshTreeRef.current();
            socket.forceCloseConnection();
          },
        },
      ],
    });
    }

    function scheduleStartupDisconnectToast() {
      if (startupDisconnectTimer != null) {
        return;
      }

      const delay = Math.max(
        0,
        connectionNotificationGraceEndsAtRef.current - Date.now()
      );
      startupDisconnectTimer = window.setTimeout(() => {
        startupDisconnectTimer = null;
        const pendingMessage = pendingStartupDisconnectMessageRef.current;
        pendingStartupDisconnectMessageRef.current = null;
        if (!pendingMessage) {
          return;
        }
        if (!active || !wasDisconnectedRef.current || socket.connected) {
          disconnectToastShownRef.current = false;
          return;
        }
        showDisconnectToast(pendingMessage);
      }, delay);
    }

    function handleConnectionLost(message: string) {
      if (!active) return;
      if (connectionLostHandled) return;
      connectionLostHandled = true;
      wasDisconnectedRef.current = true;
      if (shouldSuppressConnectionNotifications()) {
        pendingStartupDisconnectMessageRef.current = message;
        disconnectToastShownRef.current = false;
        scheduleStartupDisconnectToast();
        return;
      }

      showDisconnectToast(message);
    }

    function tryReconnectToast() {
      if (!active) return;
      if (!wasDisconnectedRef.current) return;
      if (lastServerContactAt == null) return;
      if (Date.now() - lastServerContactAt > PONG_STALE_MS) return;
      if (!socket.connected) return;
      clearPendingStartupDisconnect();
      const shouldAnnounceReconnect = disconnectToastShownRef.current;
      wasDisconnectedRef.current = false;
      disconnectToastShownRef.current = false;
      suppressedDisconnectRef.current = false;
      if (!shouldAnnounceReconnect) {
        return;
      }
      dismissByKindRef.current(WORKBENCH_NOTIFICATION_KIND.connectionDisconnected);
      dismissByKindRef.current(WORKBENCH_NOTIFICATION_KIND.connectionReconnected);
  pushNotificationRef.current({
      kind: WORKBENCH_NOTIFICATION_KIND.connectionReconnected,
      severity: "info",
      title: "Reconnected",
      message: "Connection to the IDE backend was restored.",
      persistent: false,
      autoDismissMs: RECONNECT_TOAST_MS,
      compact: true,
    });
    }

    const unsubscribers = [
      socket.onState((state) =>
        setConnectionState(state as WorkspaceContextValue["connectionState"])
      ),
  socket.onOpen(() => {
    openedAt = Date.now();
    lastServerContactAt = null;
    connectionLostHandled = false;
    consecutiveStaleTicks = 0;
  }),
      socket.onMessage((event) => {
        lastServerContactAt = Date.now();

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
          void refreshTreeRef.current();
          return;
        }

        if (event.type === "pong") {
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

    const syncHeartbeatAfterForeground = () => {
      if (document.visibilityState !== "visible") return;
      // Background tabs throttle timers; without this, the first tick after focus can look
      // "stale" and force a reconnect + resync that feels like a full UI reload.
      openedAt = Date.now();
      lastServerContactAt = null;
      if (socket.connected) {
        socket.send({ type: "ping" });
      }
    };
    document.addEventListener("visibilitychange", syncHeartbeatAfterForeground);

let lastHeartbeatRunAt = Date.now();
  let consecutiveStaleTicks = 0;
  const heartbeat = window.setInterval(() => {
      if (!active) return;
      if (!socket.connected) return;
      if (document.visibilityState === "hidden") {
        return;
      }
      const now = Date.now();
      const drift = now - lastHeartbeatRunAt;
      lastHeartbeatRunAt = now;

    socket.send({ type: "ping" });
    if (drift > HEARTBEAT_DRIFT_SKIP_STALE_MS) {
      // Timer was delayed (often main-thread jank). The *next* tick would otherwise compare
      // wall clock to a pre-stall `lastServerContactAt` and falsely kill the socket.
      lastServerContactAt = Date.now();
      consecutiveStaleTicks = 0;
      return;
    }
    const stale =
      lastServerContactAt == null
      ? now - openedAt > PONG_STALE_MS
      : now - lastServerContactAt > PONG_STALE_MS;
    if (stale) {
      consecutiveStaleTicks++;
    } else {
      consecutiveStaleTicks = 0;
    }
    if (consecutiveStaleTicks >= STALE_TICK_THRESHOLD) {
      handleConnectionLost(
        "No response from the IDE backend. The connection may be stale."
      );
      socket.forceCloseConnection();
    }
    }, HEARTBEAT_INTERVAL_MS);

    socket.connect();

    return () => {
      active = false;
      document.removeEventListener("visibilitychange", syncHeartbeatAfterForeground);
      window.clearInterval(heartbeat);
      clearPendingStartupDisconnect();
      unsubscribers.forEach((unsubscribe) => unsubscribe());
      socket.disconnect();
    };
  }, [activeWorkspaceId]);

  const value = useMemo<WorkspaceContextValue>(
    () => ({
      workspaceInfo,
      activeWorkspaceId,
      activeWindowId: windowId,
      isDedicatedWindow,
      workspaces,
      workspaceWindows,
      gitStatus,
      gitStatusLoading,
      defaultWorkspaceId,
      recentWorkspaceIds,
      fileTree,
      loading,
      sessionReady,
      workspaceSession,
      updateWorkspaceSession,
      updateWorkspaceSessionNow,
      flushWorkspaceSessionNow,
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
      refreshGitStatus,
      switchBranch,
      createWorktree,
      deleteWorktree,
      markWorkspaceActivity,
      refreshWorkspaceWindows,
      createWorkspaceWindow: createPersistentWorkspaceWindow,
      updateWorkspaceWindow: updatePersistentWorkspaceWindow,
      createWorkspace,
      cloneWorkspaceFromGit: cloneWorkspaceFromGitHandler,
      deleteWorkspace,
      homeWorkspaceId,
      setDefaultWorkspace,
      createNewTerminal,
    }),
    [
      workspaceInfo,
      activeWorkspaceId,
      windowId,
      isDedicatedWindow,
      workspaces,
      workspaceWindows,
      gitStatus,
      gitStatusLoading,
      defaultWorkspaceId,
      recentWorkspaceIds,
      homeWorkspaceId,
      fileTree,
      loading,
      sessionReady,
      workspaceSession,
      updateWorkspaceSession,
      updateWorkspaceSessionNow,
      flushWorkspaceSessionNow,
      connectionState,
      lastFileChange,
      fsResyncToken,
      terminals,
      refreshTree,
      refreshTerminals,
      loadFolderChildren,
      openFolder,
      openWorkspaceById,
      refreshGitStatus,
      switchBranch,
      createWorktree,
      deleteWorktree,
      markWorkspaceActivity,
      refreshWorkspaceWindows,
      createPersistentWorkspaceWindow,
      updatePersistentWorkspaceWindow,
      createWorkspace,
      cloneWorkspaceFromGitHandler,
      deleteWorkspace,
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
