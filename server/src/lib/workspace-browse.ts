import { promises as fs } from "node:fs";
import path from "node:path";
import {
  getAllowedWorkspaceRoots,
  isWithinAllowedRoots,
  normalizeWorkspaceRoot,
} from "./persistence.js";

export type BrowseRootEntry = { path: string; label: string };
export type BrowseDirEntry = { name: string; path: string };

function dirnameSafe(p: string): string | null {
  const parent = path.dirname(p);
  if (parent === p) {
    return null;
  }
  return parent;
}

export async function listBrowseRoots(): Promise<BrowseRootEntry[]> {
  const roots = getAllowedWorkspaceRoots();
  const out: BrowseRootEntry[] = [];
  for (const root of roots) {
    const real = await fs.realpath(root).catch(() => root);
    out.push({
      path: real,
      label: path.basename(real) || real,
    });
  }
  return out;
}

export async function listBrowseDirectories(absolutePath: string): Promise<{
  currentPath: string;
  parentPath: string | null;
  entries: BrowseDirEntry[];
}> {
  const currentPath = await normalizeWorkspaceRoot(absolutePath);
  const stat = await fs.stat(currentPath).catch(() => null);
  if (!stat?.isDirectory()) {
    throw new Error(`Not a directory: ${currentPath}`);
  }

  let parentPath: string | null = null;
  const rawParent = dirnameSafe(currentPath);
  if (rawParent && isWithinAllowedRoots(rawParent)) {
    parentPath = await normalizeWorkspaceRoot(rawParent).catch(() => null);
  }

  let dirents: import("node:fs").Dirent[];
  try {
    dirents = await fs.readdir(currentPath, { withFileTypes: true });
  } catch (error) {
    if (
      error &&
      typeof error === "object" &&
      "code" in error &&
      (error.code === "EPERM" || error.code === "EACCES")
    ) {
      return { currentPath, parentPath, entries: [] };
    }
    throw error;
  }

  const entries: BrowseDirEntry[] = [];
  for (const dirent of dirents) {
    if (!dirent.isDirectory() || dirent.name === "." || dirent.name === "..") {
      continue;
    }
    if (dirent.name.startsWith(".")) {
      continue;
    }
    const childPath = path.join(currentPath, dirent.name);
    try {
      const st = await fs.stat(childPath);
      if (st.isDirectory()) {
        const resolved = await fs.realpath(childPath).catch(() => childPath);
        entries.push({ name: dirent.name, path: resolved });
      }
    } catch {
      /* skip */
    }
  }

  entries.sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: "base" }));
  return { currentPath, parentPath, entries };
}
