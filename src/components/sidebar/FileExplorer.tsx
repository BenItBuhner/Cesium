"use client";

import { useState, useCallback } from "react";
import { Files, GitBranch, Search, type LucideIcon } from "lucide-react";
import { fileTree, resolveExplorerOpenRequest } from "@/lib/mock-data";
import { useOpenInEditor } from "@/components/editor/OpenInEditorContext";
import type { FileNode } from "@/lib/types";
import { FileTree, collectExpandableFolderPaths } from "./FileTree";

type SidebarView = "explorer" | "search" | "scm";

export function FileExplorer() {
  const { openExplorerFile } = useOpenInEditor();
  const [view, setView] = useState<SidebarView>("explorer");
  const [expandedPaths, setExpandedPaths] = useState<Set<string>>(() => {
    return new Set(collectExpandableFolderPaths(fileTree.children, ""));
  });

  const handleOpenFile = useCallback(
    (path: string, node: FileNode) => {
      openExplorerFile(resolveExplorerOpenRequest(path, node));
    },
    [openExplorerFile]
  );

  const toggleFolder = useCallback((path: string) => {
    setExpandedPaths((prev) => {
      const next = new Set(prev);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      return next;
    });
  }, []);

  return (
    <div className="flex h-full min-w-0 flex-col overflow-hidden bg-[var(--bg-panel)]">
      <div className="flex w-full shrink-0 justify-center px-[11px] py-[4px]">
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

      {view === "explorer" && (
        <>
          <p className="shrink-0 px-[11px] pb-[5px] pt-[6px] font-sans text-[14px] font-normal text-[var(--text-primary)]">
            {fileTree.name}
          </p>
          <div className="min-h-0 flex-1 overflow-y-auto">
            {fileTree.children?.map((node) => (
              <FileTree
                key={node.name}
                node={node}
                depth={0}
                parentPath=""
                expandedPaths={expandedPaths}
                onToggleFolder={toggleFolder}
                onOpenFile={handleOpenFile}
              />
            ))}
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
          : "text-[var(--text-secondary)] hover:bg-white/[0.04] hover:text-[var(--text-primary)]"
      }`}
    >
      <Icon className="size-[18px]" strokeWidth={active ? 2 : 1.5} aria-hidden />
    </button>
  );
}
