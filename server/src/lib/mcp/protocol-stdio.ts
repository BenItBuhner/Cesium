import { spawn } from "node:child_process";
import { ReadBuffer, serializeMessage } from "@modelcontextprotocol/sdk/shared/stdio.js";
import {
  MCP_CLIENT_INFO,
  MCP_SESSION_PROTOCOL_VERSION,
  MCP_STATELESS_PROTOCOL_VERSION,
  mcpProtocolMeta,
  type McpProtocolProbeResult,
} from "./protocol.js";

const STDIO_PROBE_MS = 4_000;

type JsonRpcResponse = {
  jsonrpc?: string;
  id?: unknown;
  result?: unknown;
  error?: { message?: string };
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

async function stdioRpcOnce(input: {
  command: string;
  args: string[];
  env?: Record<string, string>;
  cwd: string;
  method: string;
  params: Record<string, unknown>;
  timeoutMs?: number;
}): Promise<JsonRpcResponse> {
  const child = spawn(input.command, input.args, {
    cwd: input.cwd,
    env: { ...process.env, ...(input.env ?? {}) },
    stdio: ["pipe", "pipe", "pipe"],
  });
  const buffer = new ReadBuffer();
  try {
    return await new Promise<JsonRpcResponse>((resolve, reject) => {
      const timer = setTimeout(() => {
        reject(new Error(`stdio ${input.method} timed out`));
      }, input.timeoutMs ?? STDIO_PROBE_MS);
      const finish = (error?: Error, value?: JsonRpcResponse) => {
        clearTimeout(timer);
        if (error) reject(error);
        else resolve(value!);
      };
      child.stdout?.on("data", (chunk: Buffer) => {
        buffer.append(chunk);
        try {
          const message = buffer.readMessage();
          if (message && "result" in message) {
            finish(undefined, message as JsonRpcResponse);
          } else if (message && "error" in message) {
            finish(undefined, message as JsonRpcResponse);
          }
        } catch (error) {
          finish(error instanceof Error ? error : new Error(String(error)));
        }
      });
      child.on("error", (error) => finish(error));
      child.on("exit", (code) => {
        finish(new Error(`stdio process exited during ${input.method} (code ${code}).`));
      });
      const request = {
        jsonrpc: "2.0" as const,
        id: 1,
        method: input.method,
        params: input.params,
      };
      child.stdin?.write(serializeMessage(request));
    });
  } finally {
    child.kill("SIGTERM");
  }
}

export async function probeStatelessStdio(input: {
  command: string;
  args: string[];
  env?: Record<string, string>;
  cwd: string;
}): Promise<McpProtocolProbeResult> {
  try {
    const discover = await stdioRpcOnce({
      ...input,
      method: "server/discover",
      params: { _meta: mcpProtocolMeta() },
    });
    if (discover.result) {
      return { era: "stateless", version: MCP_STATELESS_PROTOCOL_VERSION, ok: true };
    }
    const list = await stdioRpcOnce({
      ...input,
      method: "tools/list",
      params: { _meta: mcpProtocolMeta() },
    });
    if (list.result) {
      return { era: "stateless", version: MCP_STATELESS_PROTOCOL_VERSION, ok: true };
    }
    return {
      era: "stateless",
      version: MCP_STATELESS_PROTOCOL_VERSION,
      ok: false,
      error: discover.error?.message || list.error?.message || "stdio server rejected stateless RPCs",
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

export type StatelessStdioMcpClient = {
  listTools: () => Promise<{ tools: Array<Record<string, unknown>> }>;
  callTool: (input: {
    name: string;
    arguments?: Record<string, unknown>;
  }) => Promise<{ content?: unknown }>;
  getInstructions: () => Promise<string | undefined>;
  close: () => Promise<void>;
};

export function createStatelessStdioMcpClient(input: {
  command: string;
  args: string[];
  env?: Record<string, string>;
  cwd: string;
}): StatelessStdioMcpClient {
  const child = spawn(input.command, input.args, {
    cwd: input.cwd,
    env: { ...process.env, ...(input.env ?? {}) },
    stdio: ["pipe", "pipe", "pipe"],
  });
  const buffer = new ReadBuffer();
  let nextId = 1;
  const pending = new Map<number, (value: JsonRpcResponse) => void>();
  let cachedInstructions: string | undefined;

  child.stdout?.on("data", (chunk: Buffer) => {
    buffer.append(chunk);
    for (;;) {
      let message: ReturnType<ReadBuffer["readMessage"]>;
      try {
        message = buffer.readMessage();
      } catch {
        break;
      }
      if (!message) break;
      if ("id" in message && typeof message.id === "number") {
        pending.get(message.id)?.(message as JsonRpcResponse);
        pending.delete(message.id);
      }
    }
  });

  const rpc = (method: string, params: Record<string, unknown>) =>
    new Promise<unknown>((resolve, reject) => {
      const id = nextId++;
      const timer = setTimeout(() => {
        pending.delete(id);
        reject(new Error(`stdio ${method} timed out`));
      }, 30_000);
      pending.set(id, (message) => {
        clearTimeout(timer);
        if (message.error) {
          reject(new Error(message.error.message || `${method} failed`));
          return;
        }
        resolve(message.result);
      });
      child.stdin?.write(
        serializeMessage({
          jsonrpc: "2.0",
          id,
          method,
          params: { ...params, _meta: mcpProtocolMeta() },
        })
      );
    });

  return {
    async listTools() {
      const result = await rpc("tools/list", {});
      const tools =
        isRecord(result) && Array.isArray(result.tools)
          ? (result.tools as Array<Record<string, unknown>>)
          : [];
      return { tools };
    },
    async callTool(call) {
      const result = await rpc("tools/call", {
        name: call.name,
        arguments: call.arguments ?? {},
      });
      return isRecord(result) ? result : { content: result };
    },
    async getInstructions() {
      if (cachedInstructions !== undefined) return cachedInstructions;
      try {
        const result = await rpc("server/discover", {});
        cachedInstructions =
          isRecord(result) && typeof result.instructions === "string"
            ? result.instructions
            : undefined;
      } catch {
        cachedInstructions = undefined;
      }
      return cachedInstructions;
    },
    async close() {
      child.kill("SIGTERM");
    },
  };
}

export async function probeSessionStdio(input: {
  command: string;
  args: string[];
  env?: Record<string, string>;
  cwd: string;
}): Promise<McpProtocolProbeResult> {
  try {
    const init = await stdioRpcOnce({
      ...input,
      method: "initialize",
      params: {
        protocolVersion: MCP_SESSION_PROTOCOL_VERSION,
        capabilities: {},
        clientInfo: MCP_CLIENT_INFO,
      },
    });
    const result = isRecord(init.result) ? init.result : null;
    if (result && (result.protocolVersion || result.capabilities || result.serverInfo)) {
      return {
        era: "session",
        version:
          typeof result.protocolVersion === "string"
            ? result.protocolVersion
            : MCP_SESSION_PROTOCOL_VERSION,
        ok: true,
      };
    }
    return {
      era: "session",
      version: MCP_SESSION_PROTOCOL_VERSION,
      ok: false,
      error: init.error?.message || "initialize produced no protocol result",
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
