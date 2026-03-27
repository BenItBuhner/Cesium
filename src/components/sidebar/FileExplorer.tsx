"use client";

import {
  useState,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  type KeyboardEvent,
  type MouseEvent,
} from "react";
import { Files, GitBranch, Search, type LucideIcon } from "lucide-react";
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
} from "@/lib/server-api";
import { FileTree, collectExpandableFolderPaths } from "./FileTree";
import { SidebarAppMenu } from "./SidebarAppMenu";
import { useUserPreferences } from "@/components/preferences/UserPreferencesProvider";
import { useWorkspace } from "@/contexts/WorkspaceContext";

type SidebarView = "explorer" | "search" | "scm";

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

export function FileExplorer() {
  const { openExplorerFile, activeExplorerPath } = useOpenInEditor();
  const bridgeRef = useEditorBridgeRef();
  const { openAt, openAtPoint } = useWorkbenchContextMenu();
  const { experimentalIpadCustomButtons } = useUserPreferences();
  const { pushNotification, dismiss } = useWorkbenchNotifications();
  const { fileTree, workspaceInfo, loading, loadFolderChildren, refreshTree } =
    useWorkspace();
  const [view, setView] = useState<SidebarView>("explorer");
  const [searchQuery, setSearchQuery] = useState("");
  const [expandedPaths, setExpandedPaths] = useState<Set<string>>(new Set());
  const pendingRevealLoadsRef = useRef(new Set<string>());
  const uploadInputRef = useRef<HTMLInputElement>(null);
  const uploadFolderRef = useRef<string>("");

  const [fsPrompt, setFsPrompt] = useState<{
    kind: FsPromptKind;
    /** rename: full file path; new*: parent folder path */
    path: string;
    initialValue: string;
  } | null>(null);
  const [fsPromptValue, setFsPromptValue] = useState("");

  const expandablePaths = useMemo(
    () => new Set(collectExpandableFolderPaths(fileTree?.children, "")),
    [fileTree]
  );
  const visibleExpandedPaths = useMemo(
    () => new Set([...expandedPaths].filter((path) => expandablePaths.has(path))),
    [expandedPaths, expandablePaths]
  );

  const flashError = useCallback(
    (message: string) => {
      pushNotification({
        kind: WORKBENCH_NOTIFICATION_KIND.editorNotice,
        severity: "error",
        title: "Files",
        message,
        persistent: false,
        autoDismissMs: 8000,
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
        bridge.dispatch({ type: "TOGGLE_SPLIT" });
      }
      bridge.dispatch({ type: "FOCUS_EDITOR_GROUP", group: "right" });
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
              onSelect: () => setView("explorer"),
            },
            {
              type: "item",
              id: "v-search",
              label: "Show Search",
              onSelect: () => setView("search"),
            },
            {
              type: "item",
              id: "v-scm",
              label: "Show Source Control",
              onSelect: () => setView("scm"),
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
              onClick={() => setView("explorer")}
              label="Explorer"
              icon={Files}
              onContextMenu={(e) => {
                e.stopPropagation();
                openAt(e, [
                  {
                    type: "item",
                    id: "focus-ex",
                    label: "Focus Explorer",
                    onSelect: () => setView("explorer"),
                  },
                ]);
              }}
            />
            <ActivityButton
              active={view === "search"}
              onClick={() => setView("search")}
              label="Search"
              icon={Search}
              onContextMenu={(e) => {
                e.stopPropagation();
                openAt(e, [
                  {
                    type: "item",
                    id: "focus-search",
                    label: "Focus Search",
                    onSelect: () => setView("search"),
                  },
                ]);
              }}
            />
            <ActivityButton
              active={view === "scm"}
              onClick={() => setView("scm")}
              label="Source Control"
              icon={GitBranch}
              onContextMenu={(e) => {
                e.stopPropagation();
                openAt(e, [
                  {
                    type: "item",
                    id: "focus-scm",
                    label: "Focus Source Control",
                    onSelect: () => setView("scm"),
                  },
                ]);
              }}
            />
          </div>
        </div>
      </div>

      <div className="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden">
        {view === "explorer" && (
          <>
            <p className="pointer-events-none shrink-0 px-[11px] pb-[5px] pt-[6px] font-sans text-[14px] font-normal text-[var(--text-primary)]">
              {workspaceInfo?.name ?? "Workspace"}
            </p>
            <div className="min-h-0 flex-1 overflow-y-auto">
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
                  id: "init",
                  label: "Initialize Repository (demo)",
                  onSelect: () =>
                    pushNotification({
                      kind: WORKBENCH_NOTIFICATION_KIND.editorNotice,
                      severity: "info",
                      title: "Source Control",
                      message: "Git integration is not wired yet.",
                      autoDismissMs: 4000,
                    }),
                },
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
