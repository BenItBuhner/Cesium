"use client";

import { ChevronRight, Folder } from "lucide-react";
import type { FileNode } from "@/lib/types";
import { getFileIconForNode } from "@/lib/file-type-icons";

interface FileTreeItemProps {
  node: FileNode;
  depth: number;
  isExpanded?: boolean;
  /** Folder: toggles expand/collapse. File: opens in editor. */
  onActivate?: () => void;
}

export function FileTreeItem({
  node,
  depth,
  isExpanded = false,
  onActivate,
}: FileTreeItemProps) {
  const paddingLeft = 11 + depth * 18;
  const isFolder = node.type === "folder";
  const textColor = node.dimmed ? "var(--text-disabled)" : "var(--text-primary)";
  const fileIconEntry = isFolder ? null : getFileIconForNode(node.language, node.name);
  const FileIconComponent = fileIconEntry?.Icon;
  return (
    <button
      type="button"
      className="flex w-full items-center gap-[4px] rounded-[var(--radius-tab)] py-[1px] text-left transition-colors hover:bg-[var(--accent-bg)]"
      style={{ paddingLeft }}
      onClick={onActivate}
      aria-expanded={isFolder ? isExpanded : undefined}
    >
      {isFolder ? (
        <ChevronRight
          className={`size-[10px] shrink-0 text-[var(--text-secondary)] transition-transform duration-200 ease-out motion-reduce:transition-none ${
            isExpanded ? "rotate-90" : ""
          }`}
          strokeWidth={2}
          aria-hidden
        />
      ) : null}
      <span className="shrink-0">
        {isFolder ? (
          <Folder
            className={`size-[18px] ${node.dimmed ? "text-[var(--text-disabled)]" : "text-[#6f6f6f]"}`}
            strokeWidth={1.5}
            aria-hidden
          />
        ) : (
          FileIconComponent && (
            <FileIconComponent
              className={`size-[18px] shrink-0 ${fileIconEntry!.className} ${node.dimmed ? "opacity-45" : ""}`}
              strokeWidth={1.5}
              aria-hidden
            />
          )
        )}
      </span>
      <span
        className="truncate font-sans text-[14px] font-normal"
        style={{ color: textColor }}
      >
        {node.name}
      </span>
    </button>
  );
}
