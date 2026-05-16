import { promises as fs } from "node:fs";
import os from "node:os";
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

function dedupeKey(p: string): string {
  return process.platform === "win32" ? path.normalize(p).toLowerCase() : path.normalize(p);
}

function pushCandidate(
  candidates: BrowseRootEntry[],
  seen: Set<string>,
  rawPath: string | undefined,
  label: string
): void {
  const value = rawPath?.trim();
  if (!value) {
    return;
  }
  const resolved = path.resolve(value);
  const key = dedupeKey(resolved);
  if (seen.has(key)) {
    return;
  }
  seen.add(key);
  candidates.push({ path: resolved, label });
}

function discoverWindowsBrowseRoots(): BrowseRootEntry[] {
  if (process.platform !== "win32") {
    return [];
  }

  const candidates: BrowseRootEntry[] = [];
  const seen = new Set<string>();
  const homeDir = os.homedir();
  const userProfile = process.env.USERPROFILE?.trim() || homeDir;

  for (const key of ["OneDrive", "OneDriveConsumer", "OneDriveCommercial"]) {
    const label = key.replace(/([a-z])([A-Z])/g, "$1 $2");
    const root = process.env[key];
    pushCandidate(candidates, seen, root, label);
    if (root?.trim()) {
      pushCandidate(candidates, seen, path.join(root, "Documents"), `${label} Documents`);
      pushCandidate(candidates, seen, path.join(root, "Documents", "Projects"), `${label} Projects`);
    }
  }

  if (userProfile) {
    const oneDriveRoot = path.join(userProfile, "OneDrive");
    pushCandidate(candidates, seen, oneDriveRoot, "OneDrive");
    pushCandidate(candidates, seen, path.join(oneDriveRoot, "Documents"), "OneDrive Documents");
    pushCandidate(candidates, seen, path.join(oneDriveRoot, "Documents", "Projects"), "OneDrive Projects");
    pushCandidate(candidates, seen, path.join(userProfile, "Documents"), "Documents");
    pushCandidate(candidates, seen, path.join(userProfile, "Documents", "Projects"), "Projects");
    pushCandidate(candidates, seen, path.join(userProfile, "Desktop"), "Desktop");
    pushCandidate(candidates, seen, path.join(userProfile, "Downloads"), "Downloads");
  }

  for (const drive of "ABCDEFGHIJKLMNOPQRSTUVWXYZ") {
    pushCandidate(candidates, seen, `${drive}:\\`, `${drive}: drive`);
  }

  return candidates;
}

function basenameLabel(value: string): string {
  const base = path.basename(value);
  return base || value;
}

export async function listBrowseRoots(): Promise<BrowseRootEntry[]> {
  const roots: BrowseRootEntry[] = [
    ...discoverWindowsBrowseRoots(),
    ...getAllowedWorkspaceRoots().map((root) => ({
      path: root,
      label: basenameLabel(root),
    })),
  ];
  const out: BrowseRootEntry[] = [];
  const seen = new Set<string>();
  for (const root of roots) {
    const real = await fs.realpath(root.path).catch(() => root.path);
    const stat = await fs.stat(real).catch(() => null);
    if (!stat?.isDirectory()) {
      continue;
    }
    const key = dedupeKey(real);
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    out.push({
      path: real,
      label: root.label || basenameLabel(real),
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
