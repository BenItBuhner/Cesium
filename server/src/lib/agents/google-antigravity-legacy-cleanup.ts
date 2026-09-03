import { promises as fs } from "node:fs";
import path from "node:path";

/**
 * Removes what the retired `google-antigravity-cli` terminal bridge injected
 * into a workspace's `.agents/` directory:
 *
 * - `.opencursor-antigravity-hook.cjs` + `.opencursor-antigravity-events.jsonl`
 *   (the hook helper and its JSONL sink),
 * - the `opencursor-antigravity-event-bridge` entry inside `hooks.json`
 *   (which auto-allowed every `PreToolUse`),
 * - Cesium-managed servers written into `mcp_config.json` (tracked by
 *   `.cesium-plugin-mcp.json`), since the official ACP server receives MCP
 *   servers natively through `session/new` and would otherwise see duplicates.
 *
 * User-authored hooks and MCP entries are preserved. Runs at most once per
 * workspace root per process; every step is best-effort.
 */

const HOOK_NAME = "opencursor-antigravity-event-bridge";
const HELPER_FILE = ".opencursor-antigravity-hook.cjs";
const SINK_FILE = ".opencursor-antigravity-events.jsonl";
const MCP_MARKER_FILE = ".cesium-plugin-mcp.json";

export type LegacyAntigravityCleanupResult = {
  removedFiles: string[];
  hooksJsonUpdated: boolean;
  mcpConfigUpdated: boolean;
};

const cleanedRoots = new Set<string>();

/** Test hook. */
export function resetLegacyAntigravityCleanupForTest(): void {
  cleanedRoots.clear();
}

async function readJson(filePath: string): Promise<Record<string, unknown> | null> {
  try {
    const parsed = JSON.parse(await fs.readFile(filePath, "utf8")) as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

async function removeIfPresent(filePath: string, removed: string[]): Promise<void> {
  try {
    await fs.rm(filePath, { force: false });
    removed.push(filePath);
  } catch {
    // missing or unreadable - nothing to do
  }
}

async function cleanupHooksJson(agentsDir: string, removed: string[]): Promise<boolean> {
  const hooksPath = path.join(agentsDir, "hooks.json");
  const hooks = await readJson(hooksPath);
  if (!hooks || !(HOOK_NAME in hooks)) {
    return false;
  }
  const { [HOOK_NAME]: _legacy, ...rest } = hooks;
  void _legacy;
  if (Object.keys(rest).length === 0) {
    await removeIfPresent(hooksPath, removed);
  } else {
    await fs.writeFile(hooksPath, `${JSON.stringify(rest, null, 2)}\n`, "utf8");
  }
  return true;
}

async function cleanupManagedMcpConfig(agentsDir: string, removed: string[]): Promise<boolean> {
  const markerPath = path.join(agentsDir, MCP_MARKER_FILE);
  const marker = await readJson(markerPath);
  if (!marker) {
    return false;
  }
  const managedIds = Array.isArray(marker.managedServerIds)
    ? marker.managedServerIds.filter((id): id is string => typeof id === "string")
    : [];
  const configPath = path.join(agentsDir, "mcp_config.json");
  const config = await readJson(configPath);
  let updated = false;
  if (config && config.mcpServers && typeof config.mcpServers === "object" && !Array.isArray(config.mcpServers)) {
    const servers = { ...(config.mcpServers as Record<string, unknown>) };
    for (const id of managedIds) {
      if (id in servers) {
        delete servers[id];
        updated = true;
      }
    }
    if (updated) {
      if (Object.keys(servers).length === 0 && Object.keys(config).length === 1) {
        await removeIfPresent(configPath, removed);
      } else {
        await fs.writeFile(
          configPath,
          `${JSON.stringify({ ...config, mcpServers: servers }, null, 2)}\n`,
          "utf8"
        );
      }
    }
  }
  await removeIfPresent(markerPath, removed);
  return updated;
}

export async function cleanupLegacyAntigravityWorkspaceArtifacts(
  workspaceRoot: string,
  options: { force?: boolean } = {}
): Promise<LegacyAntigravityCleanupResult> {
  const root = path.resolve(workspaceRoot);
  const result: LegacyAntigravityCleanupResult = {
    removedFiles: [],
    hooksJsonUpdated: false,
    mcpConfigUpdated: false,
  };
  if (!options.force && cleanedRoots.has(root)) {
    return result;
  }
  cleanedRoots.add(root);
  const agentsDir = path.join(root, ".agents");
  try {
    if (!(await fs.stat(agentsDir)).isDirectory()) {
      return result;
    }
  } catch {
    return result;
  }
  await removeIfPresent(path.join(agentsDir, HELPER_FILE), result.removedFiles);
  await removeIfPresent(path.join(agentsDir, SINK_FILE), result.removedFiles);
  try {
    for (const name of await fs.readdir(agentsDir)) {
      if (/^hooks\.json\.\d+\.tmp$/.test(name)) {
        await removeIfPresent(path.join(agentsDir, name), result.removedFiles);
      }
    }
  } catch {
    // unreadable dir
  }
  result.hooksJsonUpdated = await cleanupHooksJson(agentsDir, result.removedFiles).catch(() => false);
  result.mcpConfigUpdated = await cleanupManagedMcpConfig(agentsDir, result.removedFiles).catch(
    () => false
  );
  return result;
}
