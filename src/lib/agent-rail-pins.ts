/** Global pin list: agent rail pins are cross-workspace; session-per-workspace storage would drop them on workspace switch. */

export const AGENT_RAIL_PINNED_IDS_STORAGE_KEY = "opencursor.agent-rail.pinned-conversation-ids";

import {
  buildServerScopedStorageKey,
  createDefaultServerConnection,
  getActiveServerConnectionSnapshot,
} from "@/lib/server-connections";

const LEGACY_WORKSPACE_SESSION_PREFIX = "opencursor.workspace-session.";
const WORKSPACE_SESSION_PREFIX = "workspace-session.";

const pinnedIdsSnapshotByServerId = new Map<string, string[]>();
const pinnedIdsSnapshotKeyByServerId = new Map<string, string>();

const listeners = new Set<() => void>();

function emitPinnedIdsChanged() {
  pinnedIdsSnapshotByServerId.clear();
  pinnedIdsSnapshotKeyByServerId.clear();
  for (const listener of listeners) {
    listener();
  }
}

function resolveServerId(serverId?: string | null): string {
  return serverId ?? getActiveServerConnectionSnapshot().id;
}

function isDefaultServerId(serverId: string): boolean {
  return serverId === createDefaultServerConnection().id;
}

function getPinnedIdsStorageKey(serverId?: string | null): string {
  return buildServerScopedStorageKey(
    AGENT_RAIL_PINNED_IDS_STORAGE_KEY,
    resolveServerId(serverId)
  );
}

function getWorkspaceSessionStoragePrefix(serverId: string): string {
  return buildServerScopedStorageKey(WORKSPACE_SESSION_PREFIX, serverId);
}

export function normalizePinnedAgentConversationIds(raw: unknown): string[] {
  if (!Array.isArray(raw)) {
    return [];
  }
  const next: string[] = [];
  const seen = new Set<string>();
  for (const item of raw) {
    if (typeof item !== "string" || item.length === 0 || seen.has(item)) {
      continue;
    }
    seen.add(item);
    next.push(item);
  }
  return next;
}

function parseStoredPinnedIds(raw: string | null): string[] {
  if (!raw) {
    return [];
  }
  try {
    return normalizePinnedAgentConversationIds(JSON.parse(raw) as unknown);
  } catch {
    return [];
  }
}

export function getGlobalPinnedAgentConversationIdsSnapshot(
  serverId?: string | null
): string[] {
  if (typeof window === "undefined") {
    return [];
  }
  const resolvedServerId = resolveServerId(serverId);
  const parsed = parseStoredPinnedIds(
    window.localStorage.getItem(getPinnedIdsStorageKey(resolvedServerId))
  );
  const key = JSON.stringify(parsed);
  if (key !== pinnedIdsSnapshotKeyByServerId.get(resolvedServerId)) {
    pinnedIdsSnapshotKeyByServerId.set(resolvedServerId, key);
    pinnedIdsSnapshotByServerId.set(resolvedServerId, parsed);
  }
  return pinnedIdsSnapshotByServerId.get(resolvedServerId) ?? parsed;
}

export function subscribeGlobalPinnedAgentConversationIds(onStoreChange: () => void): () => void {
  if (typeof window === "undefined") {
    return () => {};
  }
  listeners.add(onStoreChange);
  return () => {
    listeners.delete(onStoreChange);
  };
}

export function writeGlobalPinnedAgentConversationIds(
  ids: string[],
  serverId?: string | null
): void {
  if (typeof window === "undefined") {
    return;
  }
  const resolvedServerId = resolveServerId(serverId);
  const normalized = normalizePinnedAgentConversationIds(ids);
  try {
    window.localStorage.setItem(
      getPinnedIdsStorageKey(resolvedServerId),
      JSON.stringify(normalized)
    );
    if (isDefaultServerId(resolvedServerId)) {
      window.localStorage.removeItem(AGENT_RAIL_PINNED_IDS_STORAGE_KEY);
    }
  } catch {
    return;
  }
  emitPinnedIdsChanged();
}

/**
 * Seed global pins from legacy per-workspace session keys (and optional React session fallback)
 * when the global key is missing or empty.
 */
export function migrateGlobalPinnedAgentConversationIdsIfNeeded(
  workspaceSessionPinnedFallback?: string[] | null,
  serverId?: string | null
): void {
  if (typeof window === "undefined") {
    return;
  }
  const resolvedServerId = resolveServerId(serverId);
  const existing = parseStoredPinnedIds(
    window.localStorage.getItem(getPinnedIdsStorageKey(resolvedServerId))
  );
  if (existing.length > 0) {
    return;
  }

  if (isDefaultServerId(resolvedServerId)) {
    const legacyPinned = parseStoredPinnedIds(
      window.localStorage.getItem(AGENT_RAIL_PINNED_IDS_STORAGE_KEY)
    );
    if (legacyPinned.length > 0) {
      writeGlobalPinnedAgentConversationIds(legacyPinned, resolvedServerId);
      try {
        window.localStorage.removeItem(AGENT_RAIL_PINNED_IDS_STORAGE_KEY);
      } catch {
        // Ignore cleanup failures and continue using the scoped key.
      }
      return;
    }
  }

  const keys: string[] = [];
  const scopedWorkspaceSessionPrefix = getWorkspaceSessionStoragePrefix(resolvedServerId);
  for (let i = 0; i < window.localStorage.length; i += 1) {
    const k = window.localStorage.key(i);
    if (
      k?.startsWith(scopedWorkspaceSessionPrefix) ||
      (isDefaultServerId(resolvedServerId) && k?.startsWith(LEGACY_WORKSPACE_SESSION_PREFIX))
    ) {
      keys.push(k);
    }
  }
  keys.sort();

  const ordered: string[] = [];
  const seen = new Set<string>();
  for (const storageKey of keys) {
    const raw = window.localStorage.getItem(storageKey);
    if (!raw) {
      continue;
    }
    try {
      const doc = JSON.parse(raw) as { session?: { agentView?: { pinnedAgentConversationIds?: unknown } } };
      const pinned = doc?.session?.agentView?.pinnedAgentConversationIds;
      if (!Array.isArray(pinned)) {
        continue;
      }
      for (const id of pinned) {
        if (typeof id === "string" && id.length > 0 && !seen.has(id)) {
          seen.add(id);
          ordered.push(id);
        }
      }
    } catch {
      continue;
    }
  }

  if (workspaceSessionPinnedFallback) {
    for (const id of workspaceSessionPinnedFallback) {
      if (typeof id === "string" && id.length > 0 && !seen.has(id)) {
        seen.add(id);
        ordered.push(id);
      }
    }
  }

  if (ordered.length === 0) {
    return;
  }
  writeGlobalPinnedAgentConversationIds(ordered, resolvedServerId);
}
