import path from "node:path";
import { Hono } from "hono";
import {
  createWorkspace,
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
  saveWorkspaceSession,
  type PersistedWorkspaceSession,
} from "../lib/workspace-session-store.js";

export const workspaceRoutes = new Hono();

function resolveInitialWorkspaceRoot(): string {
  const configuredRoot = process.env.WORKSPACE_ROOT?.trim();
  if (configuredRoot) {
    return path.resolve(configuredRoot);
  }

  const cwd = process.cwd();
  if (path.basename(cwd).toLowerCase() === "server") {
    return path.resolve(cwd, "..");
  }

  return path.resolve(cwd);
}

workspaceRoutes.get("/api/workspaces/bootstrap", async (c) => {
  await ensureInitialWorkspace(resolveInitialWorkspaceRoot());
  const [workspaces, profile, startupWorkspace] = await Promise.all([
    listWorkspaces(),
    getWorkspaceProfile(),
    resolveStartupWorkspace(),
  ]);

  return c.json({
    workspaces,
    defaultWorkspaceId: profile.defaultWorkspaceId,
    startupWorkspaceId: startupWorkspace?.id ?? null,
    recentWorkspaceIds: profile.recentWorkspaceIds,
  });
});

workspaceRoutes.get("/api/workspaces", async (c) => {
  const [workspaces, profile] = await Promise.all([
    listWorkspaces(),
    getWorkspaceProfile(),
  ]);
  return c.json({
    workspaces,
    defaultWorkspaceId: profile.defaultWorkspaceId,
    lastOpenedWorkspaceId: profile.lastOpenedWorkspaceId,
    recentWorkspaceIds: profile.recentWorkspaceIds,
  });
});

workspaceRoutes.post("/api/workspaces/open", async (c) => {
  const body = await c.req.json<{ workspaceId?: string; root?: string; name?: string }>();
  if (!body.workspaceId && !body.root) {
    return c.json({ error: "Expected workspaceId or root" }, 400);
  }

  let workspace = null;
  if (body.workspaceId) {
    workspace = await getWorkspaceById(body.workspaceId);
    if (!workspace) {
      return c.json({ error: `Unknown workspace: ${body.workspaceId}` }, 404);
    }
    await noteWorkspaceOpened(workspace.id);
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
  const workspace = await getWorkspaceById(workspaceId);
  if (!workspace) {
    return c.json({ error: `Unknown workspace: ${workspaceId}` }, 404);
  }
  const session = await getWorkspaceSession(workspaceId);
  return c.json({ workspace, session });
});

workspaceRoutes.put("/api/workspaces/:workspaceId/session", async (c) => {
  const workspaceId = c.req.param("workspaceId");
  const workspace = await getWorkspaceById(workspaceId);
  if (!workspace) {
    return c.json({ error: `Unknown workspace: ${workspaceId}` }, 404);
  }

  const body = await c.req.json<PersistedWorkspaceSession>();
  await saveWorkspaceSession(workspaceId, {
    schemaVersion: 1,
    editor: body.editor,
    chat: body.chat,
    explorer: body.explorer,
    layout: body.layout,
    settingsView: body.settingsView,
  });
  return c.json({ ok: true });
});
