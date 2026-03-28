import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
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

function resolveDataDir(): string {
  const configured = process.env.OPENCURSOR_DATA_DIR?.trim();
  if (configured) {
    return path.resolve(configured);
  }

  return path.resolve(process.cwd(), ".opencursor-data");
}

export const DATA_DIR = resolveDataDir();
const writeQueues = new Map<string, Promise<void>>();

export type PersistedEnvelope<T> = {
  schemaVersion: number;
  updatedAt: number;
  data: T;
};

export async function ensureDataDir(): Promise<void> {
  await fs.mkdir(DATA_DIR, { recursive: true });
}

export async function readJsonFile<T>(
  filePath: string,
  fallback: T
): Promise<T> {
  try {
    const raw = await fs.readFile(filePath, "utf8");
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

export async function writeJsonFile(filePath: string, data: unknown): Promise<void> {
  const previousWrite = writeQueues.get(filePath) ?? Promise.resolve();
  const nextWrite = previousWrite.catch(() => undefined).then(async () => {
    await ensureDataDir();
    await fs.mkdir(path.dirname(filePath), { recursive: true });
    const tempPath = `${filePath}.${process.pid}.${Date.now()}-${Math.random()
      .toString(36)
      .slice(2, 10)}.tmp`;
    await fs.writeFile(tempPath, `${JSON.stringify(data, null, 2)}\n`, "utf8");
    await fs.rename(tempPath, filePath);
  });

  writeQueues.set(filePath, nextWrite);

  try {
    await nextWrite;
  } finally {
    if (writeQueues.get(filePath) === nextWrite) {
      writeQueues.delete(filePath);
    }
  }
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
