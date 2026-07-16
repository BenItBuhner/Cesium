import type { McpServerConfig } from "@cesium/core/mcp";
import type { AgentBackendId } from "../agents/types.js";
import { readJsonFile, writeJsonFile } from "../persistence.js";
import { getMcpPreset } from "../mcp/presets.js";
import { getMcpServer, listMcpServers, upsertMcpServer } from "../mcp/server-store.js";
import { slugifyMcpServerId } from "../mcp/paths.js";
import { getBuiltInAgentPlugin, listBuiltInAgentPlugins } from "./catalog.js";
import { getDiscoveredAgentPlugin } from "./discovery.js";
import { standardHarnessSupport } from "./harness-support.js";
import { agentPluginsConfigPath } from "./paths.js";
import type {
  AgentPluginDefinition,
  AgentPluginHarnessOverride,
  AgentPluginInstallRecord,
  AgentPluginPublic,
  AgentPluginsFile,
} from "./types.js";
import { syncWorkspaceAntigravityMcpConfig } from "./workspace-mcp-sync.js";

function emptyPluginsFile(): AgentPluginsFile {
  return {
    schemaVersion: 1,
    updatedAt: 0,
    installs: [],
  };
}

async function readPluginsFile(workspaceId: string): Promise<AgentPluginsFile> {
  const stored = await readJsonFile<AgentPluginsFile | null>(
    agentPluginsConfigPath(workspaceId),
    null
  );
  if (!stored || stored.schemaVersion !== 1 || !Array.isArray(stored.installs)) {
    return emptyPluginsFile();
  }
  return stored;
}

async function writePluginsFile(workspaceId: string, file: AgentPluginsFile): Promise<void> {
  await writeJsonFile(agentPluginsConfigPath(workspaceId), {
    ...file,
    schemaVersion: 1,
    updatedAt: Date.now(),
  });
}

function normalizePluginId(value: string): string {
  return slugifyMcpServerId(value).slice(0, 64);
}

function normalizeDefinition(definition: AgentPluginDefinition): AgentPluginDefinition {
  return {
    ...definition,
    schemaVersion: 1,
    pluginId: normalizePluginId(definition.pluginId || definition.displayName),
    displayName: definition.displayName.trim() || "Custom Plugin",
    description: definition.description.trim(),
    mcp: Array.isArray(definition.mcp) ? definition.mcp : [],
    skills: Array.isArray(definition.skills) ? definition.skills : [],
    harnesses: definition.harnesses ?? standardHarnessSupport(),
  };
}

function installDefinition(record: AgentPluginInstallRecord): AgentPluginDefinition | null {
  return record.customDefinition ? normalizeDefinition(record.customDefinition) : null;
}

async function updateInstall(
  workspaceId: string,
  updater: (file: AgentPluginsFile, now: number) => AgentPluginsFile
): Promise<AgentPluginsFile> {
  const now = Date.now();
  const current = await readPluginsFile(workspaceId);
  const next = updater(current, now);
  await writePluginsFile(workspaceId, next);
  return next;
}

export async function listAgentPluginInstalls(
  workspaceId: string
): Promise<AgentPluginInstallRecord[]> {
  return (await readPluginsFile(workspaceId)).installs;
}

export async function getAgentPluginDefinition(
  workspaceId: string,
  pluginId: string
): Promise<AgentPluginDefinition | null> {
  const builtIn = getBuiltInAgentPlugin(pluginId);
  if (builtIn) return builtIn;
  const install = (await readPluginsFile(workspaceId)).installs.find(
    (entry) => entry.pluginId === pluginId
  );
  if (install) {
    const custom = installDefinition(install);
    if (custom) return custom;
  }
  return getDiscoveredAgentPlugin(pluginId);
}

export async function listAgentPluginDefinitions(
  workspaceId: string
): Promise<AgentPluginDefinition[]> {
  const file = await readPluginsFile(workspaceId);
  const custom = file.installs
    .map((record) => installDefinition(record))
    .filter((definition): definition is AgentPluginDefinition => Boolean(definition));
  return [...listBuiltInAgentPlugins(), ...custom];
}

export async function listAgentPluginsPublic(
  workspaceId: string
): Promise<AgentPluginPublic[]> {
  const [definitions, file, servers] = await Promise.all([
    listAgentPluginDefinitions(workspaceId),
    readPluginsFile(workspaceId),
    listMcpServers(workspaceId),
  ]);
  return definitions.map((definition) => {
    const install = file.installs.find((entry) => entry.pluginId === definition.pluginId) ?? null;
    return {
      definition,
      install,
      enabled: install?.enabled ?? false,
      managedMcpServerIds: servers
        .filter((server) => server.pluginId === definition.pluginId)
        .map((server) => server.id),
    };
  });
}

export async function installAgentPlugin(
  workspaceId: string,
  pluginId: string,
  customDefinition?: AgentPluginDefinition
): Promise<AgentPluginInstallRecord> {
  const normalizedPluginId = normalizePluginId(pluginId);
  const definition =
    customDefinition ? normalizeDefinition(customDefinition) : await getAgentPluginDefinition(workspaceId, normalizedPluginId);
  if (!definition) {
    throw new Error(`Unknown plugin: ${pluginId}`);
  }
  let saved: AgentPluginInstallRecord | null = null;
  await updateInstall(workspaceId, (file, now) => {
    const existing = file.installs.find((entry) => entry.pluginId === definition.pluginId);
    const nextRecord: AgentPluginInstallRecord = {
      schemaVersion: 1,
      workspaceId,
      pluginId: definition.pluginId,
      enabled: true,
      customDefinition: definition.builtIn ? undefined : definition,
      harnessOverrides: existing?.harnessOverrides ?? [],
      installedAt: existing?.installedAt ?? now,
      updatedAt: now,
    };
    saved = nextRecord;
    return {
      ...file,
      installs: [
        ...file.installs.filter((entry) => entry.pluginId !== definition.pluginId),
        nextRecord,
      ],
    };
  });
  await syncAgentPluginMcpServers(workspaceId, definition, true);
  return saved!;
}

async function maybeSyncAntigravityMcp(workspaceId: string, workspaceRoot?: string): Promise<void> {
  if (!workspaceRoot?.trim()) return;
  try {
    await syncWorkspaceAntigravityMcpConfig({ workspaceId, workspaceRoot });
  } catch {
    // Workspace root may be unavailable during pure unit tests; harness resolve path retries.
  }
}

export async function setAgentPluginEnabled(
  workspaceId: string,
  pluginId: string,
  enabled: boolean
): Promise<AgentPluginInstallRecord> {
  const definition = await getAgentPluginDefinition(workspaceId, pluginId);
  if (!definition) {
    throw new Error(`Unknown plugin: ${pluginId}`);
  }
  let saved: AgentPluginInstallRecord | null = null;
  await updateInstall(workspaceId, (file, now) => {
    const existing = file.installs.find((entry) => entry.pluginId === pluginId);
    if (!existing) {
      throw new Error(`Plugin is not installed: ${pluginId}`);
    }
    const nextRecord: AgentPluginInstallRecord = {
      ...existing,
      enabled,
      updatedAt: now,
    };
    saved = nextRecord;
    return {
      ...file,
      installs: [...file.installs.filter((entry) => entry.pluginId !== pluginId), nextRecord],
    };
  });
  await syncAgentPluginMcpServers(workspaceId, definition, enabled);
  return saved!;
}

export async function setAgentPluginHarnessOverride(
  workspaceId: string,
  pluginId: string,
  backendId: AgentBackendId,
  enabled: boolean
): Promise<AgentPluginInstallRecord> {
  let saved: AgentPluginInstallRecord | null = null;
  await updateInstall(workspaceId, (file, now) => {
    const existing = file.installs.find((entry) => entry.pluginId === pluginId);
    if (!existing) {
      throw new Error(`Plugin is not installed: ${pluginId}`);
    }
    const override: AgentPluginHarnessOverride = { backendId, enabled, updatedAt: now };
    const nextRecord: AgentPluginInstallRecord = {
      ...existing,
      harnessOverrides: [
        ...existing.harnessOverrides.filter((entry) => entry.backendId !== backendId),
        override,
      ],
      updatedAt: now,
    };
    saved = nextRecord;
    return {
      ...file,
      installs: [...file.installs.filter((entry) => entry.pluginId !== pluginId), nextRecord],
    };
  });
  return saved!;
}

export async function deleteAgentPluginInstall(
  workspaceId: string,
  pluginId: string
): Promise<boolean> {
  const definition = await getAgentPluginDefinition(workspaceId, pluginId);
  const file = await readPluginsFile(workspaceId);
  const nextInstalls = file.installs.filter((entry) => entry.pluginId !== pluginId);
  if (nextInstalls.length === file.installs.length) {
    return false;
  }
  await writePluginsFile(workspaceId, {
    ...file,
    installs: nextInstalls,
  });
  if (definition) {
    await syncAgentPluginMcpServers(workspaceId, definition, false);
  }
  return true;
}

function pluginMcpServerId(
  definition: AgentPluginDefinition,
  contributionId: string,
  config: { id?: string; label?: string; presetId?: string }
): string {
  return slugifyMcpServerId(
    config.id ??
      config.presetId ??
      `${definition.pluginId}-${contributionId || config.label || "mcp"}`
  );
}

export async function syncAgentPluginMcpServers(
  workspaceId: string,
  definition: AgentPluginDefinition,
  enabled: boolean,
  workspaceRoot?: string
): Promise<McpServerConfig[]> {
  const saved: McpServerConfig[] = [];
  for (const contribution of definition.mcp) {
    const preset = contribution.presetId ? getMcpPreset(contribution.presetId) : null;
    const serverInput = contribution.server;
    if (!preset && !serverInput) {
      continue;
    }
    const base = {
      ...(preset?.config ?? {}),
      ...(serverInput ?? {}),
    } as Omit<McpServerConfig, "id" | "enabled" | "createdAt" | "updatedAt"> & {
      id?: string;
    };
    const id = pluginMcpServerId(definition, contribution.id, {
      id: base.id,
      label: preset?.label,
      presetId: preset?.presetId,
    });
    const existing = await getMcpServer(workspaceId, id);
    const next = await upsertMcpServer(workspaceId, {
      ...base,
      ...(existing ?? {}),
      id,
      label: existing?.label ?? serverInput?.label ?? preset?.label ?? definition.displayName,
      enabled,
      presetId: preset?.presetId ?? base.presetId,
      pluginId: definition.pluginId,
      pluginContributionId: contribution.id,
      displayName: definition.displayName,
      iconUrl: definition.iconUrl,
      auth: existing?.auth ?? base.auth ?? { kind: "none" },
      transport: base.transport ?? existing?.transport ?? "streamable-http",
    });
    saved.push(next);
  }
  await maybeSyncAntigravityMcp(workspaceId, workspaceRoot);
  return saved;
}
