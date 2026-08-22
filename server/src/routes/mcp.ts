import { Hono } from "hono";
import type { McpServerConfig } from "@cesium/core/mcp";
import { requireWorkspaceFromRequest } from "../lib/request-workspace.js";
import {
  callMcpTool,
  disconnectMcpServer,
  refreshWorkspaceMcpMirror,
  testMcpServer,
} from "../lib/mcp/connection-manager.js";
import {
  buildMcpOAuthCallbackUrl,
  completeMcpOAuthCallback,
  disconnectMcpOAuth,
  oauthFailureHtml,
  oauthSuccessHtml,
  startMcpOAuth,
} from "../lib/mcp/oauth.js";
import { probeMcpRemoteAuth } from "../lib/mcp/oauth-discovery.js";
import { resolveOAuthPublicOrigin } from "../lib/oauth/public-origin.js";
import { MCP_PRESETS, getMcpPreset } from "../lib/mcp/presets.js";
import {
  createSecretId,
  deleteMcpServer,
  getMcpServer,
  listMcpServers,
  setBuiltInArtifactsMcpEnabled,
  setBuiltInBrowserMcpEnabled,
  setBuiltInPhoneMcpEnabled,
  setMcpSecret,
  touchMcpCatalogRevision,
  upsertMcpServer,
} from "../lib/mcp/server-store.js";
import { BROWSER_MCP_SERVER_ID } from "../lib/mcp/builtin-browser-tools.js";
import { PHONE_MCP_SERVER_ID } from "../lib/mcp/builtin-phone-tools.js";
import { ARTIFACTS_MCP_SERVER_ID } from "../lib/mcp/builtin-artifact-tools.js";
import { slugifyMcpServerId } from "../lib/mcp/paths.js";

export const mcpRoutes = new Hono();

function publicOriginFromRequest(c: {
  req: { url: string; header: (name: string) => string | undefined };
}): string {
  return resolveOAuthPublicOrigin(c.req);
}

mcpRoutes.get("/api/mcp/presets", (c) => c.json({ presets: MCP_PRESETS }));

mcpRoutes.get("/api/workspaces/:workspaceId/mcp/servers", async (c) => {
  await requireWorkspaceFromRequest(c);
  const workspaceId = c.req.param("workspaceId");
  const servers = await listMcpServers(workspaceId);
  return c.json({ servers });
});

mcpRoutes.put("/api/workspaces/:workspaceId/mcp/servers", async (c) => {
  const workspace = await requireWorkspaceFromRequest(c);
  if (workspace.id !== c.req.param("workspaceId")) {
    return c.json({ error: "Workspace mismatch." }, 400);
  }
  const body = await c.req.json<{
    server?: Partial<McpServerConfig> & { label: string };
    presetId?: string;
    secretValues?: Record<string, string>;
  }>();

  let configInput: Omit<McpServerConfig, "createdAt" | "updatedAt">;
  if (body.presetId) {
    const preset = getMcpPreset(body.presetId);
    if (!preset) {
      return c.json({ error: `Unknown preset: ${body.presetId}` }, 400);
    }
    const id = slugifyMcpServerId(body.server?.label ?? preset.label);
    configInput = {
      ...preset.config,
      ...body.server,
      id,
      label: body.server?.label?.trim() || preset.label,
      enabled: body.server?.enabled ?? true,
      presetId: preset.presetId,
    } as Omit<McpServerConfig, "createdAt" | "updatedAt">;
  } else if (body.server) {
    const id = body.server.id?.trim() || slugifyMcpServerId(body.server.label);
    configInput = {
      enabled: true,
      transport: "streamable-http",
      auth: { kind: "none" },
      ...body.server,
      id,
      label: body.server.label.trim(),
    } as Omit<McpServerConfig, "createdAt" | "updatedAt">;
  } else {
    return c.json({ error: "Expected server or presetId." }, 400);
  }

  const saved = await upsertMcpServer(workspace.id, configInput);

  if (body.secretValues) {
    for (const [key, value] of Object.entries(body.secretValues)) {
      if (!value.trim()) continue;
      const secretId =
        key.includes(":") ? key : createSecretId(saved.id, key);
      await setMcpSecret(workspace.id, secretId, {
        kind: "value",
        value: value.trim(),
        updatedAt: Date.now(),
      });
      if (saved.auth.kind === "oauth" && key === "clientId") {
        saved.auth = { ...saved.auth, clientIdSecretId: secretId };
      }
      if (saved.auth.kind === "oauth" && key === "clientSecret") {
        saved.auth = { ...saved.auth, clientSecretSecretId: secretId };
      }
      if (saved.auth.kind === "bearer" && key === "bearer") {
        saved.auth = { ...saved.auth, secretId };
      }
      if (saved.auth.kind === "headers" && key.startsWith("header:")) {
        const headerName = key.slice("header:".length);
        saved.auth = {
          ...saved.auth,
          headers: saved.auth.headers.map((entry) =>
            entry.name === headerName ? { ...entry, secretId } : entry
          ),
        };
      }
    }
    await upsertMcpServer(workspace.id, saved);
  }

  return c.json({ server: saved });
});

mcpRoutes.delete("/api/workspaces/:workspaceId/mcp/servers/:serverId", async (c) => {
  const workspace = await requireWorkspaceFromRequest(c);
  const serverId = c.req.param("serverId");
  if (
    serverId.toLowerCase() === BROWSER_MCP_SERVER_ID ||
    serverId.toLowerCase() === PHONE_MCP_SERVER_ID ||
    serverId.toLowerCase() === ARTIFACTS_MCP_SERVER_ID
  ) {
    return c.json({ error: "Built-in MCP servers can be disabled, not removed." }, 400);
  }
  await disconnectMcpServer(workspace.id, serverId);
  const removed = await deleteMcpServer(workspace.id, serverId);
  if (!removed) {
    return c.json({ error: "Server not found." }, 404);
  }
  return c.json({ ok: true });
});

mcpRoutes.patch("/api/workspaces/:workspaceId/mcp/builtins/:serverId", async (c) => {
  const workspace = await requireWorkspaceFromRequest(c);
  const serverId = c.req.param("serverId").toLowerCase();
  if (
    serverId !== BROWSER_MCP_SERVER_ID &&
    serverId !== PHONE_MCP_SERVER_ID &&
    serverId !== ARTIFACTS_MCP_SERVER_ID
  ) {
    return c.json({ error: `Unknown built-in MCP server: ${serverId}` }, 404);
  }
  const body = await c.req.json<{ enabled?: boolean }>();
  if (typeof body.enabled !== "boolean") {
    return c.json({ error: "Expected enabled boolean." }, 400);
  }
  if (serverId === BROWSER_MCP_SERVER_ID) {
    await setBuiltInBrowserMcpEnabled(workspace.id, body.enabled);
  } else if (serverId === PHONE_MCP_SERVER_ID) {
    await setBuiltInPhoneMcpEnabled(workspace.id, body.enabled);
  } else {
    await setBuiltInArtifactsMcpEnabled(workspace.id, body.enabled);
  }
  await refreshWorkspaceMcpMirror({
    workspaceId: workspace.id,
    workspaceRoot: workspace.root,
  });
  return c.json({ ok: true });
});

mcpRoutes.post("/api/workspaces/:workspaceId/mcp/servers/:serverId/test", async (c) => {
  const workspace = await requireWorkspaceFromRequest(c);
  const serverId = c.req.param("serverId");
  const status = await testMcpServer({
    workspaceId: workspace.id,
    workspaceRoot: workspace.root,
    serverId,
  });
  await touchMcpCatalogRevision(workspace.id);
  return c.json({ status });
});

mcpRoutes.post("/api/workspaces/:workspaceId/mcp/servers/:serverId/refresh", async (c) => {
  const workspace = await requireWorkspaceFromRequest(c);
  const serverId = c.req.param("serverId");
  await refreshWorkspaceMcpMirror({
    workspaceId: workspace.id,
    workspaceRoot: workspace.root,
  });
  await touchMcpCatalogRevision(workspace.id);
  const server = await getMcpServer(workspace.id, serverId);
  return c.json({ ok: true, server });
});

mcpRoutes.post("/api/mcp/auth/probe", async (c) => {
  const body = await c.req.json<{ url?: string }>().catch(() => ({ url: "" }));
  const url = body.url?.trim();
  if (!url) {
    return c.json({ error: "Expected url." }, 400);
  }
  try {
    return c.json({ probe: await probeMcpRemoteAuth(url) });
  } catch (error) {
    return c.json(
      { error: error instanceof Error ? error.message : "Failed to probe MCP auth." },
      400
    );
  }
});

mcpRoutes.delete("/api/workspaces/:workspaceId/mcp/oauth/:serverId", async (c) => {
  const workspace = await requireWorkspaceFromRequest(c);
  await disconnectMcpOAuth(workspace.id, c.req.param("serverId"));
  return c.json({ ok: true });
});

mcpRoutes.get("/api/workspaces/:workspaceId/mcp/oauth/:serverId/start", async (c) => {
  const workspace = await requireWorkspaceFromRequest(c);
  const serverId = c.req.param("serverId");
  const origin = publicOriginFromRequest(c);
  const result = await startMcpOAuth({
    workspaceId: workspace.id,
    serverId,
    publicOrigin: origin,
  });
  return c.json({
    ...result,
    callbackUrl: buildMcpOAuthCallbackUrl(origin),
  });
});

mcpRoutes.get("/api/mcp/oauth/callback", async (c) => {
  const code = c.req.query("code")?.trim();
  const state = c.req.query("state")?.trim();
  const error = c.req.query("error")?.trim();
  if (error) {
    return c.html(oauthFailureHtml(error, state), 400);
  }
  if (!code || !state) {
    return c.html(oauthFailureHtml("Missing code or state.", state), 400);
  }
  try {
    const result = await completeMcpOAuthCallback({ code, state });
    const server = await getMcpServer(result.workspaceId, result.serverId);
    const workspace = await (
      await import("../lib/workspace-registry.js")
    ).getWorkspaceById(result.workspaceId);
    if (workspace) {
      await refreshWorkspaceMcpMirror({
        workspaceId: workspace.id,
        workspaceRoot: workspace.root,
      });
    }
    return c.html(oauthSuccessHtml(server?.label ?? result.serverId, result.sessionId));
  } catch (callbackError) {
    const message =
      callbackError instanceof Error ? callbackError.message : String(callbackError);
    return c.html(oauthFailureHtml(message, state), 500);
  }
});

mcpRoutes.post("/api/workspaces/:workspaceId/mcp/call", async (c) => {
  const workspace = await requireWorkspaceFromRequest(c);
  const body = await c.req.json<{
    serverId?: string;
    toolName?: string;
    arguments?: Record<string, unknown>;
  }>();
  if (!body.serverId?.trim() || !body.toolName?.trim()) {
    return c.json({ error: "Expected serverId and toolName." }, 400);
  }
  const result = await callMcpTool({
    workspaceId: workspace.id,
    workspaceRoot: workspace.root,
    serverId: body.serverId.trim(),
    toolName: body.toolName.trim(),
    arguments: body.arguments ?? {},
  });
  return c.json({ result });
});
