/** Global pin list: agent rail pins are cross-workspace; session-per-workspace storage would drop them on workspace switch. */

export const AGENT_RAIL_PINNED_IDS_STORAGE_KEY = "opencursor.agent-rail.pinned-conversation-ids";

const WORKSPACE_SESSION_PREFIX = "opencursor.workspace-session.";

let pinnedIdsSnapshot: string[] = [];
let pinnedIdsSnapshotKey = "";

const listeners = new Set<() => void>();

function emitPinnedIdsChanged() {
  pinnedIdsSnapshotKey = "";
  for (const listener of listeners) {
    listener();
  }
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

export function getGlobalPinnedAgentConversationIdsSnapshot(): string[] {
  if (typeof window === "undefined") {
    return [];
  }
  const parsed = parseStoredPinnedIds(
    window.localStorage.getItem(AGENT_RAIL_PINNED_IDS_STORAGE_KEY)
  );
  const key = JSON.stringify(parsed);
  if (key !== pinnedIdsSnapshotKey) {
    pinnedIdsSnapshotKey = key;
    pinnedIdsSnapshot = parsed;
  }
  return pinnedIdsSnapshot;
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

export function writeGlobalPinnedAgentConversationIds(ids: string[]): void {
  if (typeof window === "undefined") {
    return;
  }
  const normalized = normalizePinnedAgentConversationIds(ids);
  try {
    window.localStorage.setItem(
      AGENT_RAIL_PINNED_IDS_STORAGE_KEY,
      JSON.stringify(normalized)
    );
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
  workspaceSessionPinnedFallback?: string[] | null
): void {
  if (typeof window === "undefined") {
    return;
  }
  const existing = parseStoredPinnedIds(
    window.localStorage.getItem(AGENT_RAIL_PINNED_IDS_STORAGE_KEY)
  );
  if (existing.length > 0) {
    return;
  }

  const keys: string[] = [];
  for (let i = 0; i < window.localStorage.length; i += 1) {
    const k = window.localStorage.key(i);
    if (k?.startsWith(WORKSPACE_SESSION_PREFIX)) {
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
  writeGlobalPinnedAgentConversationIds(ordered);
}
