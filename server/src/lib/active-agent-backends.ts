import type { AgentBackendId } from "./agents/types.js";

/** Harness backends exposed in composer, agents settings, and model toggles. */
export const ACTIVE_AGENT_BACKEND_IDS = [
  "cesium-agent",
  "cursor-sdk",
  "codex-app-server",
  "opencode-server",
  "opencode-v2-beta",
  "devin-acp",
  "claude-code-sdk",
  "pi-agent",
  "google-antigravity-cli",
] as const satisfies readonly AgentBackendId[];

/** Retired ACP/adapter harness ids kept only for migration of stored settings. */
export const LEGACY_AGENT_BACKEND_IDS = [
  "cursor-acp",
  "claude-adapter",
  "opencode-acp",
  "codex-adapter",
  "gemini-acp",
] as const;

const ACTIVE_SET = new Set<string>(ACTIVE_AGENT_BACKEND_IDS);
const LEGACY_SET = new Set<string>(LEGACY_AGENT_BACKEND_IDS);

export function isActiveAgentBackendId(backendId: string): backendId is AgentBackendId {
  return ACTIVE_SET.has(backendId);
}

export function isLegacyAgentBackendId(backendId: string): boolean {
  return LEGACY_SET.has(backendId);
}

export function pruneModelToggleByBackend<T extends { backendId?: string }>(
  byBackend: Record<string, T[]>
): Record<string, T[]> {
  const pruned: Record<string, T[]> = {};
  for (const [backendId, entries] of Object.entries(byBackend)) {
    if (!isActiveAgentBackendId(backendId)) {
      continue;
    }
    if (Array.isArray(entries) && entries.length > 0) {
      pruned[backendId] = entries;
    }
  }
  return pruned;
}
