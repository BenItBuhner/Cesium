import { promises as fs } from "node:fs";
import path from "node:path";
import {
  exportEnabledMcpServersForSdk,
  type SdkMcpServerConfig,
} from "../agents/mcp-export-adapter.js";
import { listEnabledMcpServers } from "../mcp/server-store.js";

type AntigravityMcpServerConfig =
  | {
      command: string;
      args?: string[];
      env?: Record<string, string>;
      cwd?: string;
      disabled?: boolean;
    }
  | {
      serverUrl: string;
      headers?: Record<string, string>;
      disabled?: boolean;
    };

type AntigravityMcpConfigFile = {
  mcpServers: Record<string, AntigravityMcpServerConfig>;
};

type CesiumManagedMcpMarker = {
  schemaVersion: 1;
  managedServerIds: string[];
  updatedAt: number;
};

function agentsDir(workspaceRoot: string): string {
  return path.join(workspaceRoot, ".agents");
}

function mcpConfigPath(workspaceRoot: string): string {
  return path.join(agentsDir(workspaceRoot), "mcp_config.json");
}

function managedMarkerPath(workspaceRoot: string): string {
  return path.join(agentsDir(workspaceRoot), ".cesium-plugin-mcp.json");
}

function sdkToAntigravity(server: SdkMcpServerConfig): AntigravityMcpServerConfig {
  if (server.type === "stdio") {
    return {
      command: server.command,
      ...(server.args?.length ? { args: server.args } : {}),
      ...(server.env ? { env: server.env } : {}),
      ...(server.cwd ? { cwd: server.cwd } : {}),
    };
  }
  return {
    serverUrl: server.url,
    ...(server.headers ? { headers: server.headers } : {}),
  };
}

async function readJsonFile<T>(filePath: string): Promise<T | null> {
  try {
    const raw = await fs.readFile(filePath, "utf8");
    return JSON.parse(raw) as T;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return null;
    }
    throw error;
  }
}

/**
 * Sync plugin-managed MCP servers into the workspace Antigravity config
 * (`.agents/mcp_config.json`) without clobbering user-authored entries.
 */
export async function syncWorkspaceAntigravityMcpConfig(input: {
  workspaceId: string;
  workspaceRoot: string;
}): Promise<{
  path: string;
  managedServerIds: string[];
  written: boolean;
}> {
  const enabled = await listEnabledMcpServers(input.workspaceId);
  const pluginServers = enabled.filter((server) => Boolean(server.pluginId));
  const exported = await exportEnabledMcpServersForSdk({
    workspaceId: input.workspaceId,
    workspaceRoot: input.workspaceRoot,
    configs: pluginServers,
  });

  const configFile = mcpConfigPath(input.workspaceRoot);
  const markerFile = managedMarkerPath(input.workspaceRoot);
  await fs.mkdir(agentsDir(input.workspaceRoot), { recursive: true });

  const existing =
    (await readJsonFile<AntigravityMcpConfigFile>(configFile)) ?? { mcpServers: {} };
  const previousManaged =
    (await readJsonFile<CesiumManagedMcpMarker>(markerFile))?.managedServerIds ?? [];

  const nextServers: Record<string, AntigravityMcpServerConfig> = {
    ...existing.mcpServers,
  };

  for (const id of previousManaged) {
    if (!(id in exported.servers)) {
      delete nextServers[id];
    }
  }

  const managedServerIds: string[] = [];
  for (const [id, server] of Object.entries(exported.servers)) {
    nextServers[id] = sdkToAntigravity(server);
    managedServerIds.push(id);
  }

  await fs.writeFile(
    configFile,
    `${JSON.stringify({ mcpServers: nextServers }, null, 2)}\n`,
    "utf8"
  );
  await fs.writeFile(
    markerFile,
    `${JSON.stringify(
      {
        schemaVersion: 1,
        managedServerIds,
        updatedAt: Date.now(),
      } satisfies CesiumManagedMcpMarker,
      null,
      2
    )}\n`,
    "utf8"
  );

  try {
    const gitignorePath = path.join(input.workspaceRoot, ".gitignore");
    const existing = await fs.readFile(gitignorePath, "utf8");
    if (!existing.split(/\r?\n/).includes(".agents/.cesium-plugin-mcp.json")) {
      await fs.appendFile(gitignorePath, "\n.agents/.cesium-plugin-mcp.json\n", "utf8");
    }
  } catch {
    // no .gitignore — skip
  }

  return {
    path: configFile,
    managedServerIds,
    written: true,
  };
}
