import { Hono } from "hono";
import type { AgentBackendId } from "../lib/agents/types.js";
import { requireWorkspaceFromRequest } from "../lib/request-workspace.js";
import type { AgentPluginDefinition } from "../lib/plugins/types.js";
import {
  deleteAgentPluginInstall,
  installAgentPlugin,
  listAgentPluginsPublic,
  setAgentPluginEnabled,
  setAgentPluginHarnessOverride,
} from "../lib/plugins/store.js";

export const pluginRoutes = new Hono();

pluginRoutes.get("/api/workspaces/:workspaceId/plugins", async (c) => {
  const workspace = await requireWorkspaceFromRequest(c);
  if (workspace.id !== c.req.param("workspaceId")) {
    return c.json({ error: "Workspace mismatch." }, 400);
  }
  return c.json({ plugins: await listAgentPluginsPublic(workspace.id) });
});

pluginRoutes.post("/api/workspaces/:workspaceId/plugins/:pluginId/install", async (c) => {
  const workspace = await requireWorkspaceFromRequest(c);
  if (workspace.id !== c.req.param("workspaceId")) {
    return c.json({ error: "Workspace mismatch." }, 400);
  }
  try {
    const install = await installAgentPlugin(workspace.id, c.req.param("pluginId"));
    return c.json({ install, plugins: await listAgentPluginsPublic(workspace.id) });
  } catch (error) {
    return c.json({ error: error instanceof Error ? error.message : "Failed to install plugin." }, 400);
  }
});

pluginRoutes.post("/api/workspaces/:workspaceId/plugins/custom", async (c) => {
  const workspace = await requireWorkspaceFromRequest(c);
  if (workspace.id !== c.req.param("workspaceId")) {
    return c.json({ error: "Workspace mismatch." }, 400);
  }
  const body = await c.req.json<{ definition?: AgentPluginDefinition }>();
  if (!body.definition) {
    return c.json({ error: "Expected definition." }, 400);
  }
  try {
    const install = await installAgentPlugin(
      workspace.id,
      body.definition.pluginId,
      body.definition
    );
    return c.json({ install, plugins: await listAgentPluginsPublic(workspace.id) });
  } catch (error) {
    return c.json({ error: error instanceof Error ? error.message : "Failed to create plugin." }, 400);
  }
});

pluginRoutes.patch("/api/workspaces/:workspaceId/plugins/:pluginId", async (c) => {
  const workspace = await requireWorkspaceFromRequest(c);
  if (workspace.id !== c.req.param("workspaceId")) {
    return c.json({ error: "Workspace mismatch." }, 400);
  }
  const body = await c.req.json<{ enabled?: boolean }>();
  if (typeof body.enabled !== "boolean") {
    return c.json({ error: "Expected enabled boolean." }, 400);
  }
  try {
    const install = await setAgentPluginEnabled(
      workspace.id,
      c.req.param("pluginId"),
      body.enabled
    );
    return c.json({ install, plugins: await listAgentPluginsPublic(workspace.id) });
  } catch (error) {
    return c.json({ error: error instanceof Error ? error.message : "Failed to update plugin." }, 400);
  }
});

pluginRoutes.patch("/api/workspaces/:workspaceId/plugins/:pluginId/harnesses/:backendId", async (c) => {
  const workspace = await requireWorkspaceFromRequest(c);
  if (workspace.id !== c.req.param("workspaceId")) {
    return c.json({ error: "Workspace mismatch." }, 400);
  }
  const body = await c.req.json<{ enabled?: boolean }>();
  if (typeof body.enabled !== "boolean") {
    return c.json({ error: "Expected enabled boolean." }, 400);
  }
  try {
    const install = await setAgentPluginHarnessOverride(
      workspace.id,
      c.req.param("pluginId"),
      c.req.param("backendId") as AgentBackendId,
      body.enabled
    );
    return c.json({ install, plugins: await listAgentPluginsPublic(workspace.id) });
  } catch (error) {
    return c.json({ error: error instanceof Error ? error.message : "Failed to update plugin." }, 400);
  }
});

pluginRoutes.delete("/api/workspaces/:workspaceId/plugins/:pluginId", async (c) => {
  const workspace = await requireWorkspaceFromRequest(c);
  if (workspace.id !== c.req.param("workspaceId")) {
    return c.json({ error: "Workspace mismatch." }, 400);
  }
  const removed = await deleteAgentPluginInstall(workspace.id, c.req.param("pluginId"));
  if (!removed) {
    return c.json({ error: "Plugin is not installed." }, 404);
  }
  return c.json({ ok: true, plugins: await listAgentPluginsPublic(workspace.id) });
});
