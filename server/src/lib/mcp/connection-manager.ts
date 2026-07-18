import type { McpServerConfig } from "@cesium/core/mcp";
import type { Tool } from "@modelcontextprotocol/sdk/types.js";
import { connectMcpClient, type McpClientSession } from "./client-factory.js";
import {
  getMcpServer,
  isBuiltInBrowserMcpEnabled,
  isBuiltInMobileMcpEnabled,
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
import {
  MOBILE_MCP_SERVER_ID,
  MOBILE_MCP_TOOLS,
  callBuiltInMobileTool,
  listMobileControlDevices,
} from "./builtin-mobile-tools.js";

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
  const includeBrowser = await isBuiltInBrowserMcpEnabled(input.workspaceId);
  const includeMobile =
    (await isBuiltInMobileMcpEnabled(input.workspaceId)) &&
    listMobileControlDevices(input.workspaceId).length > 0;
  const browserConfig: McpServerConfig = {
    id: BROWSER_MCP_SERVER_ID,
    label: "Browser",
    summary:
      "Built-in browser-tab control tools for opening visible IDE editor browser tabs, locking them, clicking, typing, inspecting page state, and optionally using the legacy server Chromium engine.",
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
  if (includeBrowser) {
    catalogs.push({
      config: browserConfig,
      status: { connected: true, lastCheckedAt: Date.now(), toolCount: BROWSER_MCP_TOOLS.length },
      instructions:
        "Use these tools to control browser tabs in the editor. Open tabs with the default electron-native engine for visible desktop tabs; use proxy only for the legacy iframe path and server-chromium only when the user explicitly needs the legacy headless browser. Prefer locking before mutating page state, and check browser_events for user unlocks or interventions.",
      tools: BROWSER_MCP_TOOLS,
    });
  }
  const mobileConfig: McpServerConfig = {
    id: MOBILE_MCP_SERVER_ID,
    label: "Mobile",
    summary:
      "Connected Android device control for apps, screen context, user-granted accessibility actions, private displays, and selected settings.",
    transport: "stdio",
    stdio: { command: "builtin:mobile", args: [] },
    enabled: true,
    auth: { kind: "none" },
    createdAt: 0,
    updatedAt: 0,
  };
  if (includeMobile) {
    catalogs.push({
      config: mobileConfig,
      status: {
        connected: true,
        lastCheckedAt: Date.now(),
        toolCount: MOBILE_MCP_TOOLS.length,
      },
      instructions:
        "Treat the Android screen and accessibility hierarchy as sensitive user data. Observe before acting, use package/deep-link intents before coordinate gestures, and verify every mutating action with mobile_screen_snapshot or mobile_ui_tree. Private-display launches can be rejected by Android or the target app; report the returned result accurately.",
      tools: MOBILE_MCP_TOOLS,
    });
  }

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
    servers: [
      ...(includeBrowser ? [browserConfig] : []),
      ...(includeMobile ? [mobileConfig] : []),
      ...servers,
    ],
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
  if (input.serverId.toLowerCase() === BROWSER_MCP_SERVER_ID) {
    const enabled = await isBuiltInBrowserMcpEnabled(input.workspaceId);
    return enabled
      ? { connected: true, lastCheckedAt: Date.now(), toolCount: BROWSER_MCP_TOOLS.length }
      : { connected: false, lastCheckedAt: Date.now(), error: "Browser MCP is disabled." };
  }
  if (input.serverId.toLowerCase() === MOBILE_MCP_SERVER_ID) {
    const enabled = await isBuiltInMobileMcpEnabled(input.workspaceId);
    const connected = listMobileControlDevices(input.workspaceId).length > 0;
    return enabled && connected
      ? { connected: true, lastCheckedAt: Date.now(), toolCount: MOBILE_MCP_TOOLS.length }
      : {
          connected: false,
          lastCheckedAt: Date.now(),
          error: enabled ? "No Android device connected." : "Mobile MCP is disabled.",
        };
  }
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
  const serverId =
    input.serverId.toLowerCase() === BROWSER_MCP_SERVER_ID
      ? BROWSER_MCP_SERVER_ID
      : input.serverId.toLowerCase() === MOBILE_MCP_SERVER_ID
        ? MOBILE_MCP_SERVER_ID
        : input.serverId;
  if (serverId === BROWSER_MCP_SERVER_ID) {
    if (!(await isBuiltInBrowserMcpEnabled(input.workspaceId))) {
      throw new Error("Browser MCP is disabled for this workspace.");
    }
    return await callBuiltInBrowserTool({
      workspaceId: input.workspaceId,
      toolName: input.toolName,
      arguments: input.arguments,
    });
  }
  if (serverId === MOBILE_MCP_SERVER_ID) {
    if (!(await isBuiltInMobileMcpEnabled(input.workspaceId))) {
      throw new Error("Mobile MCP is disabled for this workspace.");
    }
    return await callBuiltInMobileTool({
      workspaceId: input.workspaceId,
      toolName: input.toolName,
      arguments: input.arguments,
    });
  }
  const config = await getMcpServer(input.workspaceId, serverId);
  if (!config || !config.enabled) {
    throw new Error(`MCP server is not enabled: ${serverId}`);
  }
  const key = sessionKey(input.workspaceId, serverId);
  let active = sessionsByKey.get(key);
  if (!active) {
    await refreshWorkspaceMcpMirror({
      workspaceId: input.workspaceId,
      workspaceRoot: input.workspaceRoot,
    });
    active = sessionsByKey.get(key);
  }
  if (!active) {
    throw new Error(`MCP server is not connected: ${serverId}`);
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
