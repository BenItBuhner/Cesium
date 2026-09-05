import { Hono } from "hono";
import type { Server } from "@modelcontextprotocol/sdk/server/index.js";
import {
  BROWSER_MCP_SERVER_ID,
  BROWSER_MCP_TOOLS,
  callBuiltInBrowserToolRich,
} from "../lib/mcp/builtin-browser-tools.js";
import {
  PHONE_MCP_SERVER_ID,
  PHONE_MCP_TOOLS,
  callBuiltInPhoneTool,
} from "../lib/mcp/builtin-phone-tools.js";
import {
  isBuiltInBrowserMcpEnabled,
  isBuiltInPhoneMcpEnabled,
} from "../lib/mcp/server-store.js";
import { getWorkspaceById } from "../lib/workspace-registry.js";

export const mcpBridgeRoutes = new Hono();

type ToolCallContent = Array<
  | { type: "text"; text: string }
  | { type: "image"; data: string; mimeType: string }
>;

/**
 * The MCP server SDK + @hono/mcp transport (~30 MB RSS with their zod
 * schemas) only matter once an external harness actually attaches to the
 * built-in bridge, so they load on the first request instead of at boot.
 */
let bridgeSdkPromise: Promise<{
  Server: typeof import("@modelcontextprotocol/sdk/server/index.js").Server;
  CallToolRequestSchema: typeof import("@modelcontextprotocol/sdk/types.js").CallToolRequestSchema;
  ListToolsRequestSchema: typeof import("@modelcontextprotocol/sdk/types.js").ListToolsRequestSchema;
  StreamableHTTPTransport: typeof import("@hono/mcp").StreamableHTTPTransport;
}> | null = null;

function loadBridgeSdk() {
  bridgeSdkPromise ??= Promise.all([
    import("@modelcontextprotocol/sdk/server/index.js"),
    import("@modelcontextprotocol/sdk/types.js"),
    import("@hono/mcp"),
  ]).then(([server, types, honoMcp]) => ({
    Server: server.Server,
    CallToolRequestSchema: types.CallToolRequestSchema,
    ListToolsRequestSchema: types.ListToolsRequestSchema,
    StreamableHTTPTransport: honoMcp.StreamableHTTPTransport,
  }));
  return bridgeSdkPromise;
}

async function buildBridgeServer(input: {
  workspaceId: string;
  workspaceRoot: string;
  serverId: typeof BROWSER_MCP_SERVER_ID | typeof PHONE_MCP_SERVER_ID;
}): Promise<Server> {
  const { Server, CallToolRequestSchema, ListToolsRequestSchema } = await loadBridgeSdk();
  const isBrowser = input.serverId === BROWSER_MCP_SERVER_ID;
  const server = new Server(
    {
      name: isBrowser ? "cesium-browser" : "cesium-phone",
      version: "1.0.0",
    },
    { capabilities: { tools: {} } }
  );
  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: isBrowser ? BROWSER_MCP_TOOLS : PHONE_MCP_TOOLS,
  }));
  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const toolName = request.params.name;
    const args = (request.params.arguments ?? {}) as Record<string, unknown>;
    try {
      if (isBrowser) {
        const result = await callBuiltInBrowserToolRich({
          workspaceId: input.workspaceId,
          workspaceRoot: input.workspaceRoot,
          toolName,
          arguments: args,
        });
        const content: ToolCallContent = [{ type: "text", text: result.text }];
        for (const image of result.images ?? []) {
          content.push({ type: "image", data: image.data, mimeType: image.mimeType });
        }
        return { content };
      }
      const text = await callBuiltInPhoneTool({
        workspaceId: input.workspaceId,
        toolName,
        arguments: args,
      });
      return { content: [{ type: "text", text }] as ToolCallContent };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return {
        content: [{ type: "text", text: message }] as ToolCallContent,
        isError: true,
      };
    }
  });
  return server;
}

/**
 * Streamable HTTP MCP endpoint for the built-in servers so external harness
 * CLIs (Claude Code, Codex, Cursor, OpenCode, …) can attach natively instead of
 * going through Cesium's internal call path. Stateless: a fresh MCP server is
 * bound per request, which every mainstream client supports.
 */
mcpBridgeRoutes.all("/api/workspaces/:workspaceId/mcp/servers/:serverId/http", async (c) => {
  const workspaceId = c.req.param("workspaceId");
  const serverIdRaw = c.req.param("serverId").toLowerCase();
  if (serverIdRaw !== BROWSER_MCP_SERVER_ID && serverIdRaw !== PHONE_MCP_SERVER_ID) {
    return c.json({ error: `No built-in MCP HTTP bridge for server: ${serverIdRaw}` }, 404);
  }
  const workspace = await getWorkspaceById(workspaceId);
  if (!workspace) {
    return c.json({ error: `Unknown workspace: ${workspaceId}` }, 404);
  }
  const enabled =
    serverIdRaw === BROWSER_MCP_SERVER_ID
      ? await isBuiltInBrowserMcpEnabled(workspace.id)
      : await isBuiltInPhoneMcpEnabled(workspace.id);
  if (!enabled) {
    return c.json({ error: `Built-in MCP server is disabled: ${serverIdRaw}` }, 403);
  }
  const server = await buildBridgeServer({
    workspaceId: workspace.id,
    workspaceRoot: workspace.root,
    serverId: serverIdRaw,
  });
  const { StreamableHTTPTransport } = await loadBridgeSdk();
  const transport = new StreamableHTTPTransport();
  await server.connect(transport);
  return transport.handleRequest(c);
});
