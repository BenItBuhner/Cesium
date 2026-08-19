import { promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { listBuiltInAgentPlugins } from "./catalog.js";
import { standardHarnessSupport } from "./harness-support.js";
import type { AgentPluginDefinition } from "./types.js";

import { fetchOfficialMcpRegistryPlugins } from "./official-registry.js";
import { listPluginRegistrySources } from "./sources.js";

export type AgentPluginRegistrySource =
  | "builtin"
  | "local"
  | "remote"
  | "github"
  | "official-mcp";

export type AgentPluginDiscoveryEntry = {
  definition: AgentPluginDefinition;
  source: AgentPluginRegistrySource;
  sourceLabel: string;
  installed?: boolean;
};

export type AgentPluginRegistryDocument = {
  schemaVersion: 1;
  source?: string;
  updatedAt?: string;
  description?: string;
  plugins: AgentPluginDefinition[];
};

export type AgentPluginDiscoveryResult = {
  query: string;
  sources: Array<{
    id: AgentPluginRegistrySource;
    label: string;
    url?: string;
    pluginCount: number;
    error?: string;
  }>;
  plugins: AgentPluginDiscoveryEntry[];
  total?: number;
  offset?: number;
  limit?: number;
};

const LOCAL_REGISTRY_PATH = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "local-registry.json"
);

function normalizeDefinition(definition: AgentPluginDefinition): AgentPluginDefinition {
  return {
    ...definition,
    schemaVersion: 1,
    pluginId: definition.pluginId.trim(),
    displayName: definition.displayName.trim() || definition.pluginId,
    description: definition.description?.trim() || "",
    mcp: Array.isArray(definition.mcp) ? definition.mcp : [],
    skills: Array.isArray(definition.skills) ? definition.skills : [],
    harnesses: definition.harnesses ?? standardHarnessSupport(),
  };
}

function matchesQuery(definition: AgentPluginDefinition, query: string): boolean {
  const q = query.trim().toLowerCase();
  if (!q) return true;
  const haystack = [
    definition.pluginId,
    definition.displayName,
    definition.description,
    definition.marketplace?.publisher,
    ...definition.skills.map((skill) => `${skill.title} ${skill.description}`),
    ...definition.mcp.map((mcp) => mcp.presetId ?? mcp.id),
  ]
    .filter(Boolean)
    .join(" ")
    .toLowerCase();
  return haystack.includes(q);
}

async function readRegistryFile(filePath: string): Promise<AgentPluginRegistryDocument> {
  const raw = await fs.readFile(filePath, "utf8");
  const parsed = JSON.parse(raw) as AgentPluginRegistryDocument;
  if (parsed?.schemaVersion !== 1 || !Array.isArray(parsed.plugins)) {
    throw new Error(`Invalid plugin registry at ${filePath}`);
  }
  return parsed;
}

async function fetchRemoteRegistry(url: string): Promise<AgentPluginRegistryDocument> {
  const response = await fetch(url, {
    headers: {
      Accept: "application/json",
      "User-Agent": "cesium-plugin-discovery",
    },
  });
  if (!response.ok) {
    throw new Error(`Registry fetch failed (${response.status}) for ${url}`);
  }
  const parsed = (await response.json()) as AgentPluginRegistryDocument;
  if (parsed?.schemaVersion !== 1 || !Array.isArray(parsed.plugins)) {
    throw new Error(`Invalid remote plugin registry at ${url}`);
  }
  return parsed;
}

function githubRawRegistryUrl(repo: string, registryPath = "plugins/registry.json"): string {
  const cleaned = repo.trim().replace(/^https?:\/\/github\.com\//i, "").replace(/\.git$/, "");
  const [owner, name] = cleaned.split("/").filter(Boolean);
  if (!owner || !name) {
    throw new Error(
      `Invalid OPENCURSOR_PLUGIN_GITHUB_REPO value "${repo}". Expected owner/repo.`
    );
  }
  const branch = process.env.OPENCURSOR_PLUGIN_GITHUB_BRANCH?.trim() || "main";
  const filePath = (registryPath || process.env.OPENCURSOR_PLUGIN_GITHUB_PATH?.trim() || "plugins/registry.json").replace(
    /^\/+/,
    ""
  );
  return `https://raw.githubusercontent.com/${owner}/${name}/${branch}/${filePath}`;
}

async function loadOptionalSources(): Promise<{
  entries: AgentPluginDiscoveryEntry[];
  sources: AgentPluginDiscoveryResult["sources"];
}> {
  const entries: AgentPluginDiscoveryEntry[] = [];
  const sources: AgentPluginDiscoveryResult["sources"] = [];

  try {
    const local = await readRegistryFile(LOCAL_REGISTRY_PATH);
    const plugins = local.plugins.map(normalizeDefinition);
    sources.push({
      id: "local",
      label: "Local registry",
      pluginCount: plugins.length,
    });
    for (const definition of plugins) {
      entries.push({
        definition,
        source: "local",
        sourceLabel: "Local registry",
      });
    }
  } catch (error) {
    sources.push({
      id: "local",
      label: "Local registry",
      pluginCount: 0,
      error: error instanceof Error ? error.message : "Failed to load local registry.",
    });
  }

  const configured = await listPluginRegistrySources();
  for (const source of configured.filter((entry) => entry.enabled)) {
    try {
      if (source.kind === "official-mcp") {
        const plugins = (await fetchOfficialMcpRegistryPlugins({ url: source.url })).map(
          normalizeDefinition
        );
        sources.push({
          id: "official-mcp",
          label: source.label,
          url: source.url,
          pluginCount: plugins.length,
        });
        for (const definition of plugins) {
          entries.push({
            definition,
            source: "official-mcp",
            sourceLabel: source.label,
          });
        }
        continue;
      }
      if (source.kind === "file" && source.path) {
        const file = await readRegistryFile(path.resolve(source.path));
        const plugins = file.plugins.map(normalizeDefinition);
        sources.push({
          id: "local",
          label: source.label,
          url: source.path,
          pluginCount: plugins.length,
        });
        for (const definition of plugins) {
          entries.push({
            definition,
            source: "local",
            sourceLabel: source.label,
          });
        }
        continue;
      }
      const url =
        source.kind === "github" && source.repo
          ? githubRawRegistryUrl(source.repo, source.path)
          : source.url;
      if (!url) {
        throw new Error("Registry source is missing a URL.");
      }
      const remote = await fetchRemoteRegistry(url);
      const plugins = remote.plugins.map(normalizeDefinition);
      const id = source.kind === "github" ? "github" : "remote";
      sources.push({
        id,
        label: source.label,
        url,
        pluginCount: plugins.length,
      });
      for (const definition of plugins) {
        entries.push({
          definition,
          source: id,
          sourceLabel: source.label,
        });
      }
    } catch (error) {
      sources.push({
        id:
          source.kind === "official-mcp"
            ? "official-mcp"
            : source.kind === "github"
              ? "github"
              : source.kind === "file"
                ? "local"
                : "remote",
        label: source.label,
        url: source.url ?? source.path,
        pluginCount: 0,
        error: error instanceof Error ? error.message : "Failed to load registry.",
      });
    }
  }

  return { entries, sources };
}

export async function discoverAgentPlugins(input?: {
  query?: string;
  limit?: number;
  offset?: number;
}): Promise<AgentPluginDiscoveryResult> {
  const query = input?.query?.trim() ?? "";
  const builtin = listBuiltInAgentPlugins().map((definition) => ({
    definition: normalizeDefinition(definition),
    source: "builtin" as const,
    sourceLabel: "Built-in catalog",
  }));

  const optional = await loadOptionalSources();
  const byId = new Map<string, AgentPluginDiscoveryEntry>();

  for (const entry of [...builtin, ...optional.entries]) {
    if (!matchesQuery(entry.definition, query)) continue;
    const existing = byId.get(entry.definition.pluginId);
    const existingRank = existing?.source === "builtin" ? 2 : existing?.source === "official-mcp" ? 0 : 1;
    const nextRank = entry.source === "builtin" ? 2 : entry.source === "official-mcp" ? 0 : 1;
    if (!existing || nextRank > existingRank) {
      byId.set(entry.definition.pluginId, entry);
    }
  }

  const allPlugins = [...byId.values()].sort((a, b) =>
    a.definition.displayName.localeCompare(b.definition.displayName)
  );
  const offset = Math.max(0, input?.offset ?? 0);
  const limit = Math.max(1, Math.min(input?.limit ?? 50, 200));
  const plugins = allPlugins.slice(offset, offset + limit);

  return {
    query,
    sources: [
      {
        id: "builtin",
        label: "Built-in catalog",
        pluginCount: builtin.length,
      },
      ...optional.sources,
    ],
    plugins,
    total: allPlugins.length,
    offset,
    limit,
  };
}

export async function getDiscoveredAgentPlugin(
  pluginId: string
): Promise<AgentPluginDefinition | null> {
  const discovery = await discoverAgentPlugins();
  return (
    discovery.plugins.find((entry) => entry.definition.pluginId === pluginId)?.definition ?? null
  );
}
