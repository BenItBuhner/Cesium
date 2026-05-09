import path from "node:path";
import { Hono } from "hono";
import { resolveRepoRootFromProcessCwd } from "../lib/persistence.js";
import { cloneGitRepository } from "../lib/git-workspace.js";
import {
  createWorkspaceWorktree,
  deleteWorkspaceWorktree,
  getGitWorkspaceStatus,
  switchWorkspaceBranch,
} from "../lib/git-worktrees.js";
import { listBrowseDirectories, listBrowseRoots } from "../lib/workspace-browse.js";
import {
  createWorkspace,
  ensureHomeWorkspace,
  ensureInitialWorkspace,
  ensureWorkspaceRegistered,
  getHomeWorkspace,
  getWorkspaceById,
  getWorkspaceProfile,
  listWorkspaces,
  noteWorkspaceOpened,
  removeWorkspace,
  resolveStartupWorkspace,
  setDefaultWorkspace,
} from "../lib/workspace-registry.js";
import {
  getWorkspaceSession,
  listWorkspaceWindows,
  createWorkspaceWindow,
  updateWorkspaceWindow,
  getWorkspaceWindow,
  getWorkspaceWindowSession,
  saveWorkspaceSession,
  saveWorkspaceWindowSession,
  type PersistedWorkspaceSession,
} from "../lib/workspace-session-store.js";
import { WriteCoalescer } from "../storage/coalesce.js";
import {
  bumpRevision,
  formatEtag,
  getRevision,
  parseRevisionHeader,
} from "../storage/revisions.js";
import { setShortCache } from "../lib/cache-headers.js";

export const workspaceRoutes = new Hono();

function sessionRevisionKey(
  workspaceId: string,
  windowId: string | null
): string {
  return windowId
    ? `workspace:${workspaceId}:window:${windowId}`
    : `workspace:${workspaceId}`;
}

// Session writes are chatty (every UI layout change triggers one). Coalesce
// them on a 50ms idle window so bursts collapse into a single persisted
// snapshot. Keys:
//   - `workspace:<workspaceId>`                   - default session
//   - `workspace:<workspaceId>:window:<windowId>` - per-window session
const sessionCoalescer = new WriteCoalescer<{
  workspaceId: string;
  windowId: string | null;
  session: PersistedWorkspaceSession;
}>(async (_key, { workspaceId, windowId, session }) => {
  if (windowId) {
    await saveWorkspaceWindowSession(workspaceId, windowId, session);
    return;
  }
  await saveWorkspaceSession(workspaceId, session);
}, 50);

function resolveInitialWorkspaceRoot(): string {
  const configuredRoot = process.env.WORKSPACE_ROOT?.trim();
  if (configuredRoot) {
    return path.resolve(configuredRoot);
  }

  return resolveRepoRootFromProcessCwd();
}

async function homeWorkspaceIdPayload(): Promise<{ homeWorkspaceId: string | null }> {
  const home = await getHomeWorkspace();
  return { homeWorkspaceId: home?.id ?? null };
}

workspaceRoutes.get("/api/workspaces/bootstrap", async (c) => {
  await ensureInitialWorkspace(resolveInitialWorkspaceRoot());
  const [workspaces, profile, startupWorkspace, homePayload] = await Promise.all([
    listWorkspaces(),
    getWorkspaceProfile(),
    resolveStartupWorkspace(),
    homeWorkspaceIdPayload(),
  ]);

  setShortCache(c, { maxAgeSec: 5, swr: 30 });
  return c.json({
    workspaces,
    defaultWorkspaceId: profile.defaultWorkspaceId,
    startupWorkspaceId: startupWorkspace?.id ?? null,
    recentWorkspaceIds: profile.recentWorkspaceIds,
    ...homePayload,
  });
});

workspaceRoutes.get("/api/workspaces", async (c) => {
  await ensureHomeWorkspace();
  const [workspaces, profile, homePayload] = await Promise.all([
    listWorkspaces(),
    getWorkspaceProfile(),
    homeWorkspaceIdPayload(),
  ]);
  setShortCache(c, { maxAgeSec: 5, swr: 30 });
  return c.json({
    workspaces,
    defaultWorkspaceId: profile.defaultWorkspaceId,
    lastOpenedWorkspaceId: profile.lastOpenedWorkspaceId,
    recentWorkspaceIds: profile.recentWorkspaceIds,
    ...homePayload,
  });
});

workspaceRoutes.post("/api/workspaces/open", async (c) => {
  const body = await c.req.json<{
    workspaceId?: string;
    root?: string;
    name?: string;
    trackRecent?: boolean;
  }>();
  if (!body.workspaceId && !body.root) {
    return c.json({ error: "Expected workspaceId or root" }, 400);
  }

  let workspace = null;
  if (body.workspaceId) {
    workspace = await getWorkspaceById(body.workspaceId);
    if (!workspace) {
      return c.json({ error: `Unknown workspace: ${body.workspaceId}` }, 404);
    }
    if (body.trackRecent) {
      await noteWorkspaceOpened(workspace.id);
    }
  } else if (body.root) {
    workspace = await ensureWorkspaceRegistered(body.root, body.name);
  }

  const [workspaces, profile, homePayload] = await Promise.all([
    listWorkspaces(),
    getWorkspaceProfile(),
    homeWorkspaceIdPayload(),
  ]);

  return c.json({
    workspace,
    workspaces,
    defaultWorkspaceId: profile.defaultWorkspaceId,
    recentWorkspaceIds: profile.recentWorkspaceIds,
    ...homePayload,
  });
});

workspaceRoutes.post("/api/workspaces/activity", async (c) => {
  const body = await c.req.json<{ workspaceId?: string }>();
  if (!body.workspaceId) {
    return c.json({ error: "Expected workspaceId" }, 400);
  }

  const workspace = await getWorkspaceById(body.workspaceId);
  if (!workspace) {
    return c.json({ error: `Unknown workspace: ${body.workspaceId}` }, 404);
  }

  await noteWorkspaceOpened(workspace.id);
  const [workspaces, profile, homePayload] = await Promise.all([
    listWorkspaces(),
    getWorkspaceProfile(),
    homeWorkspaceIdPayload(),
  ]);

  return c.json({
    ok: true,
    workspace,
    workspaces,
    defaultWorkspaceId: profile.defaultWorkspaceId,
    recentWorkspaceIds: profile.recentWorkspaceIds,
    ...homePayload,
  });
});

workspaceRoutes.post("/api/workspaces/create", async (c) => {
  const body = await c.req.json<{
    name?: string;
    parentPath?: string;
    directoryName?: string;
    setDefault?: boolean;
  }>();

  if (!body.parentPath || !body.directoryName) {
    return c.json({ error: "Expected parentPath and directoryName" }, 400);
  }

  const workspace = await createWorkspace(
    body.parentPath,
    body.directoryName,
    body.name
  );
  if (body.setDefault) {
    await setDefaultWorkspace(workspace.id);
  }

  const [workspaces, profile, homePayload] = await Promise.all([
    listWorkspaces(),
    getWorkspaceProfile(),
    homeWorkspaceIdPayload(),
  ]);

  return c.json(
    {
      workspace,
      workspaces,
      defaultWorkspaceId: profile.defaultWorkspaceId,
      recentWorkspaceIds: profile.recentWorkspaceIds,
      ...homePayload,
    },
    201
  );
});

workspaceRoutes.get("/api/workspaces/browse", async (c) => {
  const rawPath = c.req.query("path")?.trim() ?? "";
  try {
    if (!rawPath) {
      const roots = await listBrowseRoots();
      return c.json({
        roots,
        homeWorkspaceId: (await getHomeWorkspace())?.id ?? null,
      });
    }
    const listing = await listBrowseDirectories(rawPath);
    return c.json({
      ...listing,
      homeWorkspaceId: (await getHomeWorkspace())?.id ?? null,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Browse failed.";
    return c.json({ error: message }, 400);
  }
});

workspaceRoutes.post("/api/workspaces/clone", async (c) => {
  const body = await c.req.json<{
    repoUrl?: string;
    parentPath?: string;
    directoryName?: string;
    name?: string;
    setDefault?: boolean;
  }>();

  if (!body.repoUrl?.trim()) {
    return c.json({ error: "Expected repoUrl" }, 400);
  }
  if (!body.parentPath?.trim()) {
    return c.json({ error: "Expected parentPath" }, 400);
  }

  try {
    const root = await cloneGitRepository({
      repoUrl: body.repoUrl,
      parentPath: body.parentPath,
      directoryName: body.directoryName?.trim() ?? "",
    });
    const workspace = await ensureWorkspaceRegistered(root, body.name);
    if (body.setDefault) {
      await setDefaultWorkspace(workspace.id);
    }
    const [workspaces, profile, homePayload] = await Promise.all([
      listWorkspaces(),
      getWorkspaceProfile(),
      homeWorkspaceIdPayload(),
    ]);
    return c.json(
      {
        workspace,
        workspaces,
        defaultWorkspaceId: profile.defaultWorkspaceId,
        recentWorkspaceIds: profile.recentWorkspaceIds,
        ...homePayload,
      },
      201
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : "Clone failed.";
    return c.json({ error: message }, 400);
  }
});

workspaceRoutes.delete("/api/workspaces/:workspaceId", async (c) => {
  const workspaceId = c.req.param("workspaceId");
  try {
    await removeWorkspace(workspaceId);
  } catch (error) {
    const message = error instanceof Error ? error.message : "Delete failed.";
    const status = message.startsWith("Unknown workspace") ? 404 : 400;
    return c.json({ error: message }, status);
  }

  const [workspaces, profile, homePayload] = await Promise.all([
    listWorkspaces(),
    getWorkspaceProfile(),
    homeWorkspaceIdPayload(),
  ]);

  return c.json({
    ok: true,
    deletedWorkspaceId: workspaceId,
    workspaces,
    defaultWorkspaceId: profile.defaultWorkspaceId,
    recentWorkspaceIds: profile.recentWorkspaceIds,
    ...homePayload,
  });
});

workspaceRoutes.patch("/api/workspaces/default", async (c) => {
  const body = await c.req.json<{ workspaceId?: string }>();
  if (!body.workspaceId) {
    return c.json({ error: "Expected workspaceId" }, 400);
  }

  await setDefaultWorkspace(body.workspaceId);
  const profile = await getWorkspaceProfile();
  return c.json({ ok: true, defaultWorkspaceId: profile.defaultWorkspaceId });
});

workspaceRoutes.get("/api/workspaces/:workspaceId/git/status", async (c) => {
  const workspaceId = c.req.param("workspaceId");
  const workspace = await getWorkspaceById(workspaceId);
  if (!workspace) {
    return c.json({ error: `Unknown workspace: ${workspaceId}` }, 404);
  }

  const workspaces = await listWorkspaces();
  const status = await getGitWorkspaceStatus(workspace, workspaces);
  return c.json({ workspace, status });
});

workspaceRoutes.post("/api/workspaces/:workspaceId/git/switch", async (c) => {
  const workspaceId = c.req.param("workspaceId");
  const body = await c.req.json<{ branch?: string }>();
  const workspace = await getWorkspaceById(workspaceId);
  if (!workspace) {
    return c.json({ error: `Unknown workspace: ${workspaceId}` }, 404);
  }
  if (!body.branch?.trim()) {
    return c.json({ error: "Expected branch" }, 400);
  }

  try {
    const workspaces = await listWorkspaces();
    const result = await switchWorkspaceBranch({
      workspace,
      workspaces,
      branch: body.branch,
    });
    if (result.checkedOutWorktree) {
      const openedWorkspace = await ensureWorkspaceRegistered(
        result.checkedOutWorktree.path,
        result.checkedOutWorktree.workspaceName ?? result.checkedOutWorktree.branch ?? undefined
      );
      return c.json({
        ok: true,
        openedWorkspace,
        checkedOutWorktree: {
          ...result.checkedOutWorktree,
          workspaceId: openedWorkspace.id,
          workspaceName: openedWorkspace.name,
        },
        status: result.status,
      });
    }
    return c.json({ ok: true, workspace, status: result.status });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Branch switch failed.";
    return c.json({ error: message }, 400);
  }
});

workspaceRoutes.post("/api/workspaces/:workspaceId/git/worktrees", async (c) => {
  const workspaceId = c.req.param("workspaceId");
  const body = await c.req.json<{
    branch?: string;
    baseBranch?: string;
    newBranch?: boolean;
    targetPath?: string;
    runSetup?: boolean;
    name?: string;
  }>();
  const workspace = await getWorkspaceById(workspaceId);
  if (!workspace) {
    return c.json({ error: `Unknown workspace: ${workspaceId}` }, 404);
  }
  if (!body.branch?.trim()) {
    return c.json({ error: "Expected branch" }, 400);
  }

  try {
    const workspaces = await listWorkspaces();
    const created = await createWorkspaceWorktree({
      workspace,
      workspaces,
      branch: body.branch,
      baseBranch: body.baseBranch,
      newBranch: body.newBranch,
      targetPath: body.targetPath,
      runSetup: body.runSetup,
    });
    const openedWorkspace = await ensureWorkspaceRegistered(
      created.path,
      body.name?.trim() || created.branch
    );
    const [nextWorkspaces, profile, homePayload] = await Promise.all([
      listWorkspaces(),
      getWorkspaceProfile(),
      homeWorkspaceIdPayload(),
    ]);
    return c.json(
      {
        ok: true,
        workspace: openedWorkspace,
        workspaces: nextWorkspaces,
        defaultWorkspaceId: profile.defaultWorkspaceId,
        recentWorkspaceIds: profile.recentWorkspaceIds,
        ...homePayload,
        worktree: {
          path: created.path,
          branch: created.branch,
          existing: Boolean(created.existingWorktree),
        },
        setup: created.setup,
      },
      created.existingWorktree ? 200 : 201
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : "Worktree creation failed.";
    return c.json({ error: message }, 400);
  }
});

workspaceRoutes.delete("/api/workspaces/:workspaceId/git/worktrees", async (c) => {
  const workspaceId = c.req.param("workspaceId");
  const body: { path?: string; force?: boolean } = await c.req
    .json<{ path?: string; force?: boolean }>()
    .catch(() => ({}));
  const workspace = await getWorkspaceById(workspaceId);
  if (!workspace) {
    return c.json({ error: `Unknown workspace: ${workspaceId}` }, 404);
  }
  if (!body.path?.trim()) {
    return c.json({ error: "Expected path" }, 400);
  }

  try {
    const workspaces = await listWorkspaces();
    await deleteWorkspaceWorktree({
      workspace,
      workspaces,
      targetPath: body.path,
      force: body.force,
    });
    const targetWorkspace = workspaces.find((item) => item.root === body.path);
    if (targetWorkspace) {
      await removeWorkspace(targetWorkspace.id);
    }
    const [nextWorkspaces, profile, homePayload] = await Promise.all([
      listWorkspaces(),
      getWorkspaceProfile(),
      homeWorkspaceIdPayload(),
    ]);
    return c.json({
      ok: true,
      workspaces: nextWorkspaces,
      defaultWorkspaceId: profile.defaultWorkspaceId,
      recentWorkspaceIds: profile.recentWorkspaceIds,
      ...homePayload,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Worktree deletion failed.";
    return c.json({ error: message }, 400);
  }
});

workspaceRoutes.get("/api/workspaces/:workspaceId/session", async (c) => {
  const workspaceId = c.req.param("workspaceId");
  const windowId = c.req.query("windowId")?.trim() || null;
  const workspace = await getWorkspaceById(workspaceId);
  if (!workspace) {
    return c.json({ error: `Unknown workspace: ${workspaceId}` }, 404);
  }

  const revisionKey = sessionRevisionKey(workspaceId, windowId);
  const revision = getRevision(revisionKey);
  const etag = formatEtag(revision);
  const ifNoneMatch = parseRevisionHeader(c.req.header("if-none-match"));

  if (windowId) {
    const windowRecord = await getWorkspaceWindow(workspaceId, windowId);
    if (!windowRecord) {
      return c.json({ error: `Unknown workspace window: ${windowId}` }, 404);
    }
    if (ifNoneMatch && ifNoneMatch.value === revision) {
      c.header("ETag", etag);
      return c.body(null, 304);
    }
    const session = await getWorkspaceWindowSession(workspaceId, windowId);
    c.header("ETag", etag);
    return c.json({ workspace, window: windowRecord, session, revision });
  }

  if (ifNoneMatch && ifNoneMatch.value === revision) {
    c.header("ETag", etag);
    return c.body(null, 304);
  }
  const session = await getWorkspaceSession(workspaceId);
  c.header("ETag", etag);
  return c.json({ workspace, session, revision });
});

workspaceRoutes.put("/api/workspaces/:workspaceId/session", async (c) => {
  const workspaceId = c.req.param("workspaceId");
  const windowId = c.req.query("windowId")?.trim() || null;
  const workspace = await getWorkspaceById(workspaceId);
  if (!workspace) {
    return c.json({ error: `Unknown workspace: ${workspaceId}` }, 404);
  }

  const rawBody = await c.req.text();
  if (!rawBody.trim()) {
    return c.json({ ok: true, skipped: true });
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
  // Optimistic concurrency: clients may send `If-Match: W/"<rev>"` to assert
  // they are updating the revision they last observed. A mismatch returns 412
  // so the caller can re-fetch and retry rather than trampling concurrent
  // writers (e.g. two browser tabs persisting layout changes simultaneously).
  const ifMatch = parseRevisionHeader(c.req.header("if-match"));
  const revisionKey = sessionRevisionKey(workspaceId, windowId);
  if (ifMatch) {
    const current = getRevision(revisionKey);
    if (ifMatch.value !== current) {
      c.header("ETag", formatEtag(current));
      return c.json(
        {
          error: "Revision mismatch",
          expectedRevision: ifMatch.value,
          actualRevision: current,
        },
        412
      );
    }
  }

  if (windowId) {
    const windowRecord = await getWorkspaceWindow(workspaceId, windowId);
    if (!windowRecord) {
      return c.json({ error: `Unknown workspace window: ${windowId}` }, 404);
    }
    if (process.env.NODE_ENV === "test") {
      await saveWorkspaceWindowSession(workspaceId, windowId, nextSession);
    } else {
      sessionCoalescer.schedule(
        `workspace:${workspaceId}:window:${windowId}`,
        { workspaceId, windowId, session: nextSession }
      );
    }
    const nextRevision = bumpRevision(revisionKey);
    c.header("ETag", formatEtag(nextRevision));
    return c.json({ ok: true, revision: nextRevision });
  }
  if (process.env.NODE_ENV === "test") {
    await saveWorkspaceSession(workspaceId, nextSession);
  } else {
    sessionCoalescer.schedule(`workspace:${workspaceId}`, {
      workspaceId,
      windowId: null,
      session: nextSession,
    });
  }
  const nextRevision = bumpRevision(revisionKey);
  c.header("ETag", formatEtag(nextRevision));
  return c.json({ ok: true, revision: nextRevision });
});

workspaceRoutes.get("/api/workspaces/:workspaceId/windows", async (c) => {
  const workspaceId = c.req.param("workspaceId");
  const workspace = await getWorkspaceById(workspaceId);
  if (!workspace) {
    return c.json({ error: `Unknown workspace: ${workspaceId}` }, 404);
  }
  const windows = await listWorkspaceWindows(workspaceId);
  return c.json({ workspace, windows });
});

workspaceRoutes.post("/api/workspaces/:workspaceId/windows", async (c) => {
  const workspaceId = c.req.param("workspaceId");
  const workspace = await getWorkspaceById(workspaceId);
  if (!workspace) {
    return c.json({ error: `Unknown workspace: ${workspaceId}` }, 404);
  }

  const body: { name?: string } = await c.req.json<{ name?: string }>().catch(() => ({}));
  const windowRecord = await createWorkspaceWindow(workspaceId, {
    name:
      typeof body.name === "string" && body.name.trim().length > 0
        ? body.name.trim()
        : undefined,
  });
  const windows = await listWorkspaceWindows(workspaceId);
  return c.json({ workspace, window: windowRecord, windows }, 201);
});

workspaceRoutes.patch("/api/workspaces/:workspaceId/windows/:windowId", async (c) => {
  const workspaceId = c.req.param("workspaceId");
  const windowId = c.req.param("windowId");
  const workspace = await getWorkspaceById(workspaceId);
  if (!workspace) {
    return c.json({ error: `Unknown workspace: ${workspaceId}` }, 404);
  }

  const body: { name?: string; lastOpenedAt?: number; markClosed?: boolean } =
    await c.req
      .json<{ name?: string; lastOpenedAt?: number; markClosed?: boolean }>()
      .catch(() => ({}));
  const windowRecord = await updateWorkspaceWindow(workspaceId, windowId, {
    name:
      typeof body.name === "string" && body.name.trim().length > 0
        ? body.name.trim()
        : undefined,
    lastOpenedAt:
      typeof body.lastOpenedAt === "number" && Number.isFinite(body.lastOpenedAt)
        ? body.lastOpenedAt
        : undefined,
    markClosed: body.markClosed === true,
  });
  if (!windowRecord) {
    return c.json({ error: `Unknown workspace window: ${windowId}` }, 404);
  }
  const windows = await listWorkspaceWindows(workspaceId);
  return c.json({ workspace, window: windowRecord, windows });
});
