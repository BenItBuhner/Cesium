import { asRecord, parseJsonArgs, pickFirstString } from "./cesium-coerce";

/** Server id of the built-in browser MCP server (`call_mcp_tool` routing). */
export const CESIUM_BROWSER_MCP_SERVER_ID = "browser";

const CALL_MCP_SERVER_ID_KEYS = [
  "serverId",
  "server_id",
  "server",
  "mcpServerId",
  "mcp_server_id",
] as const;

const CALL_MCP_TOOL_NAME_KEYS = [
  "toolName",
  "tool_name",
  "tool",
  "mcpTool",
  "mcp_tool",
] as const;

function omitCallMcpRoutingFields(record: Record<string, unknown>): Record<string, unknown> {
  const next = { ...record };
  for (const key of [
    ...CALL_MCP_SERVER_ID_KEYS,
    ...CALL_MCP_TOOL_NAME_KEYS,
    "arguments",
  ]) {
    delete next[key];
  }
  return next;
}

export type NormalizedCallMcpToolArgs = {
  serverId: string;
  toolName: string;
  arguments: Record<string, unknown>;
};

/** Accept common LLM/provider shapes for call_mcp_tool routing and MCP tool args. */
export function normalizeCallMcpToolArgs(raw: Record<string, unknown>): NormalizedCallMcpToolArgs {
  const nested = asRecord(raw.arguments);
  const rawServerId =
    pickFirstString(raw, CALL_MCP_SERVER_ID_KEYS) ??
    pickFirstString(nested, CALL_MCP_SERVER_ID_KEYS) ??
    "";
  const serverId =
    rawServerId.toLowerCase() === CESIUM_BROWSER_MCP_SERVER_ID ? CESIUM_BROWSER_MCP_SERVER_ID : rawServerId;
  const toolName =
    pickFirstString(raw, CALL_MCP_TOOL_NAME_KEYS) ??
    pickFirstString(nested, CALL_MCP_TOOL_NAME_KEYS) ??
    "";

  let toolArgs: Record<string, unknown> = {};
  if (nested) {
    const nestedServerId = pickFirstString(nested, CALL_MCP_SERVER_ID_KEYS);
    const nestedToolName = pickFirstString(nested, CALL_MCP_TOOL_NAME_KEYS);
    if (nestedServerId || nestedToolName) {
      toolArgs = omitCallMcpRoutingFields(nested);
    } else if (Object.keys(nested).length > 0) {
      toolArgs = nested;
    }
  }
  if (Object.keys(toolArgs).length === 0) {
    toolArgs = omitCallMcpRoutingFields(raw);
  }

  return { serverId, toolName, arguments: toolArgs };
}

function callMcpToolArgsToRecord(normalized: NormalizedCallMcpToolArgs): Record<string, unknown> {
  return {
    serverId: normalized.serverId,
    toolName: normalized.toolName,
    arguments: normalized.arguments,
  };
}

export function normalizeCesiumToolRequestArguments(
  name: string,
  args: Record<string, unknown>
): Record<string, unknown> {
  if (name !== "call_mcp_tool") {
    return args;
  }
  return callMcpToolArgsToRecord(normalizeCallMcpToolArgs(args));
}

export function inferCesiumToolNameFromTitle(title: string | undefined): string | undefined {
  const trimmed = title?.trim();
  if (!trimmed) {
    return undefined;
  }
  if (/^refresh mcp servers$/i.test(trimmed)) {
    return "refresh_mcp_servers";
  }
  if (/^(MCP|Browser)\s+/i.test(trimmed)) {
    return "call_mcp_tool";
  }
  return undefined;
}

export function serializeToolCallArguments(
  name: string,
  args: unknown,
  detail?: string | null
): string {
  const parsed =
    typeof args === "string"
      ? parseJsonArgs(args)
      : asRecord(args) ?? {};
  const normalizedArgs =
    name === "call_mcp_tool"
      ? callMcpToolArgsToRecord(normalizeCallMcpToolArgs(parsed))
      : parsed;
  if (Object.keys(normalizedArgs).length > 0) {
    return JSON.stringify(normalizedArgs);
  }
  if (name === "call_mcp_tool" && detail?.trim()) {
    const fromDetail = normalizeCallMcpToolArgs(parseJsonArgs(detail));
    if (fromDetail.serverId && fromDetail.toolName) {
      return JSON.stringify(callMcpToolArgsToRecord(fromDetail));
    }
  }
  if (detail?.trim()) {
    const fromDetail = asRecord(parseJsonArgs(detail)) ?? {};
    if (Object.keys(fromDetail).length > 0) {
      return JSON.stringify(fromDetail);
    }
  }
  return "{}";
}
