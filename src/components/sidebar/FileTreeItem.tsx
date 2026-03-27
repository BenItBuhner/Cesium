"use client";

import type { MouseEvent } from "react";
import { ChevronRight, Folder, MoreVertical } from "lucide-react";
import type { FileNode } from "@/lib/types";
import { getFileIconForNode } from "@/lib/file-type-icons";

interface FileTreeItemProps {
  node: FileNode;
  depth: number;
  isExpanded?: boolean;
  isExpandable?: boolean;
  isActive?: boolean;
  /** Folder: toggles expand/collapse. File: opens in editor. */
  onActivate?: () => void;
  onContextMenu?: (e: MouseEvent) => void;
  showOverflowMenu?: boolean;
  onOverflowMenu?: (anchorEl: HTMLElement) => void;
}

export function FileTreeItem({
  node,
  depth,
  isExpanded = false,
  isExpandable = false,
  isActive = false,
  onActivate,
  onContextMenu,
  showOverflowMenu = false,
  onOverflowMenu,
}: FileTreeItemProps) {
  const paddingLeft = 11 + depth * 18;
  const isFolder = node.type === "folder";
  const textColor = isActive
    ? "var(--text-primary)"
    : node.dimmed
      ? "var(--text-disabled)"
      : "var(--text-primary)";
  const fileIconEntry = isFolder ? null : getFileIconForNode(node.language, node.name);
  const FileIconComponent = fileIconEntry?.Icon;
  return (
    <div className="group flex w-full items-center gap-[4px]">
      <button
        type="button"
        className="flex min-w-0 flex-1 items-center gap-[4px] rounded-[var(--radius-tab)] py-[1px] text-left transition-colors hover:bg-[var(--accent-bg)]"
        style={{
          paddingLeft,
          backgroundColor: isActive
            ? "color-mix(in srgb, var(--accent) 12%, transparent)"
            : undefined,
        }}
        onClick={onActivate}
        onContextMenu={(e) => {
          e.stopPropagation();
          onContextMenu?.(e);
        }}
        aria-expanded={isFolder && isExpandable ? isExpanded : undefined}
        aria-current={isActive ? "true" : undefined}
      >
        {isFolder ? (
          isExpandable ? (
            <ChevronRight
              className={`size-[10px] shrink-0 text-[var(--text-secondary)] transition-transform duration-200 ease-out motion-reduce:transition-none ${
                isExpanded ? "rotate-90" : ""
              }`}
              strokeWidth={2}
              aria-hidden
            />
          ) : (
            <span className="size-[10px] shrink-0" aria-hidden />
          )
        ) : null}
        <span className="shrink-0">
          {isFolder ? (
            <Folder
              className={`size-[18px] ${
                isActive
                  ? "text-[var(--text-primary)]"
                  : node.dimmed
                    ? "text-[var(--text-disabled)]"
                    : "text-[#6f6f6f]"
              }`}
              strokeWidth={1.5}
              aria-hidden
            />
          ) : (
            FileIconComponent && (
              <FileIconComponent
                className={`size-[18px] shrink-0 ${fileIconEntry!.className} ${
                  !isActive && node.dimmed ? "opacity-45" : ""
                }`}
                strokeWidth={1.5}
                aria-hidden
              />
            )
          )}
        </span>
        <span
          className="min-w-0 flex-1 truncate font-sans text-[14px] font-normal"
          style={{ color: textColor }}
        >
          {node.name}
        </span>
      </button>
      {showOverflowMenu && onOverflowMenu ? (
        <button
          type="button"
          className="mr-[4px] flex size-[24px] shrink-0 items-center justify-center rounded-[var(--radius-tab)] text-[var(--text-secondary)] opacity-0 pointer-events-none transition-[opacity,background-color,color] hover:bg-[var(--accent-bg)] hover:text-[var(--text-primary)] hover:opacity-100 group-hover:pointer-events-auto group-hover:opacity-100 group-focus-within:pointer-events-auto group-focus-within:opacity-100 focus-visible:pointer-events-auto focus-visible:bg-[var(--accent-bg)] focus-visible:text-[var(--text-primary)] focus-visible:opacity-100"
          aria-label={`More actions for ${node.name}`}
          onClick={(e) => {
            e.preventDefault();
            e.stopPropagation();
            onOverflowMenu(e.currentTarget);
          }}
        >
          <MoreVertical className="size-[16px]" strokeWidth={1.5} aria-hidden />
        </button>
      ) : null}
    </div>
  );
}
