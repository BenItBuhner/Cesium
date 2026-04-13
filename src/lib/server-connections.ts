"use client";

export const SERVER_CONNECTIONS_STORAGE_KEY = "opencursor.server-connections";
export const ACTIVE_SERVER_CONNECTION_ID_STORAGE_KEY =
  "opencursor.server-connections.active";
export const SERVER_SCOPED_STORAGE_PREFIX = "opencursor.server.";

const CONFIGURED_SERVER_URL =
  process.env.NEXT_PUBLIC_SERVER_URL?.replace(/\/+$/, "") ??
  "http://localhost:9100";

const WILDCARD_LOCAL_HOSTS = new Set(["0.0.0.0", "[::]", "::"]);
const LOCAL_BROWSER_HOSTS = new Set(["localhost", "127.0.0.1"]);
const SERVER_LOCAL_QUERY_KEYS = ["workspaceId", "windowId", "conversationId"];

export type ServerConnection = {
  id: string;
  label: string;
  baseUrl: string;
  createdAt: number;
  updatedAt: number;
  lastUsedAt: number;
};

type StoredServerConnection = Partial<ServerConnection> | null;

export type ServerConnectionsSnapshot = {
  connections: ServerConnection[];
  activeServerId: string;
  defaultServerId: string;
};

let activeServerConnectionSnapshot: ServerConnection | null = null;

function isFiniteTimestamp(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

function coerceLoopbackHostname(url: URL): URL {
  if (typeof window === "undefined") {
    return url;
  }

  const currentHost = window.location.hostname.trim();
  if (
    currentHost &&
    LOCAL_BROWSER_HOSTS.has(currentHost) &&
    WILDCARD_LOCAL_HOSTS.has(url.hostname)
  ) {
    url.hostname = currentHost;
    if (!url.port) {
      url.port = "9100";
    }
  }

  return url;
}

function defaultLabelForBaseUrl(baseUrl: string): string {
  try {
    const url = new URL(baseUrl);
    if (LOCAL_BROWSER_HOSTS.has(url.hostname)) {
      return "Local server";
    }
    return url.pathname !== "/" ? `${url.host}${url.pathname}` : url.host;
  } catch {
    return baseUrl;
  }
}

export function normalizeServerBaseUrl(raw: string): string {
  const trimmed = raw.trim();
  if (!trimmed) {
    throw new Error("Server URL is required.");
  }

  const withProtocol = /^[a-zA-Z][a-zA-Z\d+\-.]*:\/\//.test(trimmed)
    ? trimmed
    : `http://${trimmed}`;
  const url = coerceLoopbackHostname(new URL(withProtocol));
  url.username = "";
  url.password = "";
  url.search = "";
  url.hash = "";
  url.pathname = url.pathname.replace(/\/+$/, "") || "/";
  return url.toString().replace(/\/+$/, "");
}

export function createServerConnection(input: {
  baseUrl: string;
  label?: string;
  createdAt?: number;
  updatedAt?: number;
  lastUsedAt?: number;
}): ServerConnection {
  const baseUrl = normalizeServerBaseUrl(input.baseUrl);
  const now = Date.now();
  const createdAt = isFiniteTimestamp(input.createdAt) ? input.createdAt : now;
  const updatedAt = isFiniteTimestamp(input.updatedAt)
    ? input.updatedAt
    : createdAt;
  const lastUsedAt = isFiniteTimestamp(input.lastUsedAt)
    ? input.lastUsedAt
    : updatedAt;

  return {
    id: baseUrl,
    baseUrl,
    label: input.label?.trim() || defaultLabelForBaseUrl(baseUrl),
    createdAt,
    updatedAt,
    lastUsedAt,
  };
}

export function createDefaultServerConnection(): ServerConnection {
  const baseUrl = normalizeServerBaseUrl(CONFIGURED_SERVER_URL);
  return createServerConnection({
    baseUrl,
    label: defaultLabelForBaseUrl(baseUrl),
    createdAt: 0,
    updatedAt: 0,
    lastUsedAt: 0,
  });
}

function mergeServerConnections(
  existing: ServerConnection | undefined,
  incoming: ServerConnection
): ServerConnection {
  if (!existing) {
    return incoming;
  }

  return {
    ...existing,
    ...incoming,
    label: incoming.label || existing.label,
    createdAt: Math.min(existing.createdAt, incoming.createdAt),
    updatedAt: Math.max(existing.updatedAt, incoming.updatedAt),
    lastUsedAt: Math.max(existing.lastUsedAt, incoming.lastUsedAt),
  };
}

function parseStoredConnections(raw: string | null): ServerConnection[] {
  if (!raw) {
    return [];
  }

  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) {
      return [];
    }

    const deduped = new Map<string, ServerConnection>();
    for (const entry of parsed) {
      if (!entry || typeof entry !== "object") {
        continue;
      }

      const partial = entry as StoredServerConnection;
      if (!partial || typeof partial.baseUrl !== "string") {
        continue;
      }

      try {
        const connection = createServerConnection({
          baseUrl: partial.baseUrl,
          label: typeof partial.label === "string" ? partial.label : undefined,
          createdAt: partial.createdAt,
          updatedAt: partial.updatedAt,
          lastUsedAt: partial.lastUsedAt,
        });
        deduped.set(
          connection.id,
          mergeServerConnections(deduped.get(connection.id), connection)
        );
      } catch {
        continue;
      }
    }

    return [...deduped.values()];
  } catch {
    return [];
  }
}

function sortConnections(
  connections: ServerConnection[],
  activeServerId: string
): ServerConnection[] {
  return [...connections].sort((left, right) => {
    if (left.id === activeServerId) {
      return -1;
    }
    if (right.id === activeServerId) {
      return 1;
    }
    if (left.lastUsedAt !== right.lastUsedAt) {
      return right.lastUsedAt - left.lastUsedAt;
    }
    if (left.createdAt !== right.createdAt) {
      return left.createdAt - right.createdAt;
    }
    return left.label.localeCompare(right.label);
  });
}

export function normalizeServerConnectionsSnapshot(
  connections: ServerConnection[],
  activeServerId?: string | null
): ServerConnectionsSnapshot {
  const defaultConnection = createDefaultServerConnection();
  const deduped = new Map<string, ServerConnection>();
  deduped.set(defaultConnection.id, defaultConnection);

  for (const connection of connections) {
    const normalized = createServerConnection(connection);
    deduped.set(
      normalized.id,
      mergeServerConnections(deduped.get(normalized.id), normalized)
    );
  }

  const nextActiveServerId =
    activeServerId && deduped.has(activeServerId)
      ? activeServerId
      : defaultConnection.id;

  return {
    connections: sortConnections([...deduped.values()], nextActiveServerId),
    activeServerId: nextActiveServerId,
    defaultServerId: defaultConnection.id,
  };
}

export function readStoredServerConnections(): ServerConnectionsSnapshot {
  if (typeof window === "undefined") {
    const fallback = createDefaultServerConnection();
    return {
      connections: [fallback],
      activeServerId: fallback.id,
      defaultServerId: fallback.id,
    };
  }

  const storedConnections = parseStoredConnections(
    window.localStorage.getItem(SERVER_CONNECTIONS_STORAGE_KEY)
  );
  const activeServerId = window.localStorage.getItem(
    ACTIVE_SERVER_CONNECTION_ID_STORAGE_KEY
  );

  return normalizeServerConnectionsSnapshot(storedConnections, activeServerId);
}

export function persistStoredServerConnections(
  snapshot: Pick<ServerConnectionsSnapshot, "connections" | "activeServerId">
): void {
  if (typeof window === "undefined") {
    return;
  }

  try {
    const normalized = normalizeServerConnectionsSnapshot(
      snapshot.connections,
      snapshot.activeServerId
    );
    window.localStorage.setItem(
      SERVER_CONNECTIONS_STORAGE_KEY,
      JSON.stringify(normalized.connections)
    );
    window.localStorage.setItem(
      ACTIVE_SERVER_CONNECTION_ID_STORAGE_KEY,
      normalized.activeServerId
    );
  } catch {
    // Ignore local persistence failures and keep the in-memory state alive.
  }
}

export function setActiveServerConnectionSnapshot(
  connection: ServerConnection | null
): void {
  activeServerConnectionSnapshot = connection;
}

export function getActiveServerConnectionSnapshot(): ServerConnection {
  return activeServerConnectionSnapshot ?? createDefaultServerConnection();
}

export function getActiveServerBaseUrl(): string {
  return getActiveServerConnectionSnapshot().baseUrl;
}

export function buildServerScopedStorageKey(
  suffix: string,
  serverId?: string | null
): string {
  const effectiveServerId = serverId ?? getActiveServerConnectionSnapshot().id;
  return `${SERVER_SCOPED_STORAGE_PREFIX}${encodeURIComponent(
    effectiveServerId
  )}.${suffix}`;
}

export function clearServerScopedStorage(serverId: string): void {
  if (typeof window === "undefined") {
    return;
  }

  const prefix = `${SERVER_SCOPED_STORAGE_PREFIX}${encodeURIComponent(serverId)}.`;
  try {
    for (let index = window.localStorage.length - 1; index >= 0; index -= 1) {
      const key = window.localStorage.key(index);
      if (key?.startsWith(prefix)) {
        window.localStorage.removeItem(key);
      }
    }
  } catch {
    // Ignore storage failures during cleanup.
  }
}

export function clearServerScopedLocationState(): void {
  if (typeof window === "undefined") {
    return;
  }

  const url = new URL(window.location.href);
  let changed = false;
  for (const key of SERVER_LOCAL_QUERY_KEYS) {
    if (!url.searchParams.has(key)) {
      continue;
    }
    url.searchParams.delete(key);
    changed = true;
  }

  if (!changed) {
    return;
  }

  window.history.replaceState(
    null,
    "",
    `${url.pathname}${url.search}${url.hash}`
  );
}
