/**
 * Collapsed rail groups (workspace / section headers and chat folders) are
 * account settings: `general.collapsedRailWorkspaceKeys` and
 * `general.collapsedRailFolderIds`. This module keeps the pure toggle helpers
 * and the one-time read of the pre-account per-device localStorage lists.
 */

export const LEGACY_COLLAPSED_WORKSPACES_STORAGE_KEY = "opencursor.agent-rail-collapsed-workspaces";
export const LEGACY_COLLAPSED_FOLDERS_STORAGE_KEY = "opencursor.agent-rail-collapsed-folders";

export function toggleCollapsedId(ids: string[], id: string): string[] {
  return ids.includes(id) ? ids.filter((entry) => entry !== id) : [...ids, id];
}

export function withCollapsedIds(ids: string[], add: Iterable<string>): string[] {
  const next = [...ids];
  const seen = new Set(ids);
  for (const id of add) {
    if (!seen.has(id)) {
      seen.add(id);
      next.push(id);
    }
  }
  return next.length === ids.length ? ids : next;
}

export function withoutCollapsedId(ids: string[], id: string): string[] {
  return ids.includes(id) ? ids.filter((entry) => entry !== id) : ids;
}

function readLegacyList(key: string): string[] | null {
  if (typeof window === "undefined") {
    return null;
  }
  try {
    const raw = window.localStorage.getItem(key);
    if (raw === null) {
      return null;
    }
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) {
      return [];
    }
    return parsed.filter((id): id is string => typeof id === "string" && id.length > 0);
  } catch {
    return null;
  }
}

/** Pre-account collapsed lists this device stored, or `null` when never written. */
export function readLegacyCollapsedRailState(): {
  workspaceKeys: string[] | null;
  folderIds: string[] | null;
} {
  return {
    workspaceKeys: readLegacyList(LEGACY_COLLAPSED_WORKSPACES_STORAGE_KEY),
    folderIds: readLegacyList(LEGACY_COLLAPSED_FOLDERS_STORAGE_KEY),
  };
}

export function clearLegacyCollapsedRailState(): void {
  if (typeof window === "undefined") {
    return;
  }
  try {
    window.localStorage.removeItem(LEGACY_COLLAPSED_WORKSPACES_STORAGE_KEY);
    window.localStorage.removeItem(LEGACY_COLLAPSED_FOLDERS_STORAGE_KEY);
  } catch {
    // Nothing to do; the legacy keys are only ever consulted once.
  }
}
