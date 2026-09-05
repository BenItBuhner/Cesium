import {
  MCP_CLIENT_INFO,
  MCP_SESSION_PROTOCOL_VERSION,
  MCP_STATELESS_PROTOCOL_VERSION,
  mcpProtocolMeta,
  type McpProtocolProbeResult,
} from "./protocol.js";
import { isRecord } from "../coerce.js";

type JsonRpcResponse = {
  jsonrpc?: string;
  id?: unknown;
  result?: unknown;
  error?: { code?: number; message?: string };
};

function jsonRpcErrorMessage(payload: JsonRpcResponse, fallback: string): string {
  if (payload.error?.message?.trim()) {
    return payload.error.message.trim();
  }
  return fallback;
}

export async function parseMcpHttpResponse(response: Response): Promise<JsonRpcResponse> {
  const contentType = response.headers.get("content-type") ?? "";
  const text = await response.text();
  if (!text.trim()) {
    throw new Error(`Empty MCP response (${response.status}).`);
  }
  if (contentType.includes("text/event-stream") || text.startsWith("event:") || text.includes("\ndata:")) {
    const dataLines = text
      .split(/\r?\n/)
      .filter((line) => line.startsWith("data:"))
      .map((line) => line.slice(5).trim())
      .filter(Boolean);
    const last = dataLines.at(-1);
    if (!last) {
      throw new Error("Streamable MCP response had no JSON-RPC data frames.");
    }
    return JSON.parse(last) as JsonRpcResponse;
  }
  return JSON.parse(text) as JsonRpcResponse;
}

export async function postMcpJsonRpc(input: {
  url: string;
  headers?: Record<string, string>;
  method: string;
  params?: Record<string, unknown>;
  protocolVersion: string;
  mcpName?: string;
  includeStatelessHeaders?: boolean;
  includeMeta?: boolean;
}): Promise<{ status: number; payload: JsonRpcResponse }> {
  const params = { ...(input.params ?? {}) };
  if (input.includeMeta) {
    params._meta = mcpProtocolMeta(input.protocolVersion);
  }
  const headers: Record<string, string> = {
    ...(input.headers ?? {}),
    Accept: "application/json, text/event-stream",
    "Content-Type": "application/json",
    "MCP-Protocol-Version": input.protocolVersion,
  };
  if (input.includeStatelessHeaders) {
    headers["Mcp-Method"] = input.method;
    if (input.mcpName) {
      headers["Mcp-Name"] = input.mcpName;
    }
  }
  const response = await fetch(input.url, {
    method: "POST",
    headers,
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: Date.now(),
      method: input.method,
      params,
    }),
  });
  if (response.status === 401 || response.status === 403) {
    throw new Error(`MCP server requires authentication (${response.status}).`);
  }
  let payload: JsonRpcResponse;
  try {
    payload = await parseMcpHttpResponse(response);
  } catch (error) {
    throw new Error(
      `MCP ${input.method} returned HTTP ${response.status}: ${
        error instanceof Error ? error.message : String(error)
      }`
    );
  }
  if (!response.ok && !payload.result && payload.error) {
    throw new Error(jsonRpcErrorMessage(payload, `HTTP ${response.status}`));
  }
  return { status: response.status, payload };
}

export async function probeStatelessHttp(
  url: string,
  headers: Record<string, string>
): Promise<McpProtocolProbeResult> {
  try {
    const discover = await postMcpJsonRpc({
      url,
      headers,
      method: "server/discover",
      protocolVersion: MCP_STATELESS_PROTOCOL_VERSION,
      includeStatelessHeaders: true,
      includeMeta: true,
    });
    if (discover.payload.result) {
      return { era: "stateless", version: MCP_STATELESS_PROTOCOL_VERSION, ok: true };
    }
    const list = await postMcpJsonRpc({
      url,
      headers,
      method: "tools/list",
      protocolVersion: MCP_STATELESS_PROTOCOL_VERSION,
      includeStatelessHeaders: true,
      includeMeta: true,
    });
    if (list.payload.result) {
      return { era: "stateless", version: MCP_STATELESS_PROTOCOL_VERSION, ok: true };
    }
    return {
      era: "stateless",
      version: MCP_STATELESS_PROTOCOL_VERSION,
      ok: false,
      error: jsonRpcErrorMessage(list.payload, "server/discover and tools/list failed"),
    };
  } catch (error) {
    return {
      era: "stateless",
      version: MCP_STATELESS_PROTOCOL_VERSION,
      ok: false,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

export async function probeSessionHttp(
  url: string,
  headers: Record<string, string>
): Promise<McpProtocolProbeResult> {
  try {
    const init = await postMcpJsonRpc({
      url,
      headers,
      method: "initialize",
      protocolVersion: MCP_SESSION_PROTOCOL_VERSION,
      includeStatelessHeaders: false,
      includeMeta: false,
      params: {
        protocolVersion: MCP_SESSION_PROTOCOL_VERSION,
        capabilities: {},
        clientInfo: MCP_CLIENT_INFO,
      },
    });
    const result = isRecord(init.payload.result) ? init.payload.result : null;
    const version =
      typeof result?.protocolVersion === "string"
        ? result.protocolVersion
        : MCP_SESSION_PROTOCOL_VERSION;
    if (result && (result.protocolVersion || result.capabilities || result.serverInfo)) {
      return { era: "session", version, ok: true };
    }
    return {
      era: "session",
      version: MCP_SESSION_PROTOCOL_VERSION,
      ok: false,
      error: jsonRpcErrorMessage(init.payload, "initialize produced no protocol result"),
    };
  } catch (error) {
    return {
      era: "session",
      version: MCP_SESSION_PROTOCOL_VERSION,
      ok: false,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

export type StatelessHttpMcpClient = {
  listTools: () => Promise<{ tools: Array<Record<string, unknown>> }>;
  callTool: (input: {
    name: string;
    arguments?: Record<string, unknown>;
  }) => Promise<{ content?: unknown }>;
  getInstructions: () => Promise<string | undefined>;
};

export function createStatelessHttpMcpClient(input: {
  url: string;
  headers: Record<string, string>;
}): StatelessHttpMcpClient {
  let cachedInstructions: string | undefined;
  const rpc = async (
    method: string,
    params: Record<string, unknown> = {},
    mcpName?: string
  ): Promise<unknown> => {
    const { payload } = await postMcpJsonRpc({
      url: input.url,
      headers: input.headers,
      method,
      params,
      protocolVersion: MCP_STATELESS_PROTOCOL_VERSION,
      includeStatelessHeaders: true,
      includeMeta: true,
      mcpName,
    });
    if (payload.error) {
      throw new Error(jsonRpcErrorMessage(payload, `${method} failed`));
    }
    return payload.result;
  };

  return {
    async listTools() {
      const result = await rpc("tools/list");
      const tools =
        isRecord(result) && Array.isArray(result.tools)
          ? (result.tools as Array<Record<string, unknown>>)
          : [];
      return { tools };
    },
    async callTool(call) {
      const result = await rpc(
        "tools/call",
        { name: call.name, arguments: call.arguments ?? {} },
        call.name
      );
      return isRecord(result) ? result : { content: result };
    },
    async getInstructions() {
      if (cachedInstructions !== undefined) {
        return cachedInstructions;
      }
      try {
        const result = await rpc("server/discover");
        cachedInstructions =
          isRecord(result) && typeof result.instructions === "string"
            ? result.instructions
            : undefined;
      } catch {
        cachedInstructions = undefined;
      }
      return cachedInstructions;
    },
  };
}
