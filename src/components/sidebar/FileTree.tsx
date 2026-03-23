"use client";

import { FileTreeItem } from "./FileTreeItem";
import type { FileNode } from "@/lib/types";

interface FileTreeProps {
  node: FileNode;
  depth: number;
  /** Path from explorer root, e.g. `src` or `src/app`. */
  parentPath: string;
  expandedPaths: Set<string>;
  onToggleFolder: (path: string) => void;
  /** File leaf: open in editor (demo). */
  onOpenFile?: (path: string, node: FileNode) => void;
}

export function FileTree({
  node,
  depth,
  parentPath,
  expandedPaths,
  onToggleFolder,
  onOpenFile,
}: FileTreeProps) {
  const path = parentPath ? `${parentPath}/${node.name}` : node.name;
  const isFolder = node.type === "folder";
  const childCount = node.children?.length ?? 0;
  const hasChildren = isFolder && childCount > 0;
  const isExpanded = hasChildren && expandedPaths.has(path);

  const onActivate =
    isFolder && hasChildren
      ? () => onToggleFolder(path)
      : !isFolder && onOpenFile
        ? () => onOpenFile(path, node)
        : undefined;

  return (
    <div>
      <FileTreeItem
        node={node}
        depth={depth}
        isExpanded={isExpanded}
        hasChildren={hasChildren}
        onActivate={onActivate}
      />
      {isFolder && isExpanded
        ? node.children!.map((child) => (
            <FileTree
              key={`${path}/${child.name}`}
              node={child}
              depth={depth + 1}
              parentPath={path}
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
    if (count > 0) {
      out.push(p, ...collectExpandableFolderPaths(n.children, p));
    }
  }
  return out;
}
