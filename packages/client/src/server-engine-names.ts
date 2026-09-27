import { clientKeyValueStore } from "./platform";
import type { ServerConnection } from "./server-connections";

export const SERVER_ENGINE_NAMES_STORAGE_KEY = "opencursor.server-engine-names";

const MAX_ENGINE_NAME_LENGTH = 80;

/**
 * Names engines reported about themselves, per saved connection. Each entry
 * remembers which endpoint answered so a connection re-pointed at another
 * engine stops showing the old name, while an offline engine keeps its own.
 */
export type ServerEngineNames = Record<string, { name: string; endpoint: string }>;

/**
 * What one probe learned: a name, `null` when the engine answered without one
 * (older engines), or `undefined` when it could not say (offline, signed out).
 */
export type ServerEngineNameProbe = {
  server: Pick<ServerConnection, "id" | "baseUrl" | "rendezvous">;
  engineName: string | null | undefined;
};

export function sanitizeEngineName(value: unknown): string | null {
  if (typeof value !== "string") {
    return null;
  }
  const name = value.replace(/\s+/g, " ").trim().slice(0, MAX_ENGINE_NAME_LENGTH).trim();
  return name || null;
}

/** Tunnel-backed engines keep their identity across public URL rotations. */
function engineEndpoint(server: Pick<ServerConnection, "baseUrl" | "rendezvous">): string {
  return server.rendezvous ? `rendezvous:${server.rendezvous.serverId}` : server.baseUrl;
}

function normalizeServerEngineNames(value: unknown): ServerEngineNames {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return {};
  }
  const names: ServerEngineNames = {};
  for (const [serverId, entry] of Object.entries(value as Record<string, unknown>)) {
    if (!entry || typeof entry !== "object") continue;
    const { name, endpoint } = entry as { name?: unknown; endpoint?: unknown };
    const sanitized = sanitizeEngineName(name);
    if (sanitized && typeof endpoint === "string" && endpoint) {
      names[serverId] = { name: sanitized, endpoint };
    }
  }
  return names;
}

export function readStoredServerEngineNames(): ServerEngineNames {
  try {
    const raw = clientKeyValueStore().getItem(SERVER_ENGINE_NAMES_STORAGE_KEY);
    return raw ? normalizeServerEngineNames(JSON.parse(raw)) : {};
  } catch {
    return {};
  }
}

export function writeStoredServerEngineNames(names: ServerEngineNames): void {
  try {
    clientKeyValueStore().setItem(SERVER_ENGINE_NAMES_STORAGE_KEY, JSON.stringify(names));
  } catch {
    // Names are a display nicety; the connection label still works without them.
  }
}

function sameServerEngineNames(a: ServerEngineNames, b: ServerEngineNames): boolean {
  const aKeys = Object.keys(a);
  if (aKeys.length !== Object.keys(b).length) {
    return false;
  }
  return aKeys.every(
    (key) => b[key]?.name === a[key]?.name && b[key]?.endpoint === a[key]?.endpoint
  );
}

/**
 * Folds probe results into the remembered names and drops connections that
 * no longer exist. Returns `current` itself when nothing changed.
 */
export function applyServerEngineNameProbes(
  current: ServerEngineNames,
  probes: readonly ServerEngineNameProbe[],
  servers: readonly Pick<ServerConnection, "id" | "baseUrl" | "rendezvous">[]
): ServerEngineNames {
  const endpointById = new Map(servers.map((server) => [server.id, engineEndpoint(server)]));
  const next: ServerEngineNames = {};
  for (const [serverId, entry] of Object.entries(current)) {
    if (endpointById.has(serverId)) {
      next[serverId] = entry;
    }
  }
  for (const { server, engineName } of probes) {
    const endpoint = engineEndpoint(server);
    if (engineName === undefined || endpointById.get(server.id) !== endpoint) {
      continue;
    }
    if (engineName === null) {
      delete next[server.id];
    } else {
      next[server.id] = { name: engineName, endpoint };
    }
  }
  return sameServerEngineNames(current, next) ? current : next;
}

/** Engine name per connection, only where it still belongs to that endpoint. */
export function engineNamesForServers(
  names: ServerEngineNames,
  servers: readonly Pick<ServerConnection, "id" | "baseUrl" | "rendezvous">[]
): Record<string, string> {
  const byId: Record<string, string> = {};
  for (const server of servers) {
    const entry = names[server.id];
    if (entry && entry.endpoint === engineEndpoint(server)) {
      byId[server.id] = entry.name;
    }
  }
  return byId;
}
