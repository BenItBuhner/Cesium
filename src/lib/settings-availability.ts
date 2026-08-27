/**
 * Which settings pages need a configured engine versus living on the client.
 *
 * Client pages stay available with zero saved servers (fresh account, local-only
 * testing). Engine pages fetch harness keys, usage, MCP, storage, voice, and
 * similar host state — they must not mount or appear in search until a server
 * is connected.
 */
export const SERVER_BOUND_SETTINGS_NAV_IDS = [
  "voice",
  "agents",
  "models",
  "usage",
  "cloudAgents",
  "plugins",
  "extensions",
  "rulesSkills",
  "actions",
  "storage",
  "updates",
] as const;

export type ServerBoundSettingsNavId = (typeof SERVER_BOUND_SETTINGS_NAV_IDS)[number];

const SERVER_BOUND_NAV_SET = new Set<string>(SERVER_BOUND_SETTINGS_NAV_IDS);

export function settingsNavRequiresServer(navId: string): boolean {
  return SERVER_BOUND_NAV_SET.has(navId);
}

export function isSettingsNavAvailable(navId: string, hasServer: boolean): boolean {
  return hasServer || !settingsNavRequiresServer(navId);
}

export type SettingsNavVisibilityEntry =
  | { kind: "item"; id: string }
  | { kind: "divider" };

/**
 * Drop server-bound sidebar items when no engine is connected, then collapse
 * leftover adjacent/leading/trailing dividers.
 */
export function filterSettingsNavEntries<T extends SettingsNavVisibilityEntry>(
  entries: readonly T[],
  hasServer: boolean
): T[] {
  const visible = entries.filter((entry) => {
    if (entry.kind === "divider") {
      return true;
    }
    return isSettingsNavAvailable(entry.id, hasServer);
  });

  const collapsed: T[] = [];
  for (const entry of visible) {
    if (entry.kind === "divider") {
      if (collapsed.length === 0 || collapsed[collapsed.length - 1]?.kind === "divider") {
        continue;
      }
      collapsed.push(entry);
      continue;
    }
    collapsed.push(entry);
  }
  if (collapsed[collapsed.length - 1]?.kind === "divider") {
    collapsed.pop();
  }
  return collapsed;
}

export function filterSettingsSearchEntries<T extends { navId: string }>(
  entries: readonly T[],
  hasServer: boolean
): T[] {
  if (hasServer) {
    return [...entries];
  }
  return entries.filter((entry) => isSettingsNavAvailable(entry.navId, hasServer));
}
