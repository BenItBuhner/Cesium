import { promises as fs } from "node:fs";
import path from "node:path";
import {
  exportEnabledMcpServersForSdk,
  type SdkMcpServerConfig,
} from "../agents/mcp-export-adapter.js";
import { listEnabledMcpServers } from "../mcp/server-store.js";

type OpenCodeMcpConfig =
  | {
      type: "local";
      command: string[];
      enabled?: boolean;
      environment?: Record<string, string>;
    }
  | {
      type: "remote";
      url: string;
      enabled?: boolean;
      headers?: Record<string, string>;
    };

type OpenCodeConfigFile = {
  mcp?: Record<string, OpenCodeMcpConfig>;
  [key: string]: unknown;
};

type CesiumManagedMcpMarker = {
  schemaVersion: 1;
  managedServerIds: string[];
  updatedAt: number;
};

function configPath(workspaceRoot: string): string {
  return path.join(workspaceRoot, "opencode.json");
}

function markerPath(workspaceRoot: string): string {
  return path.join(workspaceRoot, ".cesium-opencode-mcp.json");
}

function sdkToOpenCode(server: SdkMcpServerConfig): OpenCodeMcpConfig {
  if (server.type === "stdio") {
    return {
      type: "local",
      command: [server.command, ...(server.args ?? [])],
      ...(server.env ? { environment: server.env } : {}),
    };
  }
  return {
    type: "remote",
    url: server.url,
    ...(server.headers ? { headers: server.headers } : {}),
  };
}

async function readJsonFile<T>(filePath: string): Promise<T | null> {
  try {
    return JSON.parse(await fs.readFile(filePath, "utf8")) as T;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return null;
    }
    throw error;
  }
}

export async function syncWorkspaceOpenCodeMcpConfig(input: {
  workspaceId: string;
  workspaceRoot: string;
}): Promise<{ path: string; managedServerIds: string[]; written: boolean }> {
  const enabled = await listEnabledMcpServers(input.workspaceId);
  const exported = await exportEnabledMcpServersForSdk({
    workspaceId: input.workspaceId,
    workspaceRoot: input.workspaceRoot,
    configs: enabled,
  });
  const existing = (await readJsonFile<OpenCodeConfigFile>(configPath(input.workspaceRoot))) ?? {};
  const previousManaged =
    (await readJsonFile<CesiumManagedMcpMarker>(markerPath(input.workspaceRoot)))
      ?.managedServerIds ?? [];
  const nextMcp: Record<string, OpenCodeMcpConfig> = { ...(existing.mcp ?? {}) };
  for (const id of previousManaged) {
    if (!(id in exported.servers)) {
      delete nextMcp[id];
    }
  }
  const managedServerIds: string[] = [];
  for (const [id, server] of Object.entries(exported.servers)) {
    nextMcp[id] = sdkToOpenCode(server);
    managedServerIds.push(id);
  }
  await fs.writeFile(
    configPath(input.workspaceRoot),
    `${JSON.stringify({ ...existing, mcp: nextMcp }, null, 2)}\n`,
    "utf8"
  );
  await fs.writeFile(
    markerPath(input.workspaceRoot),
    `${JSON.stringify(
      { schemaVersion: 1, managedServerIds, updatedAt: Date.now() } satisfies CesiumManagedMcpMarker,
      null,
      2
    )}\n`,
    "utf8"
  );
  return { path: configPath(input.workspaceRoot), managedServerIds, written: true };
}
