"use client";

import {
  useState,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  type KeyboardEvent,
  type MouseEvent,
} from "react";
import { Blocks, Files, GitBranch, Search, type LucideIcon } from "lucide-react";
import dynamic from "next/dynamic";
import { ExtensionIcon } from "@/components/extensions/ExtensionIcon";
import { HardwareAwareTextInput } from "@/components/input/HardwareAwareTextField";
import { useOpenInEditor } from "@/components/editor/OpenInEditorContext";
import { useEditorBridgeRef } from "@/components/ide/EditorBridgeContext";
import { useWorkbenchContextMenu } from "@/components/ide/WorkbenchContextMenuProvider";
import type { WorkbenchMenuItem } from "@/components/ide/workbench-context-menu-types";
import { VSCodeQuickInputShell } from "@/components/ide/VSCodeQuickInputShell";
import { useWorkbenchNotifications } from "@/components/notifications/WorkbenchNotificationProvider";
import { WORKBENCH_NOTIFICATION_KIND } from "@/components/notifications/workbench-notification-types";
import type { EditorTab, FileNode } from "@/lib/types";
import { joinPath, parentDir } from "@/lib/path-utils";
import {
  deletePath,
  mkdir,
  renamePath,
  uploadFile,
  writeFile,
  fetchInstalledExtensions,
  getServerBaseUrl,
  type ExtensionActivitySurfaceCapability,
  type ExtensionIconDescriptor,
  type ExtensionInstallRecord,
  type ExtensionSurfaceSession,
} from "@/lib/server-api";
import { FileTree, collectExpandableFolderPaths } from "./FileTree";
import { SidebarAppMenu } from "./SidebarAppMenu";
import { useUserPreferences } from "@/components/preferences/UserPreferencesProvider";
import { useWorkspace } from "@/contexts/WorkspaceContext";

type SidebarView = "explorer" | "search" | "scm" | "extensions";

type ExtensionActivityContainer = {
  id: string;
  title: string;
  icon: ExtensionIconDescriptor;
  iconUrl?: string;
  extension: ExtensionInstallRecord;
};

type SidebarExtensionSurface = {
  extensionId: string;
  surfaceId: string;
  title: string;
  kind: "view" | "webview";
  viewType?: string;
};

type FsPromptKind = "rename" | "newFile" | "newFolder";

function inferEditorIcon(node: FileNode): EditorTab["icon"] {
  const lower = node.name.toLowerCase();
  const language = node.language?.toLowerCase();
  if (language === "css" || lower.endsWith(".css")) return "css";
  if (language === "json" || lower.endsWith(".json")) return "json";
  if (language === "markdown" || lower.endsWith(".md")) return "markdown";
  if (
    language === "typescript" ||
    language === "javascript" ||
    lower.endsWith(".ts") ||
    lower.endsWith(".tsx") ||
    lower.endsWith(".js") ||
    lower.endsWith(".jsx")
  ) {
    return "typescript";
  }
  return "default";
}

function collectParentPaths(path: string | null): string[] {
  if (!path) return [];
  const segments = path.split("/").filter(Boolean);
  return segments.slice(0, -1).map((_, index) => segments.slice(0, index + 1).join("/"));
}

function findNodeAtPath(nodes: FileNode[] | undefined, targetPath: string): FileNode | null {
  const segments = targetPath.split("/").filter(Boolean);
  if (segments.length === 0) return null;

  let currentNodes = nodes;
  let currentNode: FileNode | null = null;
  for (const segment of segments) {
    currentNode = currentNodes?.find((node) => node.name === segment) ?? null;
    if (!currentNode) {
      return null;
    }
    currentNodes = currentNode.children;
  }

  return currentNode;
}

function samePathSet(current: Set<string>, next: string[]): boolean {
  if (current.size !== next.length) return false;
  for (const value of next) {
    if (!current.has(value)) return false;
  }
  return true;
}

function extensionResourceUrl(
  workspaceId: string,
  extensionId: string,
  resourcePath: string
): string {
  return `${getServerBaseUrl()}/api/workspaces/${encodeURIComponent(workspaceId)}/extensions/${encodeURIComponent(extensionId)}/resource?path=${encodeURIComponent(resourcePath)}`;
}

function getExtensionActivityContainers(
  extensions: ExtensionInstallRecord[],
  workspaceId: string | null
): ExtensionActivityContainer[] {
  if (!workspaceId) return [];
  const containers: ExtensionActivityContainer[] = [];
  for (const extension of extensions) {
    const surfaces = extension.manifest.capabilities?.activitySurfaces ?? [];
    const byContainer = new Map<string, ExtensionActivitySurfaceCapability>();
    for (const surface of surfaces) {
      if (surface.visibility !== "always") continue;
      if (surface.kind !== "activity.webviewView" && surface.kind !== "activity.treeView") continue;
      if (!byContainer.has(surface.containerId)) {
        byContainer.set(surface.containerId, surface);
      }
    }
    for (const surface of byContainer.values()) {
      containers.push({
        id: surface.containerId,
        title: surface.title || extension.displayName,
        icon: surface.icon,
        iconUrl: surface.icon.kind === "resource"
          ? extensionResourceUrl(workspaceId, extension.extensionId, surface.icon.path)
          : undefined,
        extension,
      });
    }
  }
  return containers;
}

function getExtensionViewEntries(extension: ExtensionInstallRecord): SidebarExtensionSurface[] {
  const normalized = extension.manifest.capabilities?.activitySurfaces;
  if (normalized?.length) {
    return normalized
      .filter((surface) => surface.visibility === "always")
      .map((surface) => ({
        extensionId: extension.extensionId,
        surfaceId: surface.surfaceId,
        title: surface.title || extension.displayName,
        viewType: surface.containerId,
        kind: surface.kind === "activity.webviewView" ? "webview" : "view",
      }));
  }
  const contributes = extension.manifest.raw.contributes;
  const views =
    contributes && typeof contributes === "object" && "views" in contributes
      ? (contributes as { views?: unknown }).views
      : undefined;
  const entries: SidebarExtensionSurface[] = [];
  if (!views || typeof views !== "object") return entries;
  for (const [containerId, viewList] of Object.entries(views as Record<string, unknown>)) {
    if (!Array.isArray(viewList)) continue;
    for (const contributedView of viewList) {
      if (!contributedView || typeof contributedView !== "object") continue;
      const id = (contributedView as { id?: unknown }).id;
      const name = (contributedView as { name?: unknown }).name;
      const type = (contributedView as { type?: unknown }).type;
      if (typeof id !== "string" || !id.trim()) continue;
      entries.push({
        extensionId: extension.extensionId,
        surfaceId: id,
        title: typeof name === "string" && name.trim() ? name : extension.displayName,
        viewType: containerId,
        kind: type === "webview" ? "webview" : "view",
      });
    }
  }
  return entries;
}

// A static import of ExtensionSurfaceView here would drag the whole extension
// surface module (and the settings panel tree it pulls) into the main chunk,
// defeating EditorPanel's dynamic import of the same module.
const ExtensionSurfaceFrame = dynamic(
  () => import("@/components/editor/ExtensionSurfaceView").then((m) => m.ExtensionSurfaceFrame),
  { ssr: false }
);

export function FileExplorer() {
  const { openExplorerFile, activeExplorerPath } = useOpenInEditor();
  const bridgeRef = useEditorBridgeRef();
  const { openAt, openAtPoint } = useWorkbenchContextMenu();
  const { experimentalIpadCustomButtons, vscodeExtensionsBeta } = useUserPreferences();
  const { pushNotification, dismiss } = useWorkbenchNotifications();
  const {
    activeWorkspaceId,
    fileTree,
    workspaceInfo,
    loading,
    sessionReady,
    loadFolderChildren,
    refreshTree,
    workspaceSession,
    updateWorkspaceSession,
  } = useWorkspace();
  const [view, setView] = useState<SidebarView>(workspaceSession.explorer.view);
  const [searchQuery, setSearchQuery] = useState(workspaceSession.explorer.searchQuery);
  const [expandedPaths, setExpandedPaths] = useState<Set<string>>(
    () => new Set(workspaceSession.explorer.expandedPaths)
  );
  const pendingRevealLoadsRef = useRef(new Set<string>());
  const lastSessionSyncKeyRef = useRef<string | null>(null);
  const uploadInputRef = useRef<HTMLInputElement>(null);
  const uploadFolderRef = useRef<string>("");
  const scrollRootRef = useRef<HTMLDivElement>(null);

  const [fsPrompt, setFsPrompt] = useState<{
    kind: FsPromptKind;
    /** rename: full file path; new*: parent folder path */
    path: string;
    initialValue: string;
  } | null>(null);
  const [fsPromptValue, setFsPromptValue] = useState("");
  const [installedExtensions, setInstalledExtensions] = useState<ExtensionInstallRecord[]>([]);
  const [selectedExtensionContainerId, setSelectedExtensionContainerId] = useState<string | null>(null);
  const [activeSidebarExtensionSurface, setActiveSidebarExtensionSurface] =
    useState<SidebarExtensionSurface | null>(null);

  const expandablePaths = useMemo(
    () => new Set(collectExpandableFolderPaths(fileTree?.children, "")),
    [fileTree]
  );
  const visibleExpandedPaths = useMemo(
    () => new Set([...expandedPaths].filter((path) => expandablePaths.has(path))),
    [expandedPaths, expandablePaths]
  );
  const [explorerFade, setExplorerFade] = useState({ top: false, bottom: false });
  const explorerFadeRef = useRef(explorerFade);
  const extensionActivityContainers = useMemo(
    () => getExtensionActivityContainers(installedExtensions, activeWorkspaceId),
    [activeWorkspaceId, installedExtensions]
  );
  const selectedExtensionContainer = useMemo(
    () =>
      selectedExtensionContainerId
        ? extensionActivityContainers.find((container) => container.id === selectedExtensionContainerId) ?? null
        : null,
    [extensionActivityContainers, selectedExtensionContainerId]
  );
  const selectedExtensionSurfaces = useMemo(() => {
    if (!selectedExtensionContainerId || !selectedExtensionContainer) return [];
    const entries = getExtensionViewEntries(selectedExtensionContainer.extension);
    const exact = entries
      .filter((surface) => surface.viewType === selectedExtensionContainerId);
    return exact.length > 0 ? exact : entries;
  }, [selectedExtensionContainer, selectedExtensionContainerId]);
  const activeSidebarFrameSurface = useMemo(() => {
    if (!activeSidebarExtensionSurface) return null;
    return {
      kind: activeSidebarExtensionSurface.kind,
      extensionId: activeSidebarExtensionSurface.extensionId,
      surfaceId: activeSidebarExtensionSurface.surfaceId,
      title: activeSidebarExtensionSurface.title,
      viewType: activeSidebarExtensionSurface.viewType,
      placement: "sidebar" as const,
    };
  }, [activeSidebarExtensionSurface]);

  const updateExplorerFade = useCallback(() => {
    const root = scrollRootRef.current;
    if (!root) {
      return;
    }
    const maxScrollY = root.scrollHeight - root.clientHeight;
    const next = {
      top: root.scrollTop > 2,
      bottom: maxScrollY > 2 && root.scrollTop < maxScrollY - 2,
    };
    const current = explorerFadeRef.current;
    if (current.top === next.top && current.bottom === next.bottom) {
      return;
    }
    explorerFadeRef.current = next;
    setExplorerFade(next);
  }, []);

  useEffect(() => {
    explorerFadeRef.current = explorerFade;
  }, [explorerFade]);

  const setSidebarView = useCallback(
    (nextView: SidebarView) => {
      setView(nextView);
      updateWorkspaceSession((current) => {
        if (current.explorer.view === nextView) {
          return current;
        }
        return {
          ...current,
          explorer: {
            ...current.explorer,
            view: nextView,
          },
        };
      });
    },
    [updateWorkspaceSession]
  );

  useEffect(() => {
    const syncKey = `${activeWorkspaceId ?? "none"}:${sessionReady ? "ready" : "loading"}`;
    if (lastSessionSyncKeyRef.current === syncKey) {
      return;
    }
    lastSessionSyncKeyRef.current = syncKey;
    setView(workspaceSession.explorer.view);
    setSearchQuery(workspaceSession.explorer.searchQuery);
    setExpandedPaths((current) =>
      samePathSet(current, workspaceSession.explorer.expandedPaths)
        ? current
        : new Set(workspaceSession.explorer.expandedPaths)
    );
  }, [
    activeWorkspaceId,
    sessionReady,
    workspaceSession.explorer.expandedPaths,
    workspaceSession.explorer.searchQuery,
    workspaceSession.explorer.view,
  ]);

  useEffect(() => {
    if (!vscodeExtensionsBeta && view === "extensions") {
      setSidebarView("explorer");
    }
  }, [setSidebarView, view, vscodeExtensionsBeta]);

  useEffect(() => {
    if (!vscodeExtensionsBeta || !activeWorkspaceId) {
      setInstalledExtensions([]);
      setSelectedExtensionContainerId(null);
      return;
    }
    let cancelled = false;
    fetchInstalledExtensions(activeWorkspaceId)
      .then(({ extensions }) => {
        if (!cancelled) {
          setInstalledExtensions(extensions.filter((extension) => extension.enabled));
        }
      })
      .catch(() => {
        if (!cancelled) setInstalledExtensions([]);
      });
    return () => {
      cancelled = true;
    };
  }, [activeWorkspaceId, vscodeExtensionsBeta]);

  useEffect(() => {
    if (
      selectedExtensionContainerId &&
      !extensionActivityContainers.some((container) => container.id === selectedExtensionContainerId)
    ) {
      setSelectedExtensionContainerId(null);
    }
  }, [extensionActivityContainers, selectedExtensionContainerId]);

  useEffect(() => {
    if (!selectedExtensionContainerId) {
      setActiveSidebarExtensionSurface(null);
      return;
    }
    if (
      activeSidebarExtensionSurface &&
      activeSidebarExtensionSurface.viewType === selectedExtensionContainerId &&
      selectedExtensionSurfaces.some(
        (surface) =>
          surface.extensionId === activeSidebarExtensionSurface.extensionId &&
          surface.surfaceId === activeSidebarExtensionSurface.surfaceId
      )
    ) {
      return;
    }
    setActiveSidebarExtensionSurface(selectedExtensionSurfaces[0] ?? null);
  }, [
    activeSidebarExtensionSurface,
    selectedExtensionContainerId,
    selectedExtensionSurfaces,
  ]);

  useEffect(() => {
    const nextExpanded = [...expandedPaths];
    updateWorkspaceSession((current) => {
      const explorer = current.explorer;
      const sameExpanded =
        explorer.expandedPaths.length === nextExpanded.length &&
        explorer.expandedPaths.every((path, index) => path === nextExpanded[index]);
      if (
        explorer.view === view &&
        explorer.searchQuery === searchQuery &&
        sameExpanded
      ) {
        return current;
      }
      return {
        ...current,
        explorer: {
          ...explorer,
          view,
          searchQuery,
          expandedPaths: nextExpanded,
        },
      };
    });
  }, [expandedPaths, searchQuery, updateWorkspaceSession, view]);

  useEffect(() => {
    const root = scrollRootRef.current;
    if (!root) return;
    if (root.scrollTop !== workspaceSession.explorer.scrollTop) {
      root.scrollTop = workspaceSession.explorer.scrollTop;
    }
    requestAnimationFrame(updateExplorerFade);
  }, [updateExplorerFade, workspaceSession.explorer.scrollTop]);

  useLayoutEffect(() => {
    if (view !== "explorer") {
      return;
    }
    updateExplorerFade();
  }, [fileTree, loading, updateExplorerFade, view, visibleExpandedPaths]);

  useLayoutEffect(() => {
    if (view !== "explorer") {
      return;
    }
    const root = scrollRootRef.current;
    if (!root) {
      return;
    }
    const ro = new ResizeObserver(() => updateExplorerFade());
    ro.observe(root);
    return () => ro.disconnect();
  }, [updateExplorerFade, view]);

  const flashError = useCallback(
  (message: string) => {
    pushNotification({
      kind: WORKBENCH_NOTIFICATION_KIND.editorNotice,
      severity: "error",
      title: "Files",
      message,
      persistent: false,
      autoDismissMs: 8000,
      compact: true,
    });
  },
  [pushNotification]
  );

  const handleOpenFile = useCallback(
    (path: string, node: FileNode) => {
      openExplorerFile({
        path,
        name: node.name,
        language: node.language ?? "plaintext",
        icon: inferEditorIcon(node),
      });
    },
    [openExplorerFile]
  );

  const openFileToSide = useCallback(
    (path: string, node: FileNode) => {
      const bridge = bridgeRef.current;
      if (!bridge) {
        handleOpenFile(path, node);
        return;
      }
      const s = bridge.getState();
      if (!s.split) {
        bridge.dispatch({
          type: "ENABLE_SPLIT",
          orientation: "horizontal",
          focus: "right",
        });
      } else {
        bridge.dispatch({ type: "ENABLE_SPLIT", orientation: "horizontal", focus: "right" });
      }
      openExplorerFile({
        path,
        name: node.name,
        language: node.language ?? "plaintext",
        icon: inferEditorIcon(node),
      });
    },
    [bridgeRef, handleOpenFile, openExplorerFile]
  );

  const copyText = useCallback(async (text: string) => {
    try {
      await navigator.clipboard.writeText(text);
    } catch {
      flashError("Could not copy to clipboard.");
    }
  }, [flashError]);

  const runRefresh = useCallback(async () => {
    try {
      await refreshTree();
    } catch (e) {
      flashError(e instanceof Error ? e.message : "Refresh failed.");
    }
  }, [flashError, refreshTree]);

  const confirmDelete = useCallback(
    (label: string, relativePath: string) => {
    const nid = pushNotification({
      kind: WORKBENCH_NOTIFICATION_KIND.editorNotice,
      severity: "warning",
      title: "Delete permanently?",
      message: label,
      persistent: true,
      compact: true,
      actions: [
          {
            id: "del",
            label: "Delete",
            primary: true,
            onClick: () => {
              dismiss(nid);
              void (async () => {
                try {
                  await deletePath(relativePath);
                  await refreshTree();
                } catch (e) {
                  flashError(e instanceof Error ? e.message : "Delete failed.");
                }
              })();
            },
          },
          {
            id: "cancel",
            label: "Cancel",
            onClick: () => dismiss(nid),
          },
        ],
      });
    },
    [dismiss, flashError, pushNotification, refreshTree]
  );

  const triggerUpload = useCallback((folderRelativePath: string) => {
    uploadFolderRef.current = folderRelativePath;
    uploadInputRef.current?.click();
  }, []);

  const onUploadInputChange = useCallback(
    async (e: React.ChangeEvent<HTMLInputElement>) => {
      const files = e.target.files;
      e.target.value = "";
      if (!files?.length) return;
      const base = uploadFolderRef.current;
      try {
        for (const f of Array.from(files)) {
          const rel = joinPath(base, f.name);
          await uploadFile(rel, f);
        }
        await refreshTree();
      } catch (err) {
        flashError(err instanceof Error ? err.message : "Upload failed.");
      }
    },
    [flashError, refreshTree]
  );

  const submitFsPrompt = useCallback(async () => {
    if (!fsPrompt) return;
    const v = fsPromptValue.trim();
    if (!v) {
      setFsPrompt(null);
      return;
    }
    const { kind, path: ctxPath } = fsPrompt;
    setFsPrompt(null);
    setFsPromptValue("");
    try {
      if (kind === "rename") {
        const nextPath = joinPath(parentDir(ctxPath), v);
        await renamePath(ctxPath, nextPath);
      } else if (kind === "newFile") {
        await writeFile(joinPath(ctxPath, v), "");
      } else {
        await mkdir(joinPath(ctxPath, v));
      }
      await refreshTree();
      if (kind === "newFile") {
        openExplorerFile({
          path: joinPath(ctxPath, v),
          name: v,
          language: "plaintext",
          icon: inferEditorIcon({ name: v, type: "file" } as FileNode),
        });
      }
      if (kind === "newFile" || kind === "newFolder") {
        setExpandedPaths((prev) => new Set(prev).add(ctxPath));
      }
    } catch (e) {
      flashError(e instanceof Error ? e.message : "Operation failed.");
    }
  }, [fsPrompt, fsPromptValue, flashError, openExplorerFile, refreshTree]);

  const buildExplorerRootMenu = useCallback((): WorkbenchMenuItem[] => {
    return [
      {
        type: "item",
        id: "new-file",
        label: "New File",
        onSelect: () => {
          setFsPromptValue("");
          setFsPrompt({ kind: "newFile", path: "", initialValue: "" });
        },
      },
      {
        type: "item",
        id: "new-folder",
        label: "New Folder",
        onSelect: () => {
          setFsPromptValue("");
          setFsPrompt({ kind: "newFolder", path: "", initialValue: "" });
        },
      },
      {
        type: "item",
        id: "upload",
        label: "Upload…",
        onSelect: () => triggerUpload(""),
      },
      { type: "sep" },
      {
        type: "item",
        id: "refresh",
        label: "Refresh Explorer",
        onSelect: () => void runRefresh(),
      },
      {
        type: "item",
        id: "collapse",
        label: "Collapse All Folders",
        onSelect: () => setExpandedPaths(new Set()),
      },
    ];
  }, [runRefresh, triggerUpload]);

  const buildTreeMenu = useCallback(
    (path: string, node: FileNode): WorkbenchMenuItem[] => {
      const isFolder = node.type === "folder";
      const root = workspaceInfo?.root ?? "";
      const fullPath =
        root && path ? `${root.replace(/\\/g, "/")}/${path}` : path;

      if (isFolder) {
        return [
          {
            type: "item",
            id: "new-file",
            label: "New File",
            onSelect: () => {
              setFsPromptValue("");
              setFsPrompt({ kind: "newFile", path, initialValue: "" });
            },
          },
          {
            type: "item",
            id: "new-folder",
            label: "New Folder",
            onSelect: () => {
              setFsPromptValue("");
              setFsPrompt({ kind: "newFolder", path, initialValue: "" });
            },
          },
          {
            type: "item",
            id: "upload",
            label: "Upload…",
            onSelect: () => triggerUpload(path),
          },
          { type: "sep" },
          {
            type: "item",
            id: "refresh",
            label: "Refresh",
            onSelect: () => void runRefresh(),
          },
          {
            type: "item",
            id: "rename",
            label: "Rename…",
            onSelect: () => {
              setFsPromptValue(node.name);
              setFsPrompt({ kind: "rename", path, initialValue: node.name });
            },
          },
          {
            type: "item",
            id: "delete",
            label: "Delete",
            onSelect: () =>
              confirmDelete(`Delete folder "${node.name}" and its contents?`, path),
          },
          { type: "sep" },
          {
            type: "item",
            id: "copy-rel",
            label: "Copy Relative Path",
            onSelect: () => void copyText(path),
          },
          {
            type: "item",
            id: "copy-full",
            label: "Copy Path",
            onSelect: () => void copyText(fullPath),
          },
        ];
      }

      return [
        {
          type: "item",
          id: "open",
          label: "Open",
          onSelect: () => handleOpenFile(path, node),
        },
        {
          type: "item",
          id: "open-side",
          label: "Open to the Side",
          onSelect: () => openFileToSide(path, node),
        },
        { type: "sep" },
        {
          type: "item",
          id: "rename",
          label: "Rename…",
          onSelect: () => {
            setFsPromptValue(node.name);
            setFsPrompt({ kind: "rename", path, initialValue: node.name });
          },
        },
        {
          type: "item",
          id: "delete",
          label: "Delete",
          onSelect: () =>
            confirmDelete(`Delete file "${node.name}"?`, path),
        },
        { type: "sep" },
        {
          type: "item",
          id: "copy-rel",
          label: "Copy Relative Path",
          onSelect: () => void copyText(path),
        },
        {
          type: "item",
          id: "copy-full",
          label: "Copy Path",
          onSelect: () => void copyText(fullPath),
        },
      ];
    },
    [
      confirmDelete,
      copyText,
      handleOpenFile,
      openFileToSide,
      runRefresh,
      triggerUpload,
      workspaceInfo?.root,
    ]
  );

  const onTreeContextMenu = useCallback(
    (e: MouseEvent, path: string, node: FileNode) => {
      openAt(e, buildTreeMenu(path, node));
    },
    [buildTreeMenu, openAt]
  );

  const onTreeOverflowMenu = useCallback(
    (path: string, node: FileNode, anchorEl: HTMLElement) => {
      const rect = anchorEl.getBoundingClientRect();
      openAtPoint(rect.right - 8, rect.bottom + 4, buildTreeMenu(path, node));
    },
    [buildTreeMenu, openAtPoint]
  );

  const toggleFolder = useCallback(async (path: string, node: FileNode) => {
    if (node.type !== "folder") {
      return;
    }

    const isOpening = !expandedPaths.has(path);
    if (isOpening && node.childrenLoaded === false) {
      try {
        await loadFolderChildren(path);
      } catch {
        return;
      }
    }

    setExpandedPaths((prev) => {
      const next = new Set(prev);
      if (next.has(path)) {
        next.delete(path);
      } else {
        next.add(path);
      }
      return next;
    });
  }, [expandedPaths, loadFolderChildren]);

  useEffect(() => {
    const parentPaths = collectParentPaths(activeExplorerPath);
    if (parentPaths.length === 0) {
      return;
    }

    setExpandedPaths((prev) => {
      let changed = false;
      const next = new Set(prev);
      for (const parentPath of parentPaths) {
        if (!next.has(parentPath)) {
          next.add(parentPath);
          changed = true;
        }
      }
      return changed ? next : prev;
    });

    const nextUnloadedParent = parentPaths.find((parentPath) => {
      const node = findNodeAtPath(fileTree?.children, parentPath);
      return node?.type === "folder" && node.childrenLoaded === false;
    });

    if (!nextUnloadedParent || pendingRevealLoadsRef.current.has(nextUnloadedParent)) {
      return;
    }

    pendingRevealLoadsRef.current.add(nextUnloadedParent);
    void loadFolderChildren(nextUnloadedParent).finally(() => {
      pendingRevealLoadsRef.current.delete(nextUnloadedParent);
    });
  }, [activeExplorerPath, fileTree, loadFolderChildren]);

  const onExplorerBackgroundContextMenu = useCallback(
    (e: MouseEvent) => {
      if (e.target !== e.currentTarget) return;
      e.preventDefault();
      openAt(e, buildExplorerRootMenu());
    },
    [buildExplorerRootMenu, openAt]
  );

  const fsPromptTitle =
    fsPrompt?.kind === "rename"
      ? "Rename"
      : fsPrompt?.kind === "newFile"
        ? "New File"
        : "New Folder";

  return (
    <div className="flex h-full min-w-0 flex-col bg-[var(--bg-panel)]">
      <input
        ref={uploadInputRef}
        type="file"
        className="sr-only"
        aria-hidden
        multiple
        onChange={onUploadInputChange}
      />

      <VSCodeQuickInputShell
        open={fsPrompt !== null}
        onClose={() => {
          setFsPrompt(null);
          setFsPromptValue("");
        }}
        screenReaderTitle={fsPromptTitle}
        inputLabel={fsPromptTitle}
        placeholder={
          fsPrompt?.kind === "rename"
            ? "New name"
            : fsPrompt?.kind === "newFile"
              ? "file name"
              : "folder name"
        }
        value={fsPromptValue}
        onChange={setFsPromptValue}
        onKeyDown={(e: KeyboardEvent<HTMLInputElement>) => {
          if (e.key === "Escape") {
            e.preventDefault();
            setFsPrompt(null);
            setFsPromptValue("");
          }
          if (e.key === "Enter") {
            e.preventDefault();
            void submitFsPrompt();
          }
        }}
      >
        <div className="border-t border-[var(--palette-divider)] px-[10px] py-[8px] font-sans text-[12px] text-[var(--palette-footer-text)]">
          {fsPrompt?.kind === "rename"
            ? "Renames the file or folder in the workspace."
            : fsPrompt?.kind === "newFile"
              ? "Creates a new file under the selected folder (or workspace root)."
              : "Creates a new folder under the selected path (or workspace root)."}
        </div>
      </VSCodeQuickInputShell>

      <div
        className="flex w-full shrink-0 justify-center px-[11px] py-[4px]"
        onContextMenu={(e) => {
          if (e.target !== e.currentTarget) return;
          e.preventDefault();
          openAt(e, [
            {
              type: "item",
              id: "v-ex",
              label: "Show Explorer",
              onSelect: () => setSidebarView("explorer"),
            },
            {
              type: "item",
              id: "v-search",
              label: "Show Search",
              onSelect: () => setSidebarView("search"),
            },
            {
              type: "item",
              id: "v-scm",
              label: "Show Source Control",
              onSelect: () => setSidebarView("scm"),
            },
            { type: "sep" },
            {
              type: "item",
              id: "refresh-ex",
              label: "Refresh Explorer",
              onSelect: () => void runRefresh(),
            },
          ]);
        }}
      >
        <div className="flex shrink-0 items-center gap-[4px]">
          <SidebarAppMenu />
          <div
            className="flex shrink-0 items-center gap-[2px]"
            role="tablist"
            aria-label="Sidebar views"
          >
            <ActivityButton
              active={view === "explorer"}
              onClick={() => setSidebarView("explorer")}
              label="Explorer"
              icon={Files}
              onContextMenu={(e) => {
                e.stopPropagation();
                openAt(e, [
                  {
                    type: "item",
                    id: "focus-ex",
                    label: "Focus Explorer",
                    onSelect: () => setSidebarView("explorer"),
                  },
                ]);
              }}
            />
            <ActivityButton
              active={view === "search"}
              onClick={() => setSidebarView("search")}
              label="Search"
              icon={Search}
              onContextMenu={(e) => {
                e.stopPropagation();
                openAt(e, [
                  {
                    type: "item",
                    id: "focus-search",
                    label: "Focus Search",
                    onSelect: () => setSidebarView("search"),
                  },
                ]);
              }}
            />
            <ActivityButton
              active={view === "scm"}
              onClick={() => setSidebarView("scm")}
              label="Source Control"
              icon={GitBranch}
              onContextMenu={(e) => {
                e.stopPropagation();
                openAt(e, [
                  {
                    type: "item",
                    id: "focus-scm",
                    label: "Focus Source Control",
                    onSelect: () => setSidebarView("scm"),
                  },
                ]);
              }}
            />
            {vscodeExtensionsBeta ? (
              <>
                <ActivityButton
                  active={view === "extensions" && !selectedExtensionContainerId}
                  onClick={() => {
                    setSelectedExtensionContainerId(null);
                    setActiveSidebarExtensionSurface(null);
                    setSidebarView("extensions");
                  }}
                  label="Extensions"
                  icon={Blocks}
                  onContextMenu={(e) => {
                    e.stopPropagation();
                    openAt(e, [
                      {
                        type: "item",
                        id: "focus-extensions",
                        label: "Focus Extensions",
                        onSelect: () => {
                          setSelectedExtensionContainerId(null);
                          setActiveSidebarExtensionSurface(null);
                          setSidebarView("extensions");
                        },
                      },
                    ]);
                  }}
                />
                {extensionActivityContainers.map((container) => (
                  <ExtensionActivityButton
                    key={`${container.extension.extensionId}:${container.id}`}
                    active={view === "extensions" && selectedExtensionContainerId === container.id}
                    label={container.title}
                    icon={container.icon}
                    iconUrl={container.iconUrl}
                    onClick={() => {
                      const entries = getExtensionViewEntries(container.extension);
                      const exact = entries.filter((surface) => surface.viewType === container.id);
                      setSelectedExtensionContainerId(container.id);
                      setActiveSidebarExtensionSurface(exact[0] ?? entries[0] ?? null);
                      setSidebarView("extensions");
                    }}
                    onContextMenu={(e) => {
                      e.stopPropagation();
                      openAt(e, [
                        {
                          type: "item",
                          id: `focus-${container.id}`,
                          label: `Focus ${container.title}`,
                          onSelect: () => {
                            const entries = getExtensionViewEntries(container.extension);
                            const exact = entries.filter((surface) => surface.viewType === container.id);
                            setSelectedExtensionContainerId(container.id);
                            setActiveSidebarExtensionSurface(exact[0] ?? entries[0] ?? null);
                            setSidebarView("extensions");
                          },
                        },
                      ]);
                    }}
                  />
                ))}
              </>
            ) : null}
          </div>
        </div>
      </div>

      <div className="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden">
        {view === "explorer" && (
          <>
            <p className="pointer-events-none shrink-0 px-[11px] pb-[5px] pt-[6px] font-sans text-[14px] font-normal text-[var(--text-primary)]">
              {workspaceInfo?.name ?? "Workspace"}
            </p>
            <div className="relative min-h-0 min-w-0 flex-1">
              {explorerFade.top ? (
                <div
                  className="pointer-events-none absolute inset-x-0 top-0 z-[2] h-[24px]"
                  style={{
                    backgroundImage: "linear-gradient(to bottom, var(--bg-panel), transparent)",
                  }}
                  aria-hidden
                />
              ) : null}
              {explorerFade.bottom ? (
                <div
                  className="pointer-events-none absolute inset-x-0 bottom-0 z-[2] h-[24px]"
                  style={{
                    backgroundImage: "linear-gradient(to top, var(--bg-panel), transparent)",
                  }}
                  aria-hidden
                />
              ) : null}
              <div
                ref={scrollRootRef}
                className="hide-scrollbar-y h-full min-h-0 overflow-y-auto"
                onScroll={(event) => {
                  updateExplorerFade();
                  const nextScrollTop = event.currentTarget.scrollTop;
                  updateWorkspaceSession((current) =>
                    current.explorer.scrollTop === nextScrollTop
                      ? current
                      : {
                          ...current,
                          explorer: {
                            ...current.explorer,
                            scrollTop: nextScrollTop,
                          },
                        }
                  );
                }}
              >
                <div
                  className="min-h-full"
                  onContextMenu={onExplorerBackgroundContextMenu}
                >
                  {loading ? (
                    <div className="space-y-[6px] px-[11px] py-[8px]">
                      {Array.from({ length: 8 }).map((_, index) => (
                        <div
                          key={index}
                          className="h-[20px] rounded-[var(--radius-tab)] bg-[var(--bg-card)] opacity-70"
                        />
                      ))}
                    </div>
                  ) : (
                    fileTree?.children?.map((node) => (
                      <FileTree
                        key={node.name}
                        node={node}
                        depth={0}
                        parentPath=""
                        activePath={activeExplorerPath}
                        expandedPaths={visibleExpandedPaths}
                        onToggleFolder={toggleFolder}
                        onOpenFile={handleOpenFile}
                        onTreeContextMenu={onTreeContextMenu}
                        showOverflowMenu={experimentalIpadCustomButtons}
                        onTreeOverflowMenu={onTreeOverflowMenu}
                      />
                    ))
                  )}
                </div>
              </div>
            </div>
          </>
        )}

        {view === "search" && (
          <div
            data-ide-input-sink
            className="flex min-h-0 flex-1 flex-col px-[11px] pb-[11px] pt-[6px]"
            onContextMenu={(e) => {
              openAt(e, [
                {
                  type: "item",
                  id: "clear",
                  label: "Clear search",
                  disabled: !searchQuery,
                  onSelect: () => setSearchQuery(""),
                },
                {
                  type: "item",
                  id: "copy",
                  label: "Copy query",
                  disabled: !searchQuery,
                  onSelect: () => void copyText(searchQuery),
                },
              ]);
            }}
          >
            <div className="flex shrink-0 items-center gap-[6px] rounded-[var(--radius-tab)] border border-[var(--border-card)] bg-[var(--bg-main)] px-[8px] py-[5px]">
              <Search className="size-[14px] shrink-0 text-[var(--text-disabled)]" strokeWidth={1.5} />
              <HardwareAwareTextInput
                type="search"
                value={searchQuery}
                onChange={setSearchQuery}
                placeholder="Search"
                className="min-w-0 flex-1 bg-transparent font-sans text-[13px] text-[var(--text-primary)] outline-none placeholder:text-[var(--text-disabled)]"
                ariaLabel="Search files"
              />
            </div>
            <p className="mt-[14px] font-sans text-[12px] text-[var(--text-disabled)]">
              Type to search across files. Results will appear here.
            </p>
          </div>
        )}

        {view === "scm" && (
          <div
            className="flex min-h-0 flex-1 flex-col px-[11px] pb-[11px] pt-[6px]"
            onContextMenu={(e) => {
              openAt(e, [
                {
                  type: "item",
                  id: "refresh-scm",
                  label: "Refresh",
                  onSelect: () => void runRefresh(),
                },
              ]);
            }}
          >
            <div className="rounded-[var(--radius-tab)] border border-[var(--border-subtle)] bg-[var(--bg-main)] px-[10px] py-[8px]">
              <p className="font-sans text-[12px] text-[var(--text-secondary)]">
                <span className="text-[var(--text-primary)]">main</span>
                <span className="mx-[6px] text-[var(--text-disabled)]">·</span>
                <span className="text-[var(--text-disabled)]">No changes</span>
              </p>
            </div>
            <p className="mt-[12px] font-sans text-[12px] leading-relaxed text-[var(--text-disabled)]">
              Commit, branch, and diff views would appear here—same layout as VS Code’s SCM sidebar.
            </p>
          </div>
        )}

        {vscodeExtensionsBeta && (
          <div
            className={[
              "min-h-0 flex-1 flex-col px-[11px] pb-[11px] pt-[6px]",
              view === "extensions" ? "flex" : "hidden",
            ].join(" ")}
          >
            <div className="flex shrink-0 items-center justify-between gap-[8px]">
              <p className="min-w-0 truncate font-sans text-[14px] font-normal text-[var(--text-primary)]">
                {selectedExtensionContainerId
                  ? selectedExtensionContainer?.title ?? "Extension"
                  : "Extensions"}
              </p>
            </div>
            {selectedExtensionContainerId && activeSidebarExtensionSurface ? (
              <div className="mt-[8px] flex min-h-0 flex-1 flex-col overflow-hidden rounded-[var(--radius-card)] border border-[var(--border-subtle)] bg-[var(--bg-main)]">
                {selectedExtensionSurfaces.length > 1 ? (
                  <div className="flex shrink-0 gap-[4px] overflow-x-auto border-b border-[var(--border-subtle)] px-[7px] py-[6px]">
                    {selectedExtensionSurfaces.map((surface) => {
                      const active =
                        surface.extensionId === activeSidebarExtensionSurface.extensionId &&
                        surface.surfaceId === activeSidebarExtensionSurface.surfaceId;
                      return (
                        <button
                          key={`${surface.extensionId}:${surface.surfaceId}`}
                          type="button"
                          className={[
                            "shrink-0 rounded-[var(--radius-tab)] px-[7px] py-[4px] font-sans text-[11px] transition-colors",
                            active
                              ? "bg-[var(--accent-bg)] text-[var(--text-primary)]"
                              : "text-[var(--text-secondary)] hover:bg-[var(--bg-panel)] hover:text-[var(--text-primary)]",
                          ].join(" ")}
                          onClick={() => setActiveSidebarExtensionSurface(surface)}
                        >
                          {surface.title}
                        </button>
                      );
                    })}
                  </div>
                ) : null}
                <div className="min-h-0 flex-1">
                  {activeSidebarFrameSurface ? (
                  <ExtensionSurfaceFrame
                    surface={activeSidebarFrameSurface}
                    placement="sidebar"
                    showPopOut
                    onPopOut={(session: ExtensionSurfaceSession | null) => {
                      bridgeRef.current?.openExtensionSurfaceTab({
                        extensionId: activeSidebarExtensionSurface.extensionId,
                        surfaceId: activeSidebarExtensionSurface.surfaceId,
                        title: activeSidebarExtensionSurface.title,
                        surfaceKind: activeSidebarExtensionSurface.kind,
                        viewType: activeSidebarExtensionSurface.viewType,
                        surfaceSessionId: session?.sessionId,
                        placement: "editor",
                      });
                    }}
                  />
                  ) : null}
                </div>
              </div>
            ) : !selectedExtensionContainerId ? (
              <div className="mt-[10px] rounded-[var(--radius-card)] border border-[var(--border-card)] bg-[var(--bg-panel)] px-[10px] py-[10px]">
                <p className="font-sans text-[12px] leading-snug text-[var(--text-secondary)]">
                  Search Open VSX, install extensions, and manage installed extensions.
                </p>
                <button
                  type="button"
                  className="mt-[10px] inline-flex items-center gap-[6px] rounded-[var(--radius-tab)] border border-[var(--border-card)] px-[9px] py-[5px] font-sans text-[12px] text-[var(--text-primary)] transition-colors hover:bg-[var(--accent-bg)]"
                  onClick={() => {
                    bridgeRef.current?.openExtensionSurfaceTab({
                      extensionId: "opencursor.marketplace",
                      surfaceId: "sidebar-marketplace",
                      title: "Extension Marketplace",
                      surfaceKind: "marketplace",
                      placement: "editor",
                    });
                  }}
                >
                  Open marketplace tab
                </button>
              </div>
            ) : (
              <p className="mt-[10px] rounded-[var(--radius-card)] border border-[var(--border-subtle)] px-[10px] py-[8px] font-sans text-[12px] text-[var(--text-disabled)]">
                This extension container has no sidebar view contributions.
              </p>
            )}
            {!selectedExtensionContainerId ? (
            <div className="mt-[10px] flex min-h-0 flex-1 flex-col gap-[8px] overflow-auto">
              {installedExtensions.length === 0 ? (
                <p className="rounded-[var(--radius-card)] border border-[var(--border-subtle)] px-[10px] py-[8px] font-sans text-[12px] text-[var(--text-disabled)]">
                  No enabled extensions are installed in this workspace.
                </p>
              ) : (
                installedExtensions.map((extension) => {
                  const visibleViewEntries = getExtensionViewEntries(extension);
                  return (
                    <div
                      key={extension.extensionId}
                      className="rounded-[var(--radius-card)] border border-[var(--border-subtle)] bg-[var(--bg-main)] px-[10px] py-[8px]"
                    >
                      <p className="truncate font-sans text-[12px] font-medium text-[var(--text-primary)]">
                        {extension.displayName}
                      </p>
                      <div className="mt-[7px] flex flex-col gap-[6px]">
                        {visibleViewEntries.length > 0 ? (
                          visibleViewEntries.map((surface) => (
                            <button
                              key={`${extension.extensionId}:${surface.surfaceId}`}
                              type="button"
                              className="inline-flex items-center justify-between rounded-[var(--radius-tab)] border border-[var(--border-card)] px-[8px] py-[5px] text-left font-sans text-[12px] text-[var(--text-primary)] transition-colors hover:bg-[var(--accent-bg)]"
                              onClick={() => {
                                setSelectedExtensionContainerId(surface.viewType ?? null);
                                setActiveSidebarExtensionSurface(surface);
                              }}
                            >
                              <span className="truncate">{surface.title}</span>
                              <span className="ml-[8px] shrink-0 text-[10px] uppercase tracking-[0.08em] text-[var(--text-disabled)]">
                                View
                              </span>
                            </button>
                          ))
                        ) : (
                          <div className="rounded-[var(--radius-tab)] border border-[var(--border-subtle)] px-[8px] py-[6px] font-sans text-[11px] leading-snug text-[var(--text-disabled)]">
                            No sidebar view contribution. Manage activation, commands, themes, and
                            settings from the marketplace tab.
                          </div>
                        )}
                      </div>
                    </div>
                  );
                })
              )}
            </div>
            ) : null}
          </div>
        )}
      </div>
    </div>
  );
}

function ActivityButton({
  active,
  onClick,
  onContextMenu,
  label,
  icon: Icon,
}: {
  active: boolean;
  onClick: () => void;
  onContextMenu?: (e: MouseEvent) => void;
  label: string;
  icon: LucideIcon;
}) {
  return (
    <button
      type="button"
      role="tab"
      aria-selected={active}
      aria-label={label}
      onClick={onClick}
      onContextMenu={onContextMenu}
      className={`flex size-[30px] shrink-0 items-center justify-center rounded-[4px] outline-none transition-colors focus-visible:outline-none ${
        active
          ? "text-[var(--text-primary)]"
          : "text-[var(--text-secondary)] hover:bg-[var(--accent-bg)] hover:text-[var(--text-primary)]"
      }`}
    >
      <Icon className="size-[18px]" strokeWidth={active ? 2 : 1.5} aria-hidden />
    </button>
  );
}

function ExtensionActivityButton({
  active,
  onClick,
  onContextMenu,
  label,
  icon,
  iconUrl,
}: {
  active: boolean;
  onClick: () => void;
  onContextMenu?: (e: MouseEvent) => void;
  label: string;
  icon?: ExtensionIconDescriptor;
  iconUrl?: string;
}) {
  return (
    <button
      type="button"
      role="tab"
      aria-selected={active}
      aria-label={label}
      title={label}
      onClick={onClick}
      onContextMenu={onContextMenu}
      className={`flex size-[30px] shrink-0 items-center justify-center rounded-[4px] outline-none transition-colors focus-visible:outline-none ${
        active
          ? "bg-[var(--accent-bg)] text-[var(--text-primary)]"
          : "text-[var(--text-secondary)] hover:bg-[var(--accent-bg)] hover:text-[var(--text-primary)]"
      }`}
    >
      <ExtensionIcon icon={icon} resourceUrl={iconUrl} label={label} />
    </button>
  );
}
