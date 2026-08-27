"use client";

import {
  getServerConnectionKey,
  isCesiumAccountSiteUrl,
  normalizeRendezvousLocator,
  upsertServerConnection,
  type RendezvousLocator,
  type ServerConnection,
  type ServerConnectionsState,
} from "@cesium/client";

/**
 * Account-level server sync helpers.
 *
 * A user's engines live in the cloud `servers` table so every signed-in
 * client inherits them. Tunnel-backed engines (shared via public access)
 * carry a rendezvous locator: their base URL rotates with the tunnel, so the
 * locator — not the URL — is their cross-device identity, and inheriting
 * clients re-resolve the live endpoint from the rendezvous registry.
 */

export type CloudServerRecord = {
  name: string;
  baseUrl: string;
  sessionToken?: string | null;
  rendezvous?: Partial<RendezvousLocator> | null;
};

export type CloudServerPushPayload = {
  name: string;
  baseUrl: string;
  kind: "remote";
  sessionToken?: string;
  rendezvous?: RendezvousLocator;
};

export type CloudServerRemoval = {
  baseUrl?: string;
  rendezvousServerId?: string;
};

/** Stable cross-device identity: rendezvous server id wins over base URL. */
export function cloudServerIdentity(input: {
  baseUrl: string;
  rendezvous?: { serverId?: string } | null;
}): string {
  if (input.rendezvous?.serverId) {
    return `rendezvous:${input.rendezvous.serverId}`;
  }
  try {
    return getServerConnectionKey(input.baseUrl);
  } catch {
    return input.baseUrl;
  }
}

/**
 * Material signature of a connections state: ignores timestamps so merge can
 * detect no-op cloud applications and skip the write (otherwise every
 * bootstrap would emit a change event and ping-pong with the push path).
 */
export function serverConnectionsSignature(state: ServerConnectionsState): string {
  return JSON.stringify({
    active: state.activeServerId,
    default: state.defaultServerId,
    servers: state.servers
      .map((server) => ({
        identity: cloudServerIdentity(server),
        label: server.label,
        baseUrl: server.baseUrl,
        rendezvous: server.rendezvous ?? null,
      }))
      .sort((a, b) => a.identity.localeCompare(b.identity)),
  });
}

export type MergeCloudServersResult = {
  state: ServerConnectionsState;
  changed: boolean;
  /**
   * Session tokens from the cloud, keyed to the base URL the server resolves
   * to locally (a rendezvous server may already sit on a fresher endpoint
   * than the one the cloud row recorded).
   */
  sessionTokens: Array<{ baseUrl: string; sessionToken: string }>;
};

/**
 * Fold the account's servers into the local connection list (additive).
 * Identities in `skipIdentities` (local removal tombstones) are ignored so a
 * server the user deleted here does not resurrect on every bootstrap.
 */
export function mergeCloudServersIntoState(
  state: ServerConnectionsState,
  cloudServers: CloudServerRecord[],
  options?: { skipIdentities?: ReadonlySet<string> }
): MergeCloudServersResult {
  const sessionTokens: Array<{ baseUrl: string; sessionToken: string }> = [];
  if (cloudServers.length === 0) {
    return { state, changed: false, sessionTokens };
  }
  const beforeSignature = serverConnectionsSignature(state);
  let next = state;
  for (const cloudServer of cloudServers) {
    if (isCesiumAccountSiteUrl(cloudServer.baseUrl)) {
      continue;
    }
    let locator: RendezvousLocator | null = null;
    if (cloudServer.rendezvous) {
      try {
        locator = normalizeRendezvousLocator(cloudServer.rendezvous);
      } catch {
        locator = null;
      }
    }
    const identity = cloudServerIdentity({
      baseUrl: cloudServer.baseUrl,
      rendezvous: locator,
    });
    if (options?.skipIdentities?.has(identity)) {
      continue;
    }
    const existingByLocator = locator
      ? next.servers.find(
          (server) => server.rendezvous?.serverId === locator.serverId
        ) ?? null
      : null;
    try {
      if (existingByLocator) {
        // The local entry may already point at a fresher tunnel endpoint than
        // the cloud row; keep the local base URL and let rendezvous polling
        // own endpoint freshness.
        next = upsertServerConnection(next, {
          id: existingByLocator.id,
          baseUrl: existingByLocator.baseUrl,
          rendezvous: locator ?? undefined,
        });
      } else {
        next = upsertServerConnection(next, {
          ...(locator ? { id: `rendezvous:${locator.serverId}` } : {}),
          label: cloudServer.name,
          baseUrl: cloudServer.baseUrl,
          ...(locator ? { rendezvous: locator } : {}),
        });
      }
    } catch {
      continue;
    }
    if (cloudServer.sessionToken) {
      const localBaseUrl = locator
        ? next.servers.find((server) => server.rendezvous?.serverId === locator.serverId)
            ?.baseUrl ?? cloudServer.baseUrl
        : cloudServer.baseUrl;
      sessionTokens.push({
        baseUrl: localBaseUrl,
        sessionToken: cloudServer.sessionToken,
      });
    }
  }
  const changed = serverConnectionsSignature(next) !== beforeSignature;
  return { state: changed ? next : state, changed, sessionTokens };
}

/** Everything the local list knows, shaped for idempotent cloud upserts. */
export function buildCloudServerPushPayloads(
  servers: ServerConnection[],
  getSessionToken: (baseUrl: string) => string | null
): CloudServerPushPayload[] {
  const payloads: CloudServerPushPayload[] = [];
  for (const server of servers) {
    if (isCesiumAccountSiteUrl(server.baseUrl)) {
      continue;
    }
    const sessionToken = getSessionToken(server.baseUrl);
    payloads.push({
      name: server.label,
      baseUrl: server.baseUrl,
      kind: "remote",
      ...(sessionToken ? { sessionToken } : {}),
      ...(server.rendezvous
        ? {
            rendezvous: {
              version: 1,
              serverId: server.rendezvous.serverId,
              secret: server.rendezvous.secret,
              registryBaseUrl: server.rendezvous.registryBaseUrl,
            },
          }
        : {}),
    });
  }
  return payloads;
}

/** Servers present before but gone now — i.e. removed locally this session. */
export function diffRemovedCloudServers(
  previous: ServerConnection[],
  next: ServerConnection[]
): CloudServerRemoval[] {
  const remaining = new Set(next.map((server) => cloudServerIdentity(server)));
  const removals: CloudServerRemoval[] = [];
  const seen = new Set<string>();
  for (const server of previous) {
    const identity = cloudServerIdentity(server);
    if (remaining.has(identity) || seen.has(identity)) {
      continue;
    }
    seen.add(identity);
    removals.push({
      baseUrl: server.baseUrl,
      ...(server.rendezvous ? { rendezvousServerId: server.rendezvous.serverId } : {}),
    });
  }
  return removals;
}

export const CLOUD_SERVER_TOMBSTONES_STORAGE_KEY = "cesium-cloud-server-tombstones";

export function parseCloudServerTombstones(raw: string | null): Set<string> {
  if (!raw) {
    return new Set();
  }
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) {
      return new Set();
    }
    return new Set(
      parsed.filter((entry): entry is string => typeof entry === "string" && entry.length > 0)
    );
  } catch {
    return new Set();
  }
}

export function serializeCloudServerTombstones(identities: ReadonlySet<string>): string {
  return JSON.stringify([...identities].sort());
}
