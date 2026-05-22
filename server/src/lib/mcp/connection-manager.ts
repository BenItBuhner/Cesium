import type { McpServerConfig } from "@cesium/core/mcp";
import type { Tool } from "@modelcontextprotocol/sdk/types.js";
import { connectMcpClient, type McpClientSession } from "./client-factory.js";
import {
  getMcpServer,
  listEnabledMcpServers,
  setMcpConnectionStatus,
} from "./server-store.js";
import type { McpConnectionStatus } from "./types.js";
import { ensureMcpGitignore, writeMcpWorkspaceMirror } from "./workspace-mirror.js";
import {
  BROWSER_MCP_SERVER_ID,
  BROWSER_MCP_TOOLS,
  callBuiltInBrowserTool,
} from "./builtin-browser-tools.js";

type ActiveSession = {
  session: McpClientSession;
  tools: Tool[];
  instructions?: string;
};

const sessionsByKey = new Map<string, ActiveSession>();
const MCP_CONNECT_TIMEOUT_MS = 45_000;

async function withTimeout<T>(
  label: string,
  timeoutMs: number,
  run: () => Promise<T>
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      run(),
      new Promise<T>((_, reject) => {
        timer = setTimeout(
          () => reject(new Error(`${label} timed out after ${Math.round(timeoutMs / 1000)}s.`)),
          timeoutMs
        );
      }),
    ]);
  } finally {
    if (timer) {
      clearTimeout(timer);
    }
  }
}

function sessionKey(workspaceId: string, serverId: string): string {
  return `${workspaceId}:${serverId}`;
}

async function connectOne(input: {
  workspaceId: string;
  workspaceRoot: string;
  config: McpServerConfig;
}): Promise<{ tools: Tool[]; instructions?: string; status: McpConnectionStatus }> {
  const key = sessionKey(input.workspaceId, input.config.id);
  const existing = sessionsByKey.get(key);
  if (existing) {
    return {
      tools: existing.tools,
      instructions: existing.instructions,
      status: {
        connected: true,
        lastCheckedAt: Date.now(),
        toolCount: existing.tools.length,
      },
    };
  }

  try {
    const session = await withTimeout(
      `MCP server ${input.config.label || input.config.id}`,
      MCP_CONNECT_TIMEOUT_MS,
      () => connectMcpClient(input)
    );
    const listed = await withTimeout(
      `MCP tools/list for ${input.config.id}`,
      MCP_CONNECT_TIMEOUT_MS,
      () => session.client.listTools()
    );
    const tools = listed.tools ?? [];
    let instructions: string | undefined;
    try {
      const init = await session.client.getInstructions();
      instructions = typeof init === "string" ? init : undefined;
    } catch {
      instructions = undefined;
    }
    sessionsByKey.set(key, { session, tools, instructions });
    const status: McpConnectionStatus = {
      connected: true,
      lastCheckedAt: Date.now(),
      toolCount: tools.length,
    };
    setMcpConnectionStatus(input.workspaceId, input.config.id, status);
    return { tools, instructions, status };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const needsAuth = /oauth|auth/i.test(message);
    const status: McpConnectionStatus = {
      connected: false,
      lastCheckedAt: Date.now(),
      error: message,
      needsAuth,
    };
    setMcpConnectionStatus(input.workspaceId, input.config.id, status);
    return { tools: [], status };
  }
}

export async function refreshWorkspaceMcpMirror(input: {
  workspaceId: string;
  workspaceRoot: string;
}): Promise<void> {
  const servers = await listEnabledMcpServers(input.workspaceId);
  const browserConfig: McpServerConfig = {
    id: BROWSER_MCP_SERVER_ID,
    label: "Browser",
    summary: "Built-in browser-tab control tools for opening, locking, inspecting, and driving IDE browser tabs.",
    transport: "stdio",
    stdio: { command: "builtin:browser", args: [] },
    enabled: true,
    auth: { kind: "none" },
    createdAt: 0,
    updatedAt: 0,
  };
  const catalogs: Array<{
    config: McpServerConfig;
    status: McpConnectionStatus;
    instructions?: string;
    tools: Tool[];
  }> = [];
  catalogs.push({
    config: browserConfig,
    status: { connected: true, lastCheckedAt: Date.now(), toolCount: BROWSER_MCP_TOOLS.length },
    instructions:
      "Use these tools to control IDE browser tabs. Prefer locking before mutating page state, and check browser_events for user unlocks or interventions.",
    tools: BROWSER_MCP_TOOLS,
  });

  await Promise.all(
    servers.map(async (config) => {
      const result = await connectOne({
        workspaceId: input.workspaceId,
        workspaceRoot: input.workspaceRoot,
        config,
      });
      catalogs.push({
        config,
        status: result.status,
        instructions: result.instructions,
        tools: result.tools,
      });
    })
  );

  await writeMcpWorkspaceMirror({
    workspaceRoot: input.workspaceRoot,
    servers: [browserConfig, ...servers],
    catalogs,
  });
  await ensureMcpGitignore(input.workspaceRoot);
}

export async function testMcpServer(input: {
  workspaceId: string;
  workspaceRoot: string;
  serverId: string;
}): Promise<McpConnectionStatus> {
  const config = await getMcpServer(input.workspaceId, input.serverId);
  if (!config) {
    throw new Error(`Unknown MCP server: ${input.serverId}`);
  }
  await disconnectMcpServer(input.workspaceId, input.serverId);
  const result = await connectOne({
    workspaceId: input.workspaceId,
    workspaceRoot: input.workspaceRoot,
    config,
  });
  return result.status;
}

export async function callMcpTool(input: {
  workspaceId: string;
  workspaceRoot: string;
  serverId: string;
  toolName: string;
  arguments: Record<string, unknown>;
}): Promise<string> {
  if (input.serverId === BROWSER_MCP_SERVER_ID) {
    return await callBuiltInBrowserTool({
      workspaceId: input.workspaceId,
      toolName: input.toolName,
      arguments: input.arguments,
    });
  }
  const config = await getMcpServer(input.workspaceId, input.serverId);
  if (!config || !config.enabled) {
    throw new Error(`MCP server is not enabled: ${input.serverId}`);
  }
  const key = sessionKey(input.workspaceId, input.serverId);
  let active = sessionsByKey.get(key);
  if (!active) {
    await refreshWorkspaceMcpMirror({
      workspaceId: input.workspaceId,
      workspaceRoot: input.workspaceRoot,
    });
    active = sessionsByKey.get(key);
  }
  if (!active) {
    throw new Error(`MCP server is not connected: ${input.serverId}`);
  }
  const result = await active.session.client.callTool({
    name: input.toolName,
    arguments: input.arguments,
  });
  const content = Array.isArray(result.content) ? result.content : [];
  const textParts = content
    .filter(
      (part): part is { type: "text"; text: string } =>
        typeof part === "object" &&
        part !== null &&
        "type" in part &&
        part.type === "text" &&
        "text" in part &&
        typeof part.text === "string"
    )
    .map((part) => part.text);
  if (textParts.length > 0) {
    return textParts.join("\n");
  }
  return JSON.stringify(result, null, 2);
}

export async function disconnectMcpServer(
  workspaceId: string,
  serverId: string
): Promise<void> {
  const key = sessionKey(workspaceId, serverId);
  const active = sessionsByKey.get(key);
  if (active) {
    await active.session.close().catch(() => undefined);
    sessionsByKey.delete(key);
  }
}

export async function disconnectWorkspaceMcp(workspaceId: string): Promise<void> {
  for (const key of [...sessionsByKey.keys()]) {
    if (!key.startsWith(`${workspaceId}:`)) {
      continue;
    }
    const active = sessionsByKey.get(key);
    if (active) {
      await active.session.close().catch(() => undefined);
    }
    sessionsByKey.delete(key);
  }
}
