import path from "node:path";
import { randomUUID } from "node:crypto";
import { DATA_DIR, readJsonFile, writeJsonFile } from "../persistence.js";

export type PluginRegistrySourceKind = "official-mcp" | "url" | "github" | "file";

export type PluginRegistrySource = {
  id: string;
  kind: PluginRegistrySourceKind;
  enabled: boolean;
  label: string;
  url?: string;
  repo?: string;
  path?: string;
};

type PluginRegistrySourcesFile = {
  schemaVersion: 1;
  updatedAt: number;
  sources: PluginRegistrySource[];
};

function sourcesPath(): string {
  return path.join(DATA_DIR, "profile", "plugin-registry-sources.json");
}

function envDefaultSources(): PluginRegistrySource[] {
  const sources: PluginRegistrySource[] = [
    {
      id: "official-mcp",
      kind: "official-mcp",
      enabled:
        process.env.NODE_TEST_CONTEXT || process.env.NODE_ENV === "test"
          ? process.env.OPENCURSOR_PLUGIN_OFFICIAL_REGISTRY === "1"
          : process.env.OPENCURSOR_PLUGIN_OFFICIAL_REGISTRY !== "0",
      label: "Official MCP Registry",
      url: "https://registry.modelcontextprotocol.io/v0/servers",
    },
  ];
  const remoteUrl = process.env.OPENCURSOR_PLUGIN_REGISTRY_URL?.trim();
  if (remoteUrl) {
    sources.push({
      id: "env-url",
      kind: "url",
      enabled: true,
      label: "Remote registry",
      url: remoteUrl,
    });
  }
  const githubRepo = process.env.OPENCURSOR_PLUGIN_GITHUB_REPO?.trim();
  if (githubRepo) {
    sources.push({
      id: "env-github",
      kind: "github",
      enabled: true,
      label: `GitHub (${githubRepo})`,
      repo: githubRepo,
      path: process.env.OPENCURSOR_PLUGIN_GITHUB_PATH?.trim() || "plugins/registry.json",
    });
  }
  const registryFile = process.env.OPENCURSOR_PLUGIN_REGISTRY_FILE?.trim();
  if (registryFile) {
    sources.push({
      id: "env-file",
      kind: "file",
      enabled: true,
      label: `File registry (${path.basename(registryFile)})`,
      path: registryFile,
    });
  }
  return sources;
}

function mergeSources(
  stored: PluginRegistrySource[],
  defaults: PluginRegistrySource[]
): PluginRegistrySource[] {
  const byId = new Map(stored.map((source) => [source.id, source]));
  for (const fallback of defaults) {
    if (!byId.has(fallback.id)) {
      byId.set(fallback.id, fallback);
    }
  }
  return [...byId.values()];
}

export async function listPluginRegistrySources(): Promise<PluginRegistrySource[]> {
  const stored = await readJsonFile<PluginRegistrySourcesFile | null>(sourcesPath(), null);
  const defaults = envDefaultSources();
  if (!stored || stored.schemaVersion !== 1 || !Array.isArray(stored.sources)) {
    return defaults;
  }
  return mergeSources(stored.sources, defaults);
}

export async function savePluginRegistrySources(
  sources: PluginRegistrySource[]
): Promise<PluginRegistrySource[]> {
  const normalized = sources.map((source) => ({
    ...source,
    id: source.id.trim() || randomUUID(),
    label: source.label.trim() || source.kind,
    enabled: source.enabled !== false,
  }));
  await writeJsonFile(sourcesPath(), {
    schemaVersion: 1,
    updatedAt: Date.now(),
    sources: normalized,
  } satisfies PluginRegistrySourcesFile);
  return normalized;
}

export async function addPluginRegistrySource(
  input: Omit<PluginRegistrySource, "id"> & { id?: string }
): Promise<PluginRegistrySource[]> {
  const current = await listPluginRegistrySources();
  const next: PluginRegistrySource = {
    ...input,
    id: input.id?.trim() || randomUUID(),
    enabled: input.enabled !== false,
  };
  return savePluginRegistrySources([
    ...current.filter((source) => source.id !== next.id),
    next,
  ]);
}

export async function removePluginRegistrySource(sourceId: string): Promise<PluginRegistrySource[]> {
  const current = await listPluginRegistrySources();
  return savePluginRegistrySources(current.filter((source) => source.id !== sourceId));
}
