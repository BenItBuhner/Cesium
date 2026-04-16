import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

/**
 * Repo root when the server runs from `server/` (npm run dev in server/), else `process.cwd()`.
 * Matches bootstrap workspace default so the initial workspace is allowed without extra env.
 */
export function resolveRepoRootFromProcessCwd(): string {
  const cwd = process.cwd();
  if (path.basename(cwd).toLowerCase() === "server") {
    return path.resolve(cwd, "..");
  }
  return path.resolve(cwd);
}

function resolveDefaultDataDir(): string {
  if (process.platform === "win32") {
    const localAppData = process.env.LOCALAPPDATA?.trim();
    if (localAppData) {
      return path.resolve(localAppData, "OpenCursor", "data");
    }
  }

  if (process.platform === "darwin") {
    return path.resolve(
      os.homedir(),
      "Library",
      "Application Support",
      "OpenCursor",
      "data"
    );
  }

  const xdgStateHome = process.env.XDG_STATE_HOME?.trim();
  if (xdgStateHome) {
    return path.resolve(xdgStateHome, "opencursor");
  }

  return path.resolve(os.homedir(), ".local", "state", "opencursor");
}

function resolveDataDir(): string {
  const configured = process.env.OPENCURSOR_DATA_DIR?.trim();
  if (configured) {
    return path.resolve(configured);
  }

  return resolveDefaultDataDir();
}

export const DATA_DIR = resolveDataDir();

function getLegacyDataDirs(): string[] {
  const repoRoot = resolveRepoRootFromProcessCwd();
  return [
    path.resolve(process.cwd(), ".opencursor-data"),
    path.resolve(repoRoot, ".opencursor-data"),
    path.resolve(repoRoot, "server", ".opencursor-data"),
  ].filter((value, index, all) => all.indexOf(value) === index && value !== DATA_DIR);
}

async function pathExists(targetPath: string): Promise<boolean> {
  try {
    await fs.access(targetPath);
    return true;
  } catch {
    return false;
  }
}

async function hasDirectoryEntries(targetPath: string): Promise<boolean> {
  try {
    const entries = await fs.readdir(targetPath);
    return entries.length > 0;
  } catch {
    return false;
  }
}

async function migrateLegacyDataDir(sourceDir: string, targetDir: string): Promise<void> {
  await fs.mkdir(path.dirname(targetDir), { recursive: true });
  try {
    await fs.rename(sourceDir, targetDir);
    return;
  } catch {
    // Fall back to a copy when rename is blocked by platform or sync tooling.
  }
  await fs.cp(sourceDir, targetDir, {
    recursive: true,
    force: true,
    errorOnExist: false,
  });
  await fs.rm(sourceDir, { recursive: true, force: true }).catch(() => undefined);
}

async function ensureResolvedDataDir(): Promise<void> {
  const targetExists = await pathExists(DATA_DIR);
  if (!targetExists) {
    for (const legacyDir of getLegacyDataDirs()) {
      if (!(await hasDirectoryEntries(legacyDir))) {
        continue;
      }
      await migrateLegacyDataDir(legacyDir, DATA_DIR);
      break;
    }
  }
  await fs.mkdir(DATA_DIR, { recursive: true });
}

export async function ensureDataDir(): Promise<void> {
  await ensureResolvedDataDir();
}

export function createWorkspaceId(root: string): string {
  return createHash("sha1").update(root).digest("hex").slice(0, 12);
}

export function getAllowedWorkspaceRoots(): string[] {
  const configured = process.env.WORKSPACE_ALLOWED_ROOTS?.trim();
  if (configured) {
    return [
      ...new Set(
        configured
          .split(",")
          .map((value) => path.resolve(value.trim()))
          .filter(Boolean)
      ),
    ];
  }

  const defaults: string[] = [];
  const homeDir = os.homedir()?.trim();
  if (homeDir) {
    defaults.push(path.resolve(homeDir));
  }
  const workspaceRoot = process.env.WORKSPACE_ROOT?.trim();
  if (workspaceRoot) {
    defaults.push(path.resolve(workspaceRoot));
  }
  defaults.push(resolveRepoRootFromProcessCwd());

  const seen = new Set<string>();
  const out: string[] = [];
  for (const value of defaults) {
    const key = path.normalize(value);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(value);
  }
  return out;
}

export function isWithinAllowedRoots(targetPath: string): boolean {
  if (process.env.OPENCURSOR_ALLOW_ANY_WORKSPACE_ROOT === "1") {
    return true;
  }

  const resolvedTarget = path.resolve(targetPath);
  return getAllowedWorkspaceRoots().some((allowedRoot) => {
    const relative = path.relative(allowedRoot, resolvedTarget);
    return (
      relative === "" ||
      (!relative.startsWith("..") && !path.isAbsolute(relative))
    );
  });
}

export async function normalizeWorkspaceRoot(inputRoot: string): Promise<string> {
  const resolved = path.resolve(inputRoot.trim());
  const real = await fs.realpath(resolved).catch(() => resolved);
  if (!isWithinAllowedRoots(real)) {
    throw new Error(`Workspace path is not allowed: ${real}`);
  }
  return real;
}
