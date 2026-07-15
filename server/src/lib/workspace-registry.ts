import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { invalidate, readThrough } from "../cache/read-through.js";
import { getStorage } from "../storage/runtime.js";
import { createWorkspaceId, normalizeWorkspaceRoot } from "./persistence.js";
import { HOME_WORKSPACE_DISPLAY_NAME } from "./workspace-constants.js";
import {
  annotateWorkspaceKind,
  isStandaloneChatWorkspace,
} from "./standalone-chat-paths.js";

export async function getHomeWorkspace(): Promise<WorkspaceRecord | null> {
  try {
    const root = resolveUserHomeDirectory();
    const normalized = await normalizeWorkspaceRoot(root);
    const storage = await getStorage();
    return storage.getWorkspaceByRoot(normalized);
  } catch {
    return null;
  }
}

/**
 * Removes a workspace from storage and fixes the global workspace profile.
 * Refuses the Home workspace entry (same rules as `ensureHomeWorkspace`).
 */
export async function removeWorkspace(workspaceId: string): Promise<void> {
  const home = await getHomeWorkspace();
  if (home && home.id === workspaceId) {
    throw new Error("The Home workspace cannot be removed.");
  }

  const storage = await getStorage();
  const existing = await storage.getWorkspace(workspaceId);
  if (!existing) {
    throw new Error(`Unknown workspace: ${workspaceId}`);
  }

  await storage.deleteWorkspace(workspaceId);

  const profile = await storage.getWorkspaceProfile();
  const homeId = home?.id ?? null;
  const remainingRecent = profile.recentWorkspaceIds.filter((id) => id !== workspaceId);

  let defaultWorkspaceId = profile.defaultWorkspaceId;
  if (defaultWorkspaceId === workspaceId) {
    defaultWorkspaceId = homeId ?? remainingRecent[0] ?? null;
  }

  let lastOpenedWorkspaceId = profile.lastOpenedWorkspaceId;
  if (lastOpenedWorkspaceId === workspaceId) {
    lastOpenedWorkspaceId = homeId ?? remainingRecent[0] ?? null;
  }

  await storage.saveWorkspaceProfile({
    schemaVersion: 1,
    defaultWorkspaceId,
    lastOpenedWorkspaceId,
    recentWorkspaceIds: remainingRecent,
  });
  await invalidateWorkspaceCaches(workspaceId);
}

// Short-lived caches for the hot read paths. Every write helper below calls
// `invalidateWorkspaceCaches(id?)` so freshness is bounded by "next write",
// not the TTL. The TTL is the worst-case staleness window if some other
// process writes directly to Postgres.
const WORKSPACE_CACHE_TTL_SECONDS = 60;
const KEY_WORKSPACE_LIST = "opencursor:ws:list";
const KEY_WORKSPACE_PROFILE = "opencursor:ws:profile";
const keyWorkspaceById = (id: string) => `opencursor:ws:id:${id}`;

async function invalidateWorkspaceCaches(workspaceId?: string): Promise<void> {
  const keys = [KEY_WORKSPACE_LIST, KEY_WORKSPACE_PROFILE];
  if (workspaceId) keys.push(keyWorkspaceById(workspaceId));
  await invalidate(...keys);
}

export type WorkspaceRecord = {
  id: string;
  name: string;
  root: string;
  createdAt: number;
  updatedAt: number;
  lastOpenedAt: number;
  kind?: "workspace" | "standalone-chat";
};

export type WorkspaceProfileFile = {
  schemaVersion: number;
  defaultWorkspaceId: string | null;
  lastOpenedWorkspaceId: string | null;
  recentWorkspaceIds: string[];
};

/** @deprecated Import from `./workspace-constants.js` instead. */
export { HOME_WORKSPACE_DISPLAY_NAME } from "./workspace-constants.js";

function deriveWorkspaceName(root: string, preferredName?: string): string {
  const trimmed = preferredName?.trim();
  if (trimmed) {
    return trimmed;
  }

  const base = path.basename(root);
  return base || root;
}

export function resolveUserHomeDirectory(): string {
  const home = os.homedir()?.trim();
  if (!home) {
    throw new Error("User home directory is not available on this system.");
  }
  return path.resolve(home);
}

/**
 * Ensures a workspace entry exists for the current user's home directory.
 * Skips creation when the path is not allowed (e.g. strict WORKSPACE_ALLOWED_ROOTS).
 */
export async function ensureHomeWorkspace(): Promise<WorkspaceRecord | null> {
  try {
    const root = resolveUserHomeDirectory();
    return await ensureWorkspaceRegistered(root, HOME_WORKSPACE_DISPLAY_NAME, {
      trackOpen: false,
    });
  } catch {
    return null;
  }
}

export async function listWorkspaces(): Promise<WorkspaceRecord[]> {
  return readThrough(KEY_WORKSPACE_LIST, WORKSPACE_CACHE_TTL_SECONDS, async () =>
    (await getStorage()).listWorkspaces().then((list) => list.map(annotateWorkspaceKind))
  );
}

export async function getWorkspaceById(
  workspaceId: string
): Promise<WorkspaceRecord | null> {
  // `readThrough` will skip caching when the loader returns `null` so an
  // unknown id doesn't pin a negative entry across subsequent `upsertWorkspace`
  // calls.
  return readThrough(
    keyWorkspaceById(workspaceId),
    WORKSPACE_CACHE_TTL_SECONDS,
    async () => {
      const workspace = await (await getStorage()).getWorkspace(workspaceId);
      return workspace ? annotateWorkspaceKind(workspace) : null;
    }
  );
}

export async function ensureWorkspaceRegistered(
  root: string,
  preferredName?: string,
  options?: { trackOpen?: boolean }
): Promise<WorkspaceRecord> {
  const trackOpen = options?.trackOpen !== false;
  const normalizedRoot = await normalizeWorkspaceRoot(root);
  const stat = await fs.stat(normalizedRoot);
  if (!stat.isDirectory()) {
    throw new Error(`Workspace root is not a directory: ${normalizedRoot}`);
  }

  const storage = await getStorage();
  const now = Date.now();
  const existing = await storage.getWorkspaceByRoot(normalizedRoot);
  if (existing) {
    const next: WorkspaceRecord = {
      ...existing,
      name: deriveWorkspaceName(normalizedRoot, preferredName || existing.name),
      updatedAt: now,
      lastOpenedAt: trackOpen ? now : existing.lastOpenedAt,
    };
    await storage.upsertWorkspace(next);
    await invalidateWorkspaceCaches(next.id);
    if (trackOpen) {
      await noteWorkspaceOpened(next.id);
    }
    return next;
  }

  const workspace: WorkspaceRecord = {
    id: createWorkspaceId(normalizedRoot),
    name: deriveWorkspaceName(normalizedRoot, preferredName),
    root: normalizedRoot,
    createdAt: now,
    updatedAt: now,
    lastOpenedAt: now,
  };
  await storage.upsertWorkspace(workspace);
  await invalidateWorkspaceCaches(workspace.id);
  if (trackOpen) {
    await noteWorkspaceOpened(workspace.id);
  }
  return workspace;
}

export async function createWorkspace(
  parentPath: string,
  directoryName: string,
  preferredName?: string
): Promise<WorkspaceRecord> {
  const trimmedName = directoryName.trim();
  if (!trimmedName) {
    throw new Error("Workspace directory name is required.");
  }
  if (trimmedName.includes("/") || trimmedName.includes("\\")) {
    throw new Error("Workspace directory name must not contain path separators.");
  }

  const normalizedParent = await normalizeWorkspaceRoot(parentPath);
  const parentStat = await fs.stat(normalizedParent);
  if (!parentStat.isDirectory()) {
    throw new Error(`Workspace parent is not a directory: ${normalizedParent}`);
  }

  const targetRoot = path.join(normalizedParent, trimmedName);
  await fs.mkdir(targetRoot, { recursive: false });
  return ensureWorkspaceRegistered(targetRoot, preferredName || trimmedName);
}

export async function noteWorkspaceOpened(workspaceId: string): Promise<void> {
  const storage = await getStorage();
  const workspace = await storage.getWorkspace(workspaceId);
  if (!workspace) {
    return;
  }
  const now = Date.now();
  const annotated = annotateWorkspaceKind(workspace);
  await storage.upsertWorkspace({
    ...annotated,
    lastOpenedAt: now,
    updatedAt: now,
  });

  // Standalone chat sandboxes should not pollute recent/default workspace lists.
  if (isStandaloneChatWorkspace(annotated)) {
    await invalidateWorkspaceCaches(workspaceId);
    return;
  }

  const profile = await storage.getWorkspaceProfile();
  profile.lastOpenedWorkspaceId = workspaceId;
  profile.recentWorkspaceIds = [
    workspaceId,
    ...profile.recentWorkspaceIds.filter((id) => id !== workspaceId),
  ].slice(0, 20);
  if (!profile.defaultWorkspaceId) {
    profile.defaultWorkspaceId = workspaceId;
  }
  await storage.saveWorkspaceProfile(profile);
  await invalidateWorkspaceCaches(workspaceId);
}

export async function setDefaultWorkspace(workspaceId: string): Promise<void> {
  const workspace = await getWorkspaceById(workspaceId);
  if (!workspace) {
    throw new Error(`Unknown workspace: ${workspaceId}`);
  }
  const storage = await getStorage();
  const profile = await storage.getWorkspaceProfile();
  profile.defaultWorkspaceId = workspaceId;
  await storage.saveWorkspaceProfile(profile);
  await invalidateWorkspaceCaches(workspaceId);
}

export async function getWorkspaceProfile(): Promise<WorkspaceProfileFile> {
  return readThrough(KEY_WORKSPACE_PROFILE, WORKSPACE_CACHE_TTL_SECONDS, async () =>
    (await getStorage()).getWorkspaceProfile()
  );
}

export async function resolveStartupWorkspace(): Promise<WorkspaceRecord | null> {
  const [workspaces, profile] = await Promise.all([
    listWorkspaces(),
    getWorkspaceProfile(),
  ]);
  const durable = workspaces.filter((workspace) => !isStandaloneChatWorkspace(workspace));
  if (durable.length === 0) {
    return null;
  }

  const preferredId = profile.lastOpenedWorkspaceId ?? profile.defaultWorkspaceId;
  if (preferredId) {
    const preferred = durable.find((workspace) => workspace.id === preferredId);
    if (preferred) {
      return preferred;
    }
  }

  return durable[0] ?? null;
}

export async function ensureInitialWorkspace(fallbackRoot: string): Promise<WorkspaceRecord> {
  await ensureHomeWorkspace();
  const startup = await resolveStartupWorkspace();
  if (startup) {
    return startup;
  }
  const workspaces = await listWorkspaces();
  if (workspaces.length > 0) {
    return workspaces[0]!;
  }
  return ensureWorkspaceRegistered(fallbackRoot);
}
