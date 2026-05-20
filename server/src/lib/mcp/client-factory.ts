import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { SSEClientTransport } from "@modelcontextprotocol/sdk/client/sse.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { McpServerConfig } from "@cesium/core/mcp";
import { getMcpSecret } from "./server-store.js";
import { validateMcpRemoteUrl } from "./url-policy.js";

export type McpClientSession = {
  client: Client;
  close: () => Promise<void>;
};

async function resolveRequestHeaders(
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
    const tokenSecretId = `${config.id}:oauth:access`;
    const secret = await getMcpSecret(workspaceId, tokenSecretId);
    if (secret?.kind === "oauth" && secret.accessToken.trim()) {
      headers.Authorization = `Bearer ${secret.accessToken.trim()}`;
    }
  }
  return headers;
}

export async function connectMcpClient(input: {
  workspaceId: string;
  workspaceRoot: string;
  config: McpServerConfig;
}): Promise<McpClientSession> {
  const { workspaceId, workspaceRoot, config } = input;
  const client = new Client(
    { name: "opencursor-cesium", version: "0.1.0" },
    { capabilities: {} }
  );

  if (config.transport === "stdio") {
    if (!config.stdio?.command?.trim()) {
      throw new Error("stdio MCP server requires a command.");
    }
    const transport = new StdioClientTransport({
      command: config.stdio.command,
      args: config.stdio.args ?? [],
      env: config.stdio.env,
      cwd: config.stdio.cwd?.trim() ? config.stdio.cwd : workspaceRoot,
    });
    await client.connect(transport);
    return {
      client,
      close: async () => {
        await transport.close();
      },
    };
  }

  const remoteUrl = config.remote?.url?.trim();
  if (!remoteUrl) {
    throw new Error("Remote MCP server requires a URL.");
  }
  const parsed = validateMcpRemoteUrl(remoteUrl, {
    allowInsecureLocalhost: config.remote?.allowInsecureLocalhost,
  });
  const headers = await resolveRequestHeaders(workspaceId, config);

  if (config.auth.kind === "oauth") {
    const tokenSecretId = `${config.id}:oauth:access`;
    const secret = await getMcpSecret(workspaceId, tokenSecretId);
    if (!secret || secret.kind !== "oauth" || !secret.accessToken.trim()) {
      throw new Error("MCP server requires OAuth authentication. Connect it from Settings → Plugins.");
    }
  }

  if (config.transport === "sse") {
    const transport = new SSEClientTransport(parsed, {
      requestInit: { headers },
    });
    await client.connect(transport);
    return {
      client,
      close: async () => {
        await transport.close();
      },
    };
  }

  const transport = new StreamableHTTPClientTransport(parsed, {
    requestInit: { headers },
  });
  await client.connect(transport);
  return {
    client,
    close: async () => {
      await transport.close();
    },
  };
}
