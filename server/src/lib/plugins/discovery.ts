import { promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { listBuiltInAgentPlugins } from "./catalog.js";
import { standardHarnessSupport } from "./harness-support.js";
import type { AgentPluginDefinition } from "./types.js";

export type AgentPluginRegistrySource =
  | "builtin"
  | "local"
  | "remote"
  | "github";

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
  const filePath = (
    process.env.OPENCURSOR_PLUGIN_GITHUB_PATH?.trim() || registryPath
  ).replace(/^\/+/, "");
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

  const registryFile = process.env.OPENCURSOR_PLUGIN_REGISTRY_FILE?.trim();
  if (registryFile) {
    try {
      const file = await readRegistryFile(path.resolve(registryFile));
      const plugins = file.plugins.map(normalizeDefinition);
      sources.push({
        id: "local",
        label: `File registry (${path.basename(registryFile)})`,
        url: registryFile,
        pluginCount: plugins.length,
      });
      for (const definition of plugins) {
        entries.push({
          definition,
          source: "local",
          sourceLabel: path.basename(registryFile),
        });
      }
    } catch (error) {
      sources.push({
        id: "local",
        label: `File registry (${path.basename(registryFile)})`,
        url: registryFile,
        pluginCount: 0,
        error: error instanceof Error ? error.message : "Failed to load file registry.",
      });
    }
  }

  const remoteUrl = process.env.OPENCURSOR_PLUGIN_REGISTRY_URL?.trim();
  if (remoteUrl) {
    try {
      const remote = await fetchRemoteRegistry(remoteUrl);
      const plugins = remote.plugins.map(normalizeDefinition);
      sources.push({
        id: "remote",
        label: "Remote registry",
        url: remoteUrl,
        pluginCount: plugins.length,
      });
      for (const definition of plugins) {
        entries.push({
          definition,
          source: "remote",
          sourceLabel: "Remote registry",
        });
      }
    } catch (error) {
      sources.push({
        id: "remote",
        label: "Remote registry",
        url: remoteUrl,
        pluginCount: 0,
        error: error instanceof Error ? error.message : "Failed to load remote registry.",
      });
    }
  }

  const githubRepo = process.env.OPENCURSOR_PLUGIN_GITHUB_REPO?.trim();
  if (githubRepo) {
    let url = "";
    try {
      url = githubRawRegistryUrl(githubRepo);
      const remote = await fetchRemoteRegistry(url);
      const plugins = remote.plugins.map(normalizeDefinition);
      sources.push({
        id: "github",
        label: `GitHub (${githubRepo})`,
        url,
        pluginCount: plugins.length,
      });
      for (const definition of plugins) {
        entries.push({
          definition,
          source: "github",
          sourceLabel: `GitHub/${githubRepo}`,
        });
      }
    } catch (error) {
      sources.push({
        id: "github",
        label: `GitHub (${githubRepo})`,
        url: url || undefined,
        pluginCount: 0,
        error: error instanceof Error ? error.message : "Failed to load GitHub registry.",
      });
    }
  }

  return { entries, sources };
}

export async function discoverAgentPlugins(input?: {
  query?: string;
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
    // Prefer built-in definitions when ids collide; otherwise keep first remote hit.
    if (!existing || (existing.source !== "builtin" && entry.source === "builtin")) {
      byId.set(entry.definition.pluginId, entry);
    }
  }

  const plugins = [...byId.values()].sort((a, b) =>
    a.definition.displayName.localeCompare(b.definition.displayName)
  );

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
