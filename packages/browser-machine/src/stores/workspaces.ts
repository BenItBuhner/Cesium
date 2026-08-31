/**
 * Workspace registry + profile, mirroring the legacy-json driver's
 * `workspaces/index.json` + `profile/workspace-profile.json` documents.
 */
import type { WorkspaceRecord } from "@cesium/core";
import { basename, normalizePath } from "../paths";
import type { Vfs } from "../vfs";
import { readDoc, writeDoc } from "./kv-docs";

const WORKSPACES_KEY = "workspaces:index";
const PROFILE_KEY = "workspaces:profile";

export const WORKSPACES_ROOT = "/workspaces";

export type WorkspaceProfile = {
  defaultWorkspaceId: string | null;
  lastOpenedWorkspaceId: string | null;
  recentWorkspaceIds: string[];
};

function newId(): string {
  return typeof crypto !== "undefined" && typeof crypto.randomUUID === "function"
    ? crypto.randomUUID()
    : `ws-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}

export class WorkspaceStore {
  constructor(private readonly vfs: Vfs) {}

  async list(): Promise<WorkspaceRecord[]> {
    return (await readDoc<WorkspaceRecord[]>(WORKSPACES_KEY)) ?? [];
  }

  private async save(workspaces: WorkspaceRecord[]): Promise<void> {
    await writeDoc(WORKSPACES_KEY, workspaces);
  }

  async profile(): Promise<WorkspaceProfile> {
    return (
      (await readDoc<WorkspaceProfile>(PROFILE_KEY)) ?? {
        defaultWorkspaceId: null,
        lastOpenedWorkspaceId: null,
        recentWorkspaceIds: [],
      }
    );
  }

  private async saveProfile(profile: WorkspaceProfile): Promise<void> {
    await writeDoc(PROFILE_KEY, profile);
  }

  async getById(workspaceId: string): Promise<WorkspaceRecord | null> {
    const workspaces = await this.list();
    return workspaces.find((workspace) => workspace.id === workspaceId) ?? null;
  }

  async getByRoot(root: string): Promise<WorkspaceRecord | null> {
    const normalized = normalizePath(root);
    const workspaces = await this.list();
    return workspaces.find((workspace) => workspace.root === normalized) ?? null;
  }

  /**
   * Create a workspace directory + registry row. `root` may be provided
   * (registering an existing VFS directory) or derived from the name.
   */
  async create(input: {
    name?: string;
    root?: string;
    directoryName?: string;
    kind?: WorkspaceRecord["kind"];
  }): Promise<WorkspaceRecord> {
    const id = newId();
    const directoryName =
      input.directoryName?.trim() ||
      input.name?.trim().replace(/[^\w.-]+/g, "-").toLowerCase() ||
      id.slice(0, 8);
    const root = input.root ? normalizePath(input.root) : `${WORKSPACES_ROOT}/${directoryName}`;
    const existing = await this.getByRoot(root);
    if (existing) {
      return this.noteOpened(existing.id);
    }
    if (!this.vfs.exists(root)) {
      this.vfs.mkdir(root, { recursive: true });
    }
    const now = Date.now();
    const record: WorkspaceRecord = {
      id,
      root,
      name: input.name?.trim() || basename(root) || "workspace",
      createdAt: now,
      updatedAt: now,
      lastOpenedAt: now,
      ...(input.kind ? { kind: input.kind } : {}),
    };
    const workspaces = await this.list();
    await this.save([...workspaces, record]);
    await this.noteOpened(record.id);
    return record;
  }

  async ensureRegistered(root: string, name?: string): Promise<WorkspaceRecord> {
    const existing = await this.getByRoot(root);
    if (existing) {
      return this.noteOpened(existing.id);
    }
    return this.create({ root, name: name ?? basename(normalizePath(root)) });
  }

  async noteOpened(workspaceId: string): Promise<WorkspaceRecord> {
    const workspaces = await this.list();
    const index = workspaces.findIndex((workspace) => workspace.id === workspaceId);
    if (index === -1) {
      throw new Error(`Unknown workspace: ${workspaceId}`);
    }
    const now = Date.now();
    const updated: WorkspaceRecord = {
      ...(workspaces[index] as WorkspaceRecord),
      lastOpenedAt: now,
      updatedAt: now,
    };
    workspaces[index] = updated;
    await this.save(workspaces);
    const profile = await this.profile();
    await this.saveProfile({
      ...profile,
      lastOpenedWorkspaceId: workspaceId,
      recentWorkspaceIds: [
        workspaceId,
        ...profile.recentWorkspaceIds.filter((id) => id !== workspaceId),
      ].slice(0, 12),
    });
    return updated;
  }

  async remove(workspaceId: string): Promise<void> {
    const workspaces = await this.list();
    if (!workspaces.some((workspace) => workspace.id === workspaceId)) {
      throw new Error(`Unknown workspace: ${workspaceId}`);
    }
    await this.save(workspaces.filter((workspace) => workspace.id !== workspaceId));
    const profile = await this.profile();
    await this.saveProfile({
      defaultWorkspaceId:
        profile.defaultWorkspaceId === workspaceId ? null : profile.defaultWorkspaceId,
      lastOpenedWorkspaceId:
        profile.lastOpenedWorkspaceId === workspaceId ? null : profile.lastOpenedWorkspaceId,
      recentWorkspaceIds: profile.recentWorkspaceIds.filter((id) => id !== workspaceId),
    });
  }

  async setDefault(workspaceId: string): Promise<void> {
    const profile = await this.profile();
    await this.saveProfile({ ...profile, defaultWorkspaceId: workspaceId });
  }

  async resolveStartupWorkspace(): Promise<WorkspaceRecord | null> {
    const [workspaces, profile] = await Promise.all([this.list(), this.profile()]);
    const nonStandalone = workspaces.filter((workspace) => workspace.kind !== "standalone-chat");
    const byId = (id: string | null): WorkspaceRecord | null =>
      id ? (nonStandalone.find((workspace) => workspace.id === id) ?? null) : null;
    return (
      byId(profile.defaultWorkspaceId) ??
      byId(profile.lastOpenedWorkspaceId) ??
      nonStandalone.sort((a, b) => b.lastOpenedAt - a.lastOpenedAt)[0] ??
      null
    );
  }
}
