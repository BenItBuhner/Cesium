import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  DATA_DIR,
  createWorkspaceId,
  normalizeWorkspaceRoot,
  readJsonFile,
  writeJsonFile,
} from "./persistence.js";

export type WorkspaceRecord = {
  id: string;
  name: string;
  root: string;
  createdAt: number;
  updatedAt: number;
  lastOpenedAt: number;
};

type WorkspaceRegistryFile = {
  schemaVersion: number;
  workspaces: WorkspaceRecord[];
};

type WorkspaceProfileFile = {
  schemaVersion: number;
  defaultWorkspaceId: string | null;
  lastOpenedWorkspaceId: string | null;
  recentWorkspaceIds: string[];
};

const WORKSPACES_FILE = path.join(DATA_DIR, "workspaces", "index.json");
const PROFILE_FILE = path.join(DATA_DIR, "profile", "workspace-profile.json");

/** Display name for the workspace rooted at the current OS user's home directory. */
export const HOME_WORKSPACE_DISPLAY_NAME = "Home";

const EMPTY_REGISTRY: WorkspaceRegistryFile = {
  schemaVersion: 1,
  workspaces: [],
};

const EMPTY_PROFILE: WorkspaceProfileFile = {
  schemaVersion: 1,
  defaultWorkspaceId: null,
  lastOpenedWorkspaceId: null,
  recentWorkspaceIds: [],
};

async function readRegistry(): Promise<WorkspaceRegistryFile> {
  const registry = await readJsonFile(WORKSPACES_FILE, EMPTY_REGISTRY);
  return {
    schemaVersion: 1,
    workspaces: Array.isArray(registry.workspaces) ? registry.workspaces : [],
  };
}

async function writeRegistry(registry: WorkspaceRegistryFile): Promise<void> {
  await writeJsonFile(WORKSPACES_FILE, registry);
}

async function readProfile(): Promise<WorkspaceProfileFile> {
  const profile = await readJsonFile(PROFILE_FILE, EMPTY_PROFILE);
  return {
    schemaVersion: 1,
    defaultWorkspaceId:
      typeof profile.defaultWorkspaceId === "string" ? profile.defaultWorkspaceId : null,
    lastOpenedWorkspaceId:
      typeof profile.lastOpenedWorkspaceId === "string"
        ? profile.lastOpenedWorkspaceId
        : null,
    recentWorkspaceIds: Array.isArray(profile.recentWorkspaceIds)
      ? profile.recentWorkspaceIds.filter((value): value is string => typeof value === "string")
      : [],
  };
}

async function writeProfile(profile: WorkspaceProfileFile): Promise<void> {
  await writeJsonFile(PROFILE_FILE, profile);
}

function deriveWorkspaceName(root: string, preferredName?: string): string {
  const trimmed = preferredName?.trim();
  if (trimmed) {
    return trimmed;
  }

  const base = path.basename(root);
  return base || root;
}

function sortWorkspaces(workspaces: WorkspaceRecord[]): WorkspaceRecord[] {
  return [...workspaces].sort((a, b) => {
    const aHome = a.name === HOME_WORKSPACE_DISPLAY_NAME ? 0 : 1;
    const bHome = b.name === HOME_WORKSPACE_DISPLAY_NAME ? 0 : 1;
    if (aHome !== bHome) return aHome - bHome;
    return b.lastOpenedAt - a.lastOpenedAt || a.name.localeCompare(b.name);
  });
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
  const registry = await readRegistry();
  return sortWorkspaces(registry.workspaces);
}

export async function getWorkspaceById(
  workspaceId: string
): Promise<WorkspaceRecord | null> {
  const registry = await readRegistry();
  return registry.workspaces.find((workspace) => workspace.id === workspaceId) ?? null;
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

  const registry = await readRegistry();
  const now = Date.now();
  const existing = registry.workspaces.find((workspace) => workspace.root === normalizedRoot);
  if (existing) {
    const next: WorkspaceRecord = {
      ...existing,
      name: deriveWorkspaceName(normalizedRoot, preferredName || existing.name),
      updatedAt: now,
      lastOpenedAt: trackOpen ? now : existing.lastOpenedAt,
    };
    registry.workspaces = registry.workspaces.map((workspace) =>
      workspace.id === next.id ? next : workspace
    );
    await writeRegistry(registry);
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
  registry.workspaces = sortWorkspaces([...registry.workspaces, workspace]);
  await writeRegistry(registry);
  await noteWorkspaceOpened(workspace.id);
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
  const [registry, profile] = await Promise.all([readRegistry(), readProfile()]);
  const now = Date.now();
  registry.workspaces = registry.workspaces.map((workspace) =>
    workspace.id === workspaceId
      ? { ...workspace, lastOpenedAt: now, updatedAt: now }
      : workspace
  );
  profile.lastOpenedWorkspaceId = workspaceId;
  profile.recentWorkspaceIds = [workspaceId, ...profile.recentWorkspaceIds.filter((id) => id !== workspaceId)].slice(0, 20);
  if (!profile.defaultWorkspaceId) {
    profile.defaultWorkspaceId = workspaceId;
  }
  await Promise.all([writeRegistry(registry), writeProfile(profile)]);
}

export async function setDefaultWorkspace(workspaceId: string): Promise<void> {
  const workspace = await getWorkspaceById(workspaceId);
  if (!workspace) {
    throw new Error(`Unknown workspace: ${workspaceId}`);
  }
  const profile = await readProfile();
  profile.defaultWorkspaceId = workspaceId;
  await writeProfile(profile);
}

export async function getWorkspaceProfile(): Promise<WorkspaceProfileFile> {
  return readProfile();
}

export async function resolveStartupWorkspace(): Promise<WorkspaceRecord | null> {
  const [workspaces, profile] = await Promise.all([listWorkspaces(), readProfile()]);
  if (workspaces.length === 0) {
    return null;
  }

  const preferredId = profile.lastOpenedWorkspaceId ?? profile.defaultWorkspaceId;
  if (preferredId) {
    return workspaces.find((workspace) => workspace.id === preferredId) ?? workspaces[0] ?? null;
  }

  return workspaces[0] ?? null;
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
