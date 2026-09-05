/**
 * "Last opened workspace per server" is an account setting
 * (`GlobalSettingsState.general.lastWorkspaceByServer`), so switching servers
 * on any device resumes where the account left off. This module keeps the pure
 * map helpers plus the one-time read of the pre-account per-device store.
 */

export const LEGACY_LAST_WORKSPACE_BY_SERVER_STORAGE_KEY = "opencursor.last-workspace-by-server";

export type LastWorkspaceByServer = Record<string, string>;

export function normalizeLastWorkspaceByServer(raw: unknown): LastWorkspaceByServer {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return {};
  }
  const result: LastWorkspaceByServer = {};
  for (const [serverId, workspaceId] of Object.entries(raw as Record<string, unknown>)) {
    if (typeof serverId === "string" && serverId.trim() && typeof workspaceId === "string" && workspaceId.trim()) {
      result[serverId] = workspaceId;
    }
  }
  return result;
}

/** Returns the same map when nothing changes so settings updates can short-circuit. */
export function withLastWorkspaceForServer(
  map: LastWorkspaceByServer,
  serverId: string,
  workspaceId: string
): LastWorkspaceByServer {
  if (!serverId.trim() || !workspaceId.trim() || map[serverId] === workspaceId) {
    return map;
  }
  return { ...map, [serverId]: workspaceId };
}

export function getLastWorkspaceForServer(
  map: LastWorkspaceByServer,
  serverId: string
): string | null {
  return map[serverId] ?? null;
}

/** Pre-account map this device stored, or `null` when it never existed. */
export function readLegacyLastWorkspaceByServer(): LastWorkspaceByServer | null {
  if (typeof localStorage === "undefined") {
    return null;
  }
  try {
    const raw = localStorage.getItem(LEGACY_LAST_WORKSPACE_BY_SERVER_STORAGE_KEY);
    if (raw === null) {
      return null;
    }
    return normalizeLastWorkspaceByServer(JSON.parse(raw) as unknown);
  } catch {
    return null;
  }
}

export function clearLegacyLastWorkspaceByServer(): void {
  if (typeof localStorage === "undefined") {
    return;
  }
  try {
    localStorage.removeItem(LEGACY_LAST_WORKSPACE_BY_SERVER_STORAGE_KEY);
  } catch {
    // Nothing to do; the legacy key is only ever consulted once.
  }
}
