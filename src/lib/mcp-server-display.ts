import type { WorkedSessionEntry } from "@/lib/types";

/** Well-known MCP preset ids → display labels (matches server presets). */
const KNOWN_MCP_PRESET_LABELS: Record<string, string> = {
  context7: "Context7",
  linear: "Linear",
  notion: "Notion",
  figma: "Figma",
  slack: "Slack",
  todoist: "Todoist",
};

const MCP_SERVER_ID_KEYS = [
  "serverId",
  "server_id",
  "mcpServerId",
  "mcp_server_id",
  "server",
] as const;

const MCP_TOOL_TITLE_RE = /^MCP\s+(.+?)\s+-\s+/i;
const MCP_TOOL_DOT_TITLE_RE = /^(.+?)\s+·\s+/;

function asNonEmptyString(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function findMcpServerIdInRecord(record: Record<string, unknown> | undefined): string | undefined {
  if (!record) {
    return undefined;
  }
  for (const key of MCP_SERVER_ID_KEYS) {
    const value = asNonEmptyString(record[key]);
    if (value) {
      return value;
    }
  }
  return undefined;
}

/** Normalize directory-style ids (e.g. plugin-context7-plugin-context7 → context7). */
export function normalizeMcpServerId(raw: string): string {
  let id = raw.trim().toLowerCase();
  while (id.startsWith("plugin-")) {
    id = id.slice("plugin-".length);
  }
  while (id.startsWith("mcp-")) {
    id = id.slice("mcp-".length);
  }
  const parts = id.split("-").filter(Boolean);
  if (parts.length >= 2 && parts.length % 2 === 0) {
    const half = parts.length / 2;
    const first = parts.slice(0, half).join("-");
    const second = parts.slice(half).join("-");
    if (first && first === second) {
      return first;
    }
  }
  const mirrored = id.match(/^(.+)-plugin-\1$/);
  if (mirrored?.[1]) {
    return mirrored[1];
  }
  const redundantPlugin = id.match(/^([a-z0-9][a-z0-9_-]*)-plugin-[a-z0-9][a-z0-9_-]*$/);
  if (redundantPlugin?.[1]) {
    return redundantPlugin[1];
  }
  return id;
}

function titleCaseMcpToken(token: string): string {
  if (!token) {
    return token;
  }
  if (/^\d+$/.test(token)) {
    return token;
  }
  if (token.length <= 4 && /^[a-z0-9]+$/.test(token)) {
    return token.charAt(0).toUpperCase() + token.slice(1);
  }
  return token.charAt(0).toUpperCase() + token.slice(1);
}

/** Human-readable MCP server name from a config / tool server id. */
export function formatMcpServerDisplayName(serverId: string): string {
  const normalized = normalizeMcpServerId(serverId);
  if (KNOWN_MCP_PRESET_LABELS[normalized]) {
    return KNOWN_MCP_PRESET_LABELS[normalized];
  }
  for (const [presetId, label] of Object.entries(KNOWN_MCP_PRESET_LABELS)) {
    if (
      normalized === presetId ||
      normalized.endsWith(`-${presetId}`) ||
      normalized.startsWith(`${presetId}-`)
    ) {
      return label;
    }
  }
  return normalized
    .split(/[-_]+/)
    .filter(Boolean)
    .map(titleCaseMcpToken)
    .join(" ");
}

export function extractMcpServerIdFromTitle(title: string | undefined): string | undefined {
  if (!title?.trim()) {
    return undefined;
  }
  const cesium = title.match(MCP_TOOL_TITLE_RE);
  if (cesium?.[1]) {
    return cesium[1].trim();
  }
  return undefined;
}

export function extractMcpServerIdFromRecords(
  records: Array<Record<string, unknown> | undefined>
): string | undefined {
  for (const record of records) {
    const fromRecord = findMcpServerIdInRecord(record);
    if (fromRecord) {
      return fromRecord;
    }
    const nestedRequest =
      record?.request && typeof record.request === "object"
        ? (record.request as Record<string, unknown>)
        : undefined;
    const fromRequest = findMcpServerIdInRecord(nestedRequest);
    if (fromRequest) {
      return fromRequest;
    }
    const nestedArgs =
      record?.arguments && typeof record.arguments === "object"
        ? (record.arguments as Record<string, unknown>)
        : undefined;
    const fromArgs = findMcpServerIdInRecord(nestedArgs);
    if (fromArgs) {
      return fromArgs;
    }
  }
  return undefined;
}

export function extractMcpServerIdFromWorkedTool(
  tool: Extract<WorkedSessionEntry, { kind: "tool" }>
): string | undefined {
  if (tool.mcpServerId?.trim()) {
    return tool.mcpServerId.trim();
  }
  const fromTitle = extractMcpServerIdFromTitle(tool.title);
  if (fromTitle) {
    return fromTitle;
  }
  const dotTitle = tool.title?.match(MCP_TOOL_DOT_TITLE_RE);
  if (dotTitle?.[1] && !/^(mcp|server)$/i.test(dotTitle[1].trim())) {
    return dotTitle[1].trim();
  }
  return undefined;
}

function joinNaturalLanguage(parts: string[]): string {
  if (parts.length <= 1) {
    return parts[0] ?? "";
  }
  if (parts.length === 2) {
    return `${parts[0]} and ${parts[1]}`;
  }
  return `${parts.slice(0, -1).join(", ")} and ${parts[parts.length - 1]}`;
}

function mcpServerCountPhrase(displayName: string, count: number): string {
  return count === 1 ? displayName : `${displayName} ${count} times`;
}

/** Session summary from per-server call counts (server id → count). */
export function summarizeMcpServerCounts(serverCounts: Map<string, number>): string {
  const tools = [...serverCounts.entries()].flatMap(([serverId, count]) =>
    Array.from({ length: count }, () => ({
      kind: "tool" as const,
      title: "",
      mcpServerId: serverId === "__unknown__" ? undefined : serverId,
    }))
  );
  return summarizeMcpWorkedTools(tools);
}

/** Session summary fragment for one or more MCP tool calls (e.g. "called Context7 2 times"). */
export function summarizeMcpWorkedTools(
  tools: Extract<WorkedSessionEntry, { kind: "tool" }>[]
): string {
  if (tools.some((tool) => /refresh mcp servers/i.test(tool.title))) {
    return tools.length === 1 ? "refreshed MCP servers" : "refreshed MCP servers";
  }
  const countsByDisplay = new Map<string, number>();
  let unknownCount = 0;
  for (const tool of tools) {
    const serverId = extractMcpServerIdFromWorkedTool(tool);
    if (!serverId) {
      unknownCount += 1;
      continue;
    }
    const display = formatMcpServerDisplayName(serverId);
    countsByDisplay.set(display, (countsByDisplay.get(display) ?? 0) + 1);
  }
  if (countsByDisplay.size === 0) {
    const total = tools.length;
    return total === 1 ? "called MCP tool" : "called MCP tools";
  }
  const phrases = [...countsByDisplay.entries()].map(([name, count]) =>
    mcpServerCountPhrase(name, count)
  );
  if (unknownCount > 0) {
    phrases.push(mcpServerCountPhrase("MCP", unknownCount));
  }
  return `called ${joinNaturalLanguage(phrases)}`;
}

export function isMcpWorkedTool(tool: Extract<WorkedSessionEntry, { kind: "tool" }>): boolean {
  if (tool.toolKind === "mcp") {
    return true;
  }
  const title = tool.title?.toLowerCase() ?? "";
  if (title.startsWith("mcp ") || /^mcp\b/.test(title)) {
    return true;
  }
  if (/refresh mcp servers/i.test(tool.title ?? "")) {
    return true;
  }
  if (extractMcpServerIdFromWorkedTool(tool)) {
    return true;
  }
  return false;
}
