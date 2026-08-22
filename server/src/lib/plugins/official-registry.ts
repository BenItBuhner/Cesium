import { slugifyMcpServerId } from "../mcp/paths.js";
import { standardHarnessSupport } from "./harness-support.js";
import type { AgentPluginDefinition } from "./types.js";

const DEFAULT_OFFICIAL_REGISTRY_URL = "https://registry.modelcontextprotocol.io/v0/servers";

type OfficialRemote = {
  type?: string;
  url?: string;
};

type OfficialPackage = {
  registryType?: string;
  identifier?: string;
  version?: string;
  transport?: { type?: string };
};

type OfficialServer = {
  name?: string;
  title?: string;
  description?: string;
  repository?: { url?: string };
  remotes?: OfficialRemote[];
  packages?: OfficialPackage[];
  icons?: Array<{ src?: string }>;
};

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function unwrapServer(entry: unknown): OfficialServer | null {
  const record = asRecord(entry);
  if (!record) return null;
  const nested = asRecord(record.server);
  const server = (nested ?? record) as OfficialServer;
  if (!server.name && !server.title) return null;
  return server;
}

function pluginIdFromName(name: string): string {
  const last = name.split("/").pop() ?? name;
  return slugifyMcpServerId(last.replace(/^io\./, ""));
}

export function mapOfficialMcpServerToPlugin(entry: unknown): AgentPluginDefinition | null {
  const server = unwrapServer(entry);
  if (!server) return null;
  const name = server.name?.trim() || server.title?.trim() || "";
  if (!name) return null;
  const pluginId = pluginIdFromName(name);
  const remote = server.remotes?.find((item) => item.url?.trim());
  const npmPackage = server.packages?.find(
    (item) => item.registryType === "npm" && item.identifier?.trim()
  );
  const mcp: AgentPluginDefinition["mcp"] = [];
  if (remote?.url) {
    const transport =
      remote.type === "sse" || remote.type === "legacy-sse" ? "sse" : "streamable-http";
    mcp.push({
      id: pluginId,
      server: {
        label: server.title?.trim() || pluginId,
        transport,
        remote: { url: remote.url.trim() },
        auth: { kind: "none" },
        summary: server.description?.trim() || `${server.title ?? pluginId} MCP server`,
      },
    });
  } else if (npmPackage?.identifier) {
    mcp.push({
      id: pluginId,
      server: {
        label: server.title?.trim() || pluginId,
        transport: "stdio",
        stdio: {
          command: "npx",
          args: ["-y", npmPackage.identifier.trim()],
        },
        auth: { kind: "none" },
        summary: server.description?.trim() || `${server.title ?? pluginId} MCP server`,
      },
    });
  } else {
    return null;
  }

  return {
    schemaVersion: 1,
    pluginId,
    displayName: server.title?.trim() || pluginId,
    description: server.description?.trim() || `MCP server ${name}`,
    iconUrl: server.icons?.[0]?.src,
    marketplace: {
      id: name,
      publisher: name.includes("/") ? name.split("/")[0] : "MCP Registry",
    },
    mcp,
    skills: [],
    harnesses: standardHarnessSupport(),
  };
}

export async function fetchOfficialMcpRegistryPlugins(input?: {
  url?: string;
  query?: string;
  limit?: number;
}): Promise<AgentPluginDefinition[]> {
  const base = input?.url?.trim() || DEFAULT_OFFICIAL_REGISTRY_URL;
  const url = new URL(base);
  url.searchParams.set("limit", String(input?.limit ?? 80));
  if (input?.query?.trim()) {
    url.searchParams.set("search", input.query.trim());
  }
  const response = await fetch(url, {
    headers: {
      Accept: "application/json",
      "User-Agent": "cesium-plugin-discovery",
    },
  });
  if (!response.ok) {
    throw new Error(`Official MCP registry fetch failed (${response.status}).`);
  }
  const payload = (await response.json()) as { servers?: unknown[]; data?: unknown[] };
  const rows = Array.isArray(payload.servers)
    ? payload.servers
    : Array.isArray(payload.data)
      ? payload.data
      : [];
  const plugins: AgentPluginDefinition[] = [];
  for (const row of rows) {
    const plugin = mapOfficialMcpServerToPlugin(row);
    if (plugin) plugins.push(plugin);
  }
  return plugins;
}
