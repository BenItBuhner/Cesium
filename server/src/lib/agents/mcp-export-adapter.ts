import type { McpServerConfig } from "@cesium/core/mcp";
import {
  getMcpSecret,
  listEnabledMcpServers,
} from "../mcp/server-store.js";
import { validateMcpRemoteUrl } from "../mcp/url-policy.js";

export type SdkMcpServerConfig =
  | {
      type: "stdio";
      command: string;
      args?: string[];
      env?: Record<string, string>;
      cwd?: string;
    }
  | {
      type: "http" | "sse";
      url: string;
      headers?: Record<string, string>;
    };

export type ExportedMcpServers = {
  servers: Record<string, SdkMcpServerConfig>;
  skipped: Array<{
    id: string;
    label: string;
    reason: string;
    pluginId?: string;
    pluginName?: string;
  }>;
};

async function requestHeadersForSdkMcp(
  workspaceId: string,
  config: McpServerConfig
): Promise<Record<string, string>> {
  const headers: Record<string, string> = {};
  if (config.auth.kind === "bearer") {
    const secret = await getMcpSecret(workspaceId, config.auth.secretId);
    if (secret?.kind === "value" && secret.value.trim()) {
      headers.Authorization = `Bearer ${secret.value.trim()}`;
    }
  } else if (config.auth.kind === "headers") {
    for (const header of config.auth.headers) {
      const secret = await getMcpSecret(workspaceId, header.secretId);
      if (secret?.kind === "value" && secret.value.trim()) {
        headers[header.name] = secret.value.trim();
      }
    }
  } else if (config.auth.kind === "oauth") {
    const secret = await getMcpSecret(workspaceId, `${config.id}:oauth:access`);
    if (secret?.kind === "oauth" && secret.accessToken.trim()) {
      headers.Authorization = `Bearer ${secret.accessToken.trim()}`;
    }
  }
  return headers;
}

export async function mcpServerConfigToSdkServer(input: {
  workspaceId: string;
  workspaceRoot: string;
  config: McpServerConfig;
}): Promise<SdkMcpServerConfig | null> {
  const { config, workspaceId, workspaceRoot } = input;
  if (!config.enabled) {
    return null;
  }
  if (config.transport === "stdio") {
    const command = config.stdio?.command?.trim();
    if (!command) {
      return null;
    }
    return {
      type: "stdio",
      command,
      args: config.stdio?.args ?? [],
      env: config.stdio?.env,
      cwd: config.stdio?.cwd?.trim() || workspaceRoot,
    };
  }
  const url = config.remote?.url?.trim();
  if (!url) {
    return null;
  }
  validateMcpRemoteUrl(url, {
    allowInsecureLocalhost: config.remote?.allowInsecureLocalhost,
  });
  const headers = await requestHeadersForSdkMcp(workspaceId, config);
  return {
    type: config.transport === "sse" ? "sse" : "http",
    url,
    ...(Object.keys(headers).length > 0 ? { headers } : {}),
  };
}

export async function exportEnabledMcpServersForSdk(input: {
  workspaceId: string;
  workspaceRoot: string;
  configs?: McpServerConfig[];
}): Promise<ExportedMcpServers> {
  const configs = input.configs ?? await listEnabledMcpServers(input.workspaceId);
  const servers: Record<string, SdkMcpServerConfig> = {};
  const skipped: ExportedMcpServers["skipped"] = [];
  for (const config of configs) {
    try {
      const exported = await mcpServerConfigToSdkServer({
        workspaceId: input.workspaceId,
        workspaceRoot: input.workspaceRoot,
        config,
      });
      if (exported) {
        servers[config.id] = exported;
      } else {
        skipped.push({
          id: config.id,
          label: config.label,
          reason: "Unsupported or incomplete MCP server config.",
          pluginId: config.pluginId,
          pluginName: config.displayName,
        });
      }
    } catch (error) {
      skipped.push({
        id: config.id,
        label: config.label,
        reason: error instanceof Error ? error.message : "Failed to export MCP server.",
        pluginId: config.pluginId,
        pluginName: config.displayName,
      });
    }
  }
  return { servers, skipped };
}
