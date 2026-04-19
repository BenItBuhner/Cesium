import path from "node:path";
import { Hono } from "hono";
import { resolveRepoRootFromProcessCwd } from "../lib/persistence.js";
import {
  createWorkspace,
  ensureHomeWorkspace,
  ensureInitialWorkspace,
  ensureWorkspaceRegistered,
  getWorkspaceById,
  getWorkspaceProfile,
  listWorkspaces,
  noteWorkspaceOpened,
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

workspaceRoutes.get("/api/workspaces/bootstrap", async (c) => {
  await ensureInitialWorkspace(resolveInitialWorkspaceRoot());
  const [workspaces, profile, startupWorkspace] = await Promise.all([
    listWorkspaces(),
    getWorkspaceProfile(),
    resolveStartupWorkspace(),
  ]);

  setShortCache(c, { maxAgeSec: 5, swr: 30 });
  return c.json({
    workspaces,
    defaultWorkspaceId: profile.defaultWorkspaceId,
    startupWorkspaceId: startupWorkspace?.id ?? null,
    recentWorkspaceIds: profile.recentWorkspaceIds,
  });
});

workspaceRoutes.get("/api/workspaces", async (c) => {
  await ensureHomeWorkspace();
  const [workspaces, profile] = await Promise.all([
    listWorkspaces(),
    getWorkspaceProfile(),
  ]);
  setShortCache(c, { maxAgeSec: 5, swr: 30 });
  return c.json({
    workspaces,
    defaultWorkspaceId: profile.defaultWorkspaceId,
    lastOpenedWorkspaceId: profile.lastOpenedWorkspaceId,
    recentWorkspaceIds: profile.recentWorkspaceIds,
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

  const [workspaces, profile] = await Promise.all([
    listWorkspaces(),
    getWorkspaceProfile(),
  ]);

  return c.json({
    workspace,
    workspaces,
    defaultWorkspaceId: profile.defaultWorkspaceId,
    recentWorkspaceIds: profile.recentWorkspaceIds,
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
  const [workspaces, profile] = await Promise.all([
    listWorkspaces(),
    getWorkspaceProfile(),
  ]);

  return c.json({
    ok: true,
    workspace,
    workspaces,
    defaultWorkspaceId: profile.defaultWorkspaceId,
    recentWorkspaceIds: profile.recentWorkspaceIds,
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

  const [workspaces, profile] = await Promise.all([
    listWorkspaces(),
    getWorkspaceProfile(),
  ]);

  return c.json(
    {
      workspace,
      workspaces,
      defaultWorkspaceId: profile.defaultWorkspaceId,
      recentWorkspaceIds: profile.recentWorkspaceIds,
    },
    201
  );
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
