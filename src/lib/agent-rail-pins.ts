/**
 * Agent rail pins are account-wide: `GlobalSettingsState.general.pinnedAgentConversationIds`
 * is the single home, synced to every device. This module keeps the pure list
 * helpers plus the one-time read of the pre-account per-device stores (a
 * global localStorage list, and before that per-workspace session backups).
 */

export const LEGACY_AGENT_RAIL_PINNED_IDS_STORAGE_KEY =
  "opencursor.agent-rail.pinned-conversation-ids";

const LEGACY_WORKSPACE_SESSION_PREFIX = "opencursor.workspace-session.";

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

/** Pin `conversationId` to the top (most recent first); unchanged list when already first. */
export function pinAgentConversationId(pinned: string[], conversationId: string): string[] {
  if (pinned[0] === conversationId) {
    return pinned;
  }
  return [conversationId, ...pinned.filter((id) => id !== conversationId)];
}

export function unpinAgentConversationId(pinned: string[], conversationId: string): string[] {
  return pinned.includes(conversationId) ? pinned.filter((id) => id !== conversationId) : pinned;
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

/**
 * Pins this device remembered before they were account-wide: the global
 * localStorage list first, then any per-workspace session backups (the store
 * before that). Returns `null` when neither ever existed.
 */
export function readLegacyPinnedAgentConversationIds(
  workspaceSessionPinnedFallback?: string[] | null
): string[] | null {
  if (typeof window === "undefined") {
    return null;
  }
  let found = false;
  const ordered: string[] = [];
  const seen = new Set<string>();
  const push = (id: unknown) => {
    if (typeof id === "string" && id.length > 0 && !seen.has(id)) {
      seen.add(id);
      ordered.push(id);
    }
  };

  const globalRaw = window.localStorage.getItem(LEGACY_AGENT_RAIL_PINNED_IDS_STORAGE_KEY);
  if (globalRaw !== null) {
    found = true;
    for (const id of parseStoredPinnedIds(globalRaw)) {
      push(id);
    }
  }

  const keys: string[] = [];
  for (let i = 0; i < window.localStorage.length; i += 1) {
    const k = window.localStorage.key(i);
    if (k?.startsWith(LEGACY_WORKSPACE_SESSION_PREFIX)) {
      keys.push(k);
    }
  }
  keys.sort();
  for (const storageKey of keys) {
    const raw = window.localStorage.getItem(storageKey);
    if (!raw) {
      continue;
    }
    try {
      const doc = JSON.parse(raw) as {
        session?: { agentView?: { pinnedAgentConversationIds?: unknown } };
      };
      const pinned = doc?.session?.agentView?.pinnedAgentConversationIds;
      if (!Array.isArray(pinned)) {
        continue;
      }
      found = true;
      for (const id of pinned) {
        push(id);
      }
    } catch {
      continue;
    }
  }

  if (workspaceSessionPinnedFallback && workspaceSessionPinnedFallback.length > 0) {
    found = true;
    for (const id of workspaceSessionPinnedFallback) {
      push(id);
    }
  }

  return found ? ordered : null;
}

export function clearLegacyPinnedAgentConversationIds(): void {
  if (typeof window === "undefined") {
    return;
  }
  try {
    window.localStorage.removeItem(LEGACY_AGENT_RAIL_PINNED_IDS_STORAGE_KEY);
  } catch {
    // Nothing to do; the legacy key is only ever consulted once.
  }
}
