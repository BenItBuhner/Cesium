import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { SSEClientTransport } from "@modelcontextprotocol/sdk/client/sse.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { McpServerConfig } from "@cesium/core/mcp";
import { refreshMcpOAuthAccessToken } from "./oauth.js";
import {
  createStatelessHttpMcpClient,
  probeSessionHttp,
  probeStatelessHttp,
} from "./protocol-http.js";
import {
  createStatelessStdioMcpClient,
  probeSessionStdio,
  probeStatelessStdio,
} from "./protocol-stdio.js";
import {
  describeProtocolNegotiation,
  selectPreferredProtocol,
  type McpProtocolNegotiation,
} from "./protocol.js";
import { getMcpSecret } from "./server-store.js";
import { validateMcpRemoteUrl } from "./url-policy.js";

export type McpRuntimeClient = {
  listTools: () => Promise<{ tools: Array<Record<string, unknown>> }>;
  callTool: (input: {
    name: string;
    arguments?: Record<string, unknown>;
  }) => Promise<{ content?: unknown }>;
  getInstructions?: () => Promise<string | undefined>;
};

export type McpClientSession = {
  client: McpRuntimeClient;
  close: () => Promise<void>;
  protocol: McpProtocolNegotiation;
};

export async function resolveMcpRequestHeaders(
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
    const accessToken = await refreshMcpOAuthAccessToken({ workspaceId, config });
    if (accessToken) {
      headers.Authorization = `Bearer ${accessToken}`;
    }
  }
  return headers;
}

async function connectSessionSdkClient(input: {
  workspaceId: string;
  workspaceRoot: string;
  config: McpServerConfig;
  headers: Record<string, string>;
  remoteUrl?: URL;
}): Promise<Omit<McpClientSession, "protocol">> {
  const client = new Client(
    { name: "opencursor-cesium", version: "0.1.0" },
    { capabilities: {} }
  );
  if (input.config.transport === "stdio") {
    if (!input.config.stdio?.command?.trim()) {
      throw new Error("stdio MCP server requires a command.");
    }
    const transport = new StdioClientTransport({
      command: input.config.stdio.command,
      args: input.config.stdio.args ?? [],
      env: input.config.stdio.env,
      cwd: input.config.stdio.cwd?.trim() ? input.config.stdio.cwd : input.workspaceRoot,
    });
    await client.connect(transport);
    return {
      client: client as unknown as McpRuntimeClient,
      close: async () => {
        await transport.close();
      },
    };
  }
  if (!input.remoteUrl) {
    throw new Error("Remote MCP server requires a URL.");
  }
  if (input.config.transport === "sse") {
    const transport = new SSEClientTransport(input.remoteUrl, {
      requestInit: { headers: input.headers },
    });
    await client.connect(transport);
    return {
      client: client as unknown as McpRuntimeClient,
      close: async () => {
        await transport.close();
      },
    };
  }
  const transport = new StreamableHTTPClientTransport(input.remoteUrl, {
    requestInit: { headers: input.headers },
  });
  await client.connect(transport);
  return {
    client: client as unknown as McpRuntimeClient,
    close: async () => {
      await transport.close();
    },
  };
}

export async function connectMcpClient(input: {
  workspaceId: string;
  workspaceRoot: string;
  config: McpServerConfig;
}): Promise<McpClientSession> {
  const { workspaceId, workspaceRoot, config } = input;

  if (config.transport === "stdio") {
    if (!config.stdio?.command?.trim()) {
      throw new Error("stdio MCP server requires a command.");
    }
    const stdio = {
      command: config.stdio.command,
      args: config.stdio.args ?? [],
      env: config.stdio.env,
      cwd: config.stdio.cwd?.trim() ? config.stdio.cwd : workspaceRoot,
    };
    const probes = await Promise.all([probeStatelessStdio(stdio), probeSessionStdio(stdio)]);
    const protocol = selectPreferredProtocol(probes);
    if (protocol.selected === "stateless") {
      const client = createStatelessStdioMcpClient(stdio);
      return { client, close: () => client.close(), protocol };
    }
    if (protocol.selected === "session") {
      const session = await connectSessionSdkClient({
        workspaceId,
        workspaceRoot,
        config,
        headers: {},
      });
      return { ...session, protocol };
    }
    throw new Error(describeProtocolNegotiation(protocol));
  }

  const remoteUrl = config.remote?.url?.trim();
  if (!remoteUrl) {
    throw new Error("Remote MCP server requires a URL.");
  }
  const parsed = validateMcpRemoteUrl(remoteUrl, {
    allowInsecureLocalhost: config.remote?.allowInsecureLocalhost,
  });
  const headers = await resolveMcpRequestHeaders(workspaceId, config);

  if (config.auth.kind === "oauth") {
    const accessToken = await refreshMcpOAuthAccessToken({ workspaceId, config });
    if (!accessToken) {
      throw new Error("MCP server requires OAuth authentication. Connect it from Settings → Plugins.");
    }
  }

  const probes = await Promise.all([
    probeStatelessHttp(parsed.toString(), headers),
    probeSessionHttp(parsed.toString(), headers),
  ]);
  const protocol = selectPreferredProtocol(probes);

  if (protocol.selected === "stateless") {
    const client = createStatelessHttpMcpClient({
      url: parsed.toString(),
      headers,
    });
    return {
      client,
      close: async () => undefined,
      protocol,
    };
  }

  if (protocol.selected === "session") {
    const session = await connectSessionSdkClient({
      workspaceId,
      workspaceRoot,
      config,
      headers,
      remoteUrl: parsed,
    });
    return { ...session, protocol };
  }

  throw new Error(describeProtocolNegotiation(protocol));
}
