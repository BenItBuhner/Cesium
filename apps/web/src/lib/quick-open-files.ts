import type { FileNode } from "@/lib/types";

export type QuickOpenEntry = {
  path: string;
  name: string;
  node: FileNode;
};

function walk(node: FileNode, parentPath: string): QuickOpenEntry[] {
  const path = parentPath ? `${parentPath}/${node.name}` : node.name;
  if (node.type === "file") return [{ path, name: node.name, node }];
  return (node.children ?? []).flatMap((c) => walk(c, path));
}

/** Flat file list using the same path rules as `FileTree` (explorer root children). */
export function buildQuickOpenIndex(root: FileNode): QuickOpenEntry[] {
  return (root.children ?? []).flatMap((n) => walk(n, ""));
}
