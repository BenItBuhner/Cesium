"use client";

import { useState, useCallback, useEffect, useMemo, useRef } from "react";
import { Files, GitBranch, Search, type LucideIcon } from "lucide-react";
import { useOpenInEditor } from "@/components/editor/OpenInEditorContext";
import type { EditorTab, FileNode } from "@/lib/types";
import { FileTree, collectExpandableFolderPaths } from "./FileTree";
import { SidebarAppMenu } from "./SidebarAppMenu";
import { useWorkspace } from "@/contexts/WorkspaceContext";

type SidebarView = "explorer" | "search" | "scm";

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
  const { fileTree, workspaceInfo, loading, loadFolderChildren } = useWorkspace();
  const [view, setView] = useState<SidebarView>("explorer");
  const [expandedPaths, setExpandedPaths] = useState<Set<string>>(new Set());
  const pendingRevealLoadsRef = useRef(new Set<string>());
  const expandablePaths = useMemo(
    () => new Set(collectExpandableFolderPaths(fileTree?.children, "")),
    [fileTree]
  );
  const visibleExpandedPaths = useMemo(
    () => new Set([...expandedPaths].filter((path) => expandablePaths.has(path))),
    [expandedPaths, expandablePaths]
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

  return (
    <div className="flex h-full min-w-0 flex-col bg-[var(--bg-panel)]">
      <div className="flex w-full shrink-0 justify-center px-[11px] py-[4px]">
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
          />
          <ActivityButton
            active={view === "search"}
            onClick={() => setView("search")}
            label="Search"
            icon={Search}
          />
          <ActivityButton
            active={view === "scm"}
            onClick={() => setView("scm")}
            label="Source Control"
            icon={GitBranch}
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
                />
              ))
            )}
          </div>
        </>
      )}

      {view === "search" && (
        <div
          data-ide-input-sink
          className="flex min-h-0 flex-1 flex-col px-[11px] pb-[11px] pt-[6px]"
        >
          <div className="flex shrink-0 items-center gap-[6px] rounded-[var(--radius-tab)] border border-[var(--border-card)] bg-[var(--bg-main)] px-[8px] py-[5px]">
            <Search className="size-[14px] shrink-0 text-[var(--text-disabled)]" strokeWidth={1.5} />
            <input
              type="search"
              placeholder="Search"
              className="min-w-0 flex-1 bg-transparent font-sans text-[13px] text-[var(--text-primary)] outline-none placeholder:text-[var(--text-disabled)]"
              aria-label="Search files"
            />
          </div>
          <p className="mt-[14px] font-sans text-[12px] text-[var(--text-disabled)]">
            Type to search across files. Results will appear here.
          </p>
        </div>
      )}

      {view === "scm" && (
        <div className="flex min-h-0 flex-1 flex-col px-[11px] pb-[11px] pt-[6px]">
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
  label,
  icon: Icon,
}: {
  active: boolean;
  onClick: () => void;
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
