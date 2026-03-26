"use client";

import { FileTreeItem } from "./FileTreeItem";
import type { FileNode } from "@/lib/types";

interface FileTreeProps {
  node: FileNode;
  depth: number;
  /** Path from explorer root, e.g. `src` or `src/app`. */
  parentPath: string;
  activePath: string | null;
  expandedPaths: Set<string>;
  onToggleFolder: (path: string, node: FileNode) => void | Promise<void>;
  /** File leaf: open in editor (demo). */
  onOpenFile?: (path: string, node: FileNode) => void;
}

export function FileTree({
  node,
  depth,
  parentPath,
  activePath,
  expandedPaths,
  onToggleFolder,
  onOpenFile,
}: FileTreeProps) {
  const path = parentPath ? `${parentPath}/${node.name}` : node.name;
  const isFolder = node.type === "folder";
  const childCount = node.children?.length ?? 0;
  const canExpand =
    isFolder &&
    (node.hasChildren === true || childCount > 0 || node.childrenLoaded === false);
  const hasChildNodes = isFolder && childCount > 0;
  const isExpanded = isFolder && expandedPaths.has(path);
  const isActive = !isFolder && activePath === path;

  const onActivate = isFolder
    ? canExpand
      ? () => onToggleFolder(path, node)
      : undefined
    : onOpenFile
      ? () => onOpenFile(path, node)
      : undefined;

  return (
    <div>
      <FileTreeItem
        node={node}
        depth={depth}
        isExpanded={isExpanded}
        isExpandable={canExpand}
        isActive={isActive}
        onActivate={onActivate}
      />
      {isFolder && isExpanded && hasChildNodes
        ? node.children!.map((child) => (
            <FileTree
              key={`${path}/${child.name}`}
              node={child}
              depth={depth + 1}
              parentPath={path}
              activePath={activePath}
              expandedPaths={expandedPaths}
              onToggleFolder={onToggleFolder}
              onOpenFile={onOpenFile}
            />
          ))
        : null}
    </div>
  );
}

/** All folder paths that have at least one child — used as initial expanded set. */
export function collectExpandableFolderPaths(
  nodes: FileNode[] | undefined,
  parentPath: string
): string[] {
  const out: string[] = [];
  for (const n of nodes ?? []) {
    if (n.type !== "folder") continue;
    const p = parentPath ? `${parentPath}/${n.name}` : n.name;
    const count = n.children?.length ?? 0;
    const canExpand = n.hasChildren === true || count > 0 || n.childrenLoaded === false;
    if (canExpand) {
      out.push(p);
    }
    if (count > 0) {
      out.push(...collectExpandableFolderPaths(n.children, p));
    }
  }
  return out;
}
