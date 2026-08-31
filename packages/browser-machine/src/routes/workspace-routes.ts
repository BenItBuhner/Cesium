/**
 * `/api/workspaces/*` against the browser workspace registry, VFS, and
 * (from Phase 2) isomorphic-git. Response shapes mirror
 * `server/src/routes/workspaces.ts`.
 */
import type { GitWorkspaceStatus, WorkspaceRecord } from "@cesium/core";
import { errorResponse, jsonResponse, type EngineRequest, type EngineRouter } from "../http";
import { basename, normalizePath } from "../paths";
import type { Vfs } from "../vfs";
import type { WorkspaceStore } from "../stores/workspaces";
import {
  SessionStore,
  bumpRevision,
  formatEtag,
  getRevision,
  parseRevisionHeader,
  sessionRevisionKey,
  type PersistedWorkspaceSession,
} from "../stores/sessions";
import { readDoc, writeDoc } from "../stores/kv-docs";

export type WorkspaceWindowRecord = {
  id: string;
  name: string;
  createdAt: number;
  lastOpenedAt: number;
  closedAt: number | null;
};

export type GitStatusProvider = (
  workspace: WorkspaceRecord,
  workspaces: WorkspaceRecord[]
) => Promise<GitWorkspaceStatus>;

export type CloneProvider = (input: {
  repoUrl: string;
  parentPath: string;
  directoryName: string;
}) => Promise<string>;

export type GitInitProvider = (workspace: WorkspaceRecord) => Promise<GitWorkspaceStatus>;
export type GitSwitchProvider = (
  workspace: WorkspaceRecord,
  branch: string
) => Promise<GitWorkspaceStatus>;

export function fallbackGitStatus(workspace: WorkspaceRecord): GitWorkspaceStatus {
  return {
    isGitRepo: false,
    root: workspace.root,
    branches: [],
    worktrees: [],
  };
}

function windowsKey(workspaceId: string): string {
  return `workspace-windows:${workspaceId}`;
}

export function registerWorkspaceRoutes(
  router: EngineRouter,
  deps: {
    vfs: Vfs;
    workspaces: WorkspaceStore;
    sessions: SessionStore;
    gitStatus?: GitStatusProvider;
    gitInit?: GitInitProvider;
    gitSwitch?: GitSwitchProvider;
    clone?: CloneProvider;
    buildRepositoriesByWorkspace?: (
      workspaces: WorkspaceRecord[]
    ) => Promise<Record<string, unknown>>;
  }
): void {
  const { vfs, workspaces, sessions } = deps;

  async function workspaceListPayload(): Promise<Record<string, unknown>> {
    const [list, profile] = await Promise.all([workspaces.list(), workspaces.profile()]);
    return {
      workspaces: list,
      defaultWorkspaceId: profile.defaultWorkspaceId,
      recentWorkspaceIds: profile.recentWorkspaceIds,
      homeWorkspaceId: null,
    };
  }

  router.get("/api/workspaces/bootstrap", async () => {
    const [list, profile, startup] = await Promise.all([
      workspaces.list(),
      workspaces.profile(),
      workspaces.resolveStartupWorkspace(),
    ]);
    const repositoriesByWorkspaceId = deps.buildRepositoriesByWorkspace
      ? await deps.buildRepositoriesByWorkspace(list)
      : {};
    return jsonResponse({
      workspaces: list,
      defaultWorkspaceId: profile.defaultWorkspaceId,
      startupWorkspaceId: startup?.id ?? null,
      recentWorkspaceIds: profile.recentWorkspaceIds,
      repositoriesByWorkspaceId,
      homeWorkspaceId: null,
    });
  });

  router.get("/api/workspaces", async () => {
    const [list, profile] = await Promise.all([workspaces.list(), workspaces.profile()]);
    const repositoriesByWorkspaceId = deps.buildRepositoriesByWorkspace
      ? await deps.buildRepositoriesByWorkspace(list)
      : {};
    return jsonResponse({
      workspaces: list,
      defaultWorkspaceId: profile.defaultWorkspaceId,
      lastOpenedWorkspaceId: profile.lastOpenedWorkspaceId,
      recentWorkspaceIds: profile.recentWorkspaceIds,
      repositoriesByWorkspaceId,
      homeWorkspaceId: null,
    });
  });

  router.post("/api/workspaces/open", async (request) => {
    const body = await request.json<{
      workspaceId?: string;
      root?: string;
      name?: string;
      trackRecent?: boolean;
    }>();
    if (!body.workspaceId && !body.root) {
      return errorResponse("Expected workspaceId or root");
    }
    let workspace: WorkspaceRecord | null = null;
    try {
      if (body.workspaceId) {
        workspace = await workspaces.getById(body.workspaceId);
        if (!workspace) {
          return errorResponse(`Unknown workspace: ${body.workspaceId}`, 404);
        }
        if (body.trackRecent) {
          workspace = await workspaces.noteOpened(workspace.id);
        }
      } else if (body.root) {
        workspace = await workspaces.ensureRegistered(body.root, body.name);
      }
    } catch (error) {
      return errorResponse(error instanceof Error ? error.message : "Workspace open failed.");
    }
    return jsonResponse({ workspace, ...(await workspaceListPayload()) });
  });

  router.post("/api/workspaces/activity", async (request) => {
    const body = await request.json<{ workspaceId?: string }>();
    if (!body.workspaceId) {
      return errorResponse("Expected workspaceId");
    }
    const workspace = await workspaces.getById(body.workspaceId);
    if (!workspace) {
      return errorResponse(`Unknown workspace: ${body.workspaceId}`, 404);
    }
    const updated = await workspaces.noteOpened(workspace.id);
    return jsonResponse({ ok: true, workspace: updated, ...(await workspaceListPayload()) });
  });

  router.post("/api/workspaces/create", async (request) => {
    const body = await request.json<{
      name?: string;
      parentPath?: string;
      directoryName?: string;
      setDefault?: boolean;
    }>();
    if (!body.directoryName) {
      return errorResponse("Expected parentPath and directoryName");
    }
    try {
      const workspace = await workspaces.create({
        name: body.name,
        directoryName: body.directoryName,
      });
      if (body.setDefault) {
        await workspaces.setDefault(workspace.id);
      }
      return jsonResponse({ workspace, ...(await workspaceListPayload()) }, 201);
    } catch (error) {
      return errorResponse(
        error instanceof Error ? error.message : "Workspace creation failed."
      );
    }
  });

  router.get("/api/workspaces/browse", async (request) => {
    const rawPath = request.url.searchParams.get("path")?.trim() ?? "";
    const target = rawPath ? normalizePath(rawPath) : "/workspaces";
    if (!vfs.exists(target)) {
      return jsonResponse({
        path: target,
        parentPath: target === "/" ? null : normalizePath(`${target}/..`),
        directories: [],
        homeWorkspaceId: null,
      });
    }
    const directories = vfs
      .listChildren(target)
      .filter((record) => record.type === "dir")
      .map((record) => ({ name: basename(record.path), path: record.path }))
      .sort((a, b) => a.name.localeCompare(b.name));
    if (!rawPath) {
      return jsonResponse({
        roots: [{ name: "Browser workspaces", path: "/workspaces", kind: "folder" }],
        homeWorkspaceId: null,
      });
    }
    return jsonResponse({
      path: target,
      parentPath: target === "/" ? null : normalizePath(`${target}/..`),
      directories,
      homeWorkspaceId: null,
    });
  });

  router.post("/api/workspaces/clone", async (request) => {
    const body = await request.json<{
      repoUrl?: string;
      parentPath?: string;
      directoryName?: string;
      name?: string;
      setDefault?: boolean;
    }>();
    if (!body.repoUrl?.trim()) {
      return errorResponse("Expected repoUrl");
    }
    if (!deps.clone) {
      return errorResponse("Cloning is not available on this browser machine yet.", 400);
    }
    try {
      const root = await deps.clone({
        repoUrl: body.repoUrl.trim(),
        parentPath: body.parentPath?.trim() || "/workspaces",
        directoryName: body.directoryName?.trim() ?? "",
      });
      const workspace = await workspaces.ensureRegistered(root, body.name);
      if (body.setDefault) {
        await workspaces.setDefault(workspace.id);
      }
      return jsonResponse({ workspace, ...(await workspaceListPayload()) }, 201);
    } catch (error) {
      return errorResponse(error instanceof Error ? error.message : "Clone failed.");
    }
  });

  router.delete("/api/workspaces/:workspaceId", async (request) => {
    const workspaceId = request.params.workspaceId ?? "";
    try {
      await workspaces.remove(workspaceId);
    } catch (error) {
      const message = error instanceof Error ? error.message : "Delete failed.";
      return errorResponse(message, message.startsWith("Unknown workspace") ? 404 : 400);
    }
    return jsonResponse({
      ok: true,
      deletedWorkspaceId: workspaceId,
      ...(await workspaceListPayload()),
    });
  });

  router.patch("/api/workspaces/default", async (request) => {
    const body = await request.json<{ workspaceId?: string }>();
    if (!body.workspaceId) {
      return errorResponse("Expected workspaceId");
    }
    await workspaces.setDefault(body.workspaceId);
    const profile = await workspaces.profile();
    return jsonResponse({ ok: true, defaultWorkspaceId: profile.defaultWorkspaceId });
  });

  router.get("/api/workspaces/:workspaceId/git/status", async (request) => {
    const workspaceId = request.params.workspaceId ?? "";
    const workspace = await workspaces.getById(workspaceId);
    if (!workspace) {
      return errorResponse(`Unknown workspace: ${workspaceId}`, 404);
    }
    const list = await workspaces.list();
    const status = deps.gitStatus
      ? await deps.gitStatus(workspace, list)
      : fallbackGitStatus(workspace);
    return jsonResponse({ workspace, status });
  });

  router.post("/api/workspaces/:workspaceId/git/init", async (request) => {
    const workspaceId = request.params.workspaceId ?? "";
    const workspace = await workspaces.getById(workspaceId);
    if (!workspace) {
      return errorResponse(`Unknown workspace: ${workspaceId}`, 404);
    }
    if (!deps.gitInit) {
      return errorResponse("Git is not available on this browser machine yet.");
    }
    try {
      const status = await deps.gitInit(workspace);
      return jsonResponse({ ok: true, workspace, status });
    } catch (error) {
      return errorResponse(error instanceof Error ? error.message : "Git init failed.");
    }
  });

  router.post("/api/workspaces/:workspaceId/git/switch", async (request) => {
    const workspaceId = request.params.workspaceId ?? "";
    const body = await request.json<{ branch?: string }>();
    const workspace = await workspaces.getById(workspaceId);
    if (!workspace) {
      return errorResponse(`Unknown workspace: ${workspaceId}`, 404);
    }
    if (!body.branch?.trim()) {
      return errorResponse("Expected branch");
    }
    if (!deps.gitSwitch) {
      return errorResponse("Git is not available on this browser machine yet.");
    }
    try {
      const status = await deps.gitSwitch(workspace, body.branch.trim());
      return jsonResponse({ ok: true, workspace, status });
    } catch (error) {
      return errorResponse(error instanceof Error ? error.message : "Branch switch failed.");
    }
  });

  router.get("/api/workspaces/:workspaceId/insights", async (request) => {
    const workspaceId = request.params.workspaceId ?? "";
    const workspace = await workspaces.getById(workspaceId);
    if (!workspace) {
      return errorResponse(`Unknown workspace: ${workspaceId}`, 404);
    }
    const list = await workspaces.list();
    const status = deps.gitStatus
      ? await deps.gitStatus(workspace, list).catch(() => fallbackGitStatus(workspace))
      : fallbackGitStatus(workspace);
    return jsonResponse({
      insights: {
        isGitRepo: status.isGitRepo,
        branch: status.currentBranch ?? null,
        detached: status.detached ?? false,
        dirty: status.dirty ?? false,
        ahead: status.aheadBehind?.ahead ?? 0,
        behind: status.aheadBehind?.behind ?? 0,
        hasUpstream: false,
        diff: { files: [], totalAdded: 0, totalRemoved: 0, fileCount: 0, truncated: false },
        merge: { state: "none", conflictedFiles: [], conflictsResolved: false },
        work: { runningConversations: 0, runningConversationTitles: [], runningConversationIds: [] },
      },
    });
  });

  async function readSession(request: EngineRequest): Promise<Response> {
    const workspaceId = request.params.workspaceId ?? "";
    const windowId = request.url.searchParams.get("windowId")?.trim() || null;
    const workspace = await workspaces.getById(workspaceId);
    if (!workspace) {
      return errorResponse(`Unknown workspace: ${workspaceId}`, 404);
    }
    const revisionKey = sessionRevisionKey(workspaceId, windowId);
    const revision = getRevision(revisionKey);
    const etag = formatEtag(revision);
    const ifNoneMatch = parseRevisionHeader(request.headers.get("if-none-match"));
    if (ifNoneMatch && ifNoneMatch.value === revision) {
      return new Response(null, { status: 304, headers: { ETag: etag } });
    }
    const session = await sessions.get(workspaceId, windowId);
    if (windowId) {
      const windows = (await readDoc<WorkspaceWindowRecord[]>(windowsKey(workspaceId))) ?? [];
      const windowRecord = windows.find((entry) => entry.id === windowId);
      if (!windowRecord) {
        return errorResponse(`Unknown workspace window: ${windowId}`, 404);
      }
      return jsonResponse(
        { workspace, window: windowRecord, session, revision },
        200,
        { ETag: etag }
      );
    }
    return jsonResponse({ workspace, session, revision }, 200, { ETag: etag });
  }

  router.get("/api/workspaces/:workspaceId/session", readSession);

  router.put("/api/workspaces/:workspaceId/session", async (request) => {
    const workspaceId = request.params.workspaceId ?? "";
    const windowId = request.url.searchParams.get("windowId")?.trim() || null;
    const workspace = await workspaces.getById(workspaceId);
    if (!workspace) {
      return errorResponse(`Unknown workspace: ${workspaceId}`, 404);
    }
    const rawBody = await request.text();
    if (!rawBody.trim()) {
      return jsonResponse({ ok: true, skipped: true });
    }
    const body = JSON.parse(rawBody) as PersistedWorkspaceSession;
    const nextSession: PersistedWorkspaceSession = {
      schemaVersion: 1,
      editor: body.editor,
      chat: body.chat,
      explorer: body.explorer,
      layout: body.layout,
      agentView: body.agentView,
      settingsView: body.settingsView,
    };
    const ifMatch = parseRevisionHeader(request.headers.get("if-match"));
    const revisionKey = sessionRevisionKey(workspaceId, windowId);
    if (ifMatch) {
      const current = getRevision(revisionKey);
      if (ifMatch.value !== current) {
        return jsonResponse(
          {
            error: "Revision mismatch",
            expectedRevision: ifMatch.value,
            actualRevision: current,
          },
          412,
          { ETag: formatEtag(current) }
        );
      }
    }
    await sessions.save(workspaceId, windowId, nextSession);
    const nextRevision = bumpRevision(revisionKey);
    return jsonResponse({ ok: true, revision: nextRevision }, 200, {
      ETag: formatEtag(nextRevision),
    });
  });

  router.get("/api/workspaces/:workspaceId/windows", async (request) => {
    const workspaceId = request.params.workspaceId ?? "";
    const workspace = await workspaces.getById(workspaceId);
    if (!workspace) {
      return errorResponse(`Unknown workspace: ${workspaceId}`, 404);
    }
    const windows = (await readDoc<WorkspaceWindowRecord[]>(windowsKey(workspaceId))) ?? [];
    return jsonResponse({ workspace, windows });
  });

  router.post("/api/workspaces/:workspaceId/windows", async (request) => {
    const workspaceId = request.params.workspaceId ?? "";
    const workspace = await workspaces.getById(workspaceId);
    if (!workspace) {
      return errorResponse(`Unknown workspace: ${workspaceId}`, 404);
    }
    const body = await request.json<{ name?: string }>().catch(() => ({}) as { name?: string });
    const now = Date.now();
    const windowRecord: WorkspaceWindowRecord = {
      id: crypto.randomUUID(),
      name: body.name?.trim() || `Window ${now}`,
      createdAt: now,
      lastOpenedAt: now,
      closedAt: null,
    };
    const windows = (await readDoc<WorkspaceWindowRecord[]>(windowsKey(workspaceId))) ?? [];
    const next = [...windows, windowRecord];
    await writeDoc(windowsKey(workspaceId), next);
    return jsonResponse({ workspace, window: windowRecord, windows: next }, 201);
  });

  router.patch("/api/workspaces/:workspaceId/windows/:windowId", async (request) => {
    const workspaceId = request.params.workspaceId ?? "";
    const windowId = request.params.windowId ?? "";
    const workspace = await workspaces.getById(workspaceId);
    if (!workspace) {
      return errorResponse(`Unknown workspace: ${workspaceId}`, 404);
    }
    const body = await request
      .json<{ name?: string; lastOpenedAt?: number; markClosed?: boolean }>()
      .catch(() => ({}) as { name?: string; lastOpenedAt?: number; markClosed?: boolean });
    const windows = (await readDoc<WorkspaceWindowRecord[]>(windowsKey(workspaceId))) ?? [];
    const index = windows.findIndex((entry) => entry.id === windowId);
    if (index === -1) {
      return errorResponse(`Unknown workspace window: ${windowId}`, 404);
    }
    const current = windows[index] as WorkspaceWindowRecord;
    const updated: WorkspaceWindowRecord = {
      ...current,
      name: body.name?.trim() || current.name,
      lastOpenedAt:
        typeof body.lastOpenedAt === "number" && Number.isFinite(body.lastOpenedAt)
          ? body.lastOpenedAt
          : current.lastOpenedAt,
      closedAt: body.markClosed === true ? Date.now() : current.closedAt,
    };
    windows[index] = updated;
    await writeDoc(windowsKey(workspaceId), windows);
    return jsonResponse({ workspace, window: updated, windows });
  });
}
