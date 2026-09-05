import type { AgentBackendId, AgentBackendInfo } from "./protocol";

/** Harness backends exposed in composer, agents settings, and model toggles. */
export const ACTIVE_AGENT_BACKEND_IDS = [
  "cesium-agent",
  "cursor-sdk",
  "cursor-acp",
  "codex-app-server",
  "codex-acp",
  "opencode-server",
  "devin-acp",
  "grok-build",
  "claude-code-sdk",
  "pi-agent",
  "google-antigravity-acp",
  "google-antigravity-cli",
] as const satisfies readonly AgentBackendId[];

/** Retired ACP/adapter harness ids kept only for migration of stored settings. */
export const LEGACY_AGENT_BACKEND_IDS = [
  "claude-adapter",
  "opencode-acp",
  "opencode-v2-beta",
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

/** Missing keys default to enabled so existing installs keep every harness. */
export function isHarnessEnabled(
  enabledHarnesses: Partial<Record<string, boolean>> | undefined,
  backendId: string
): boolean {
  if (!enabledHarnesses || !(backendId in enabledHarnesses)) {
    return true;
  }
  return enabledHarnesses[backendId] !== false;
}

export function normalizeEnabledHarnesses(raw: unknown): Partial<Record<string, boolean>> {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return {};
  }
  const out: Partial<Record<string, boolean>> = {};
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    const backendId = key.trim();
    if (!backendId || typeof value !== "boolean") {
      continue;
    }
    out[backendId] = value;
  }
  return out;
}

export function composerVisibleBackends<T extends { id: string; enabled?: boolean }>(
  backends: T[],
  currentBackendId?: string | null
): T[] {
  return backends.filter(
    (backend) => backend.enabled !== false || backend.id === currentBackendId
  );
}

/**
 * Best backend to start a conversation on: the preferred one when it is
 * available, otherwise the first available enabled harness, then any available
 * harness, then whatever is listed first.
 */
export function pickAvailableBackend(
  backends: AgentBackendInfo[],
  preferredBackendId?: AgentBackendId
): AgentBackendInfo | null {
  return (
    backends.find((backend) => backend.id === preferredBackendId && backend.available) ??
    backends.find((backend) => backend.available && backend.enabled !== false) ??
    backends.find((backend) => backend.available) ??
    backends[0] ??
    null
  );
}
