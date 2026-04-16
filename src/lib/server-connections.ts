"use client";

export type SavedServerConnection = {
  id: string;
  name: string;
  baseUrl: string;
  createdAt: number;
  updatedAt: number;
  lastUsedAt: number;
};

export type PersistedServerConnectionsState = {
  schemaVersion: 1;
  activeServerId: string;
  servers: SavedServerConnection[];
};

export const SERVER_CONNECTIONS_STORAGE_KEY = "opencursor.server-connections";

const SERVER_CONNECTIONS_SCHEMA_VERSION = 1;
const DEFAULT_SERVER_BASE_URL = normalizeServerBaseUrl(
  process.env.NEXT_PUBLIC_SERVER_URL?.replace(/\/+$/, "") ?? "http://localhost:9100"
);

let cachedServerConnectionsState: PersistedServerConnectionsState | null = null;
let cachedServerConnectionsStateKey = "";

function hasExplicitScheme(value: string): boolean {
  return /^[a-zA-Z][a-zA-Z\d+\-.]*:\/\//.test(value);
}

function isLoopbackHost(hostname: string): boolean {
  return hostname === "localhost" || hostname === "127.0.0.1";
}

function formatNormalizedUrl(url: URL): string {
  const pathname = url.pathname.replace(/\/+$/, "");
  return pathname && pathname !== "/"
    ? `${url.protocol}//${url.host}${pathname}`
    : `${url.protocol}//${url.host}`;
}

function createServerConnection(
  baseUrl: string,
  overrides?: Partial<Omit<SavedServerConnection, "id" | "baseUrl">>
): SavedServerConnection {
  const now = Date.now();
  return {
    id: baseUrl,
    name: deriveServerConnectionName(baseUrl),
    createdAt: now,
    updatedAt: now,
    lastUsedAt: now,
    ...overrides,
    baseUrl,
  };
}

function createDefaultServerConnection(): SavedServerConnection {
  return createServerConnection(DEFAULT_SERVER_BASE_URL);
}

function sortServerConnections(
  servers: SavedServerConnection[],
  activeServerId: string
): SavedServerConnection[] {
  return [...servers].sort((a, b) => {
    if (a.id === activeServerId && b.id !== activeServerId) {
      return -1;
    }
    if (b.id === activeServerId && a.id !== activeServerId) {
      return 1;
    }
    if (a.lastUsedAt !== b.lastUsedAt) {
      return b.lastUsedAt - a.lastUsedAt;
    }
    return a.name.localeCompare(b.name, undefined, { sensitivity: "base" });
  });
}

function normalizePersistedServer(raw: unknown): SavedServerConnection | null {
  if (!raw || typeof raw !== "object") {
    return null;
  }
  const record = raw as Partial<SavedServerConnection>;
  if (typeof record.baseUrl !== "string" || record.baseUrl.trim().length === 0) {
    return null;
  }
  let normalizedBaseUrl: string;
  try {
    normalizedBaseUrl = normalizeServerBaseUrl(record.baseUrl);
  } catch {
    return null;
  }
  const fallback = createServerConnection(normalizedBaseUrl);
  return {
    ...fallback,
    name:
      typeof record.name === "string" && record.name.trim().length > 0
        ? record.name.trim()
        : fallback.name,
    createdAt:
      typeof record.createdAt === "number" && Number.isFinite(record.createdAt)
        ? record.createdAt
        : fallback.createdAt,
    updatedAt:
      typeof record.updatedAt === "number" && Number.isFinite(record.updatedAt)
        ? record.updatedAt
        : fallback.updatedAt,
    lastUsedAt:
      typeof record.lastUsedAt === "number" && Number.isFinite(record.lastUsedAt)
        ? record.lastUsedAt
        : fallback.lastUsedAt,
    id: normalizedBaseUrl,
    baseUrl: normalizedBaseUrl,
  };
}

function normalizeServerConnectionsState(
  raw: unknown
): PersistedServerConnectionsState {
  const fallbackServer = createDefaultServerConnection();
  if (!raw || typeof raw !== "object") {
    return {
      schemaVersion: SERVER_CONNECTIONS_SCHEMA_VERSION,
      activeServerId: fallbackServer.id,
      servers: [fallbackServer],
    };
  }

  const record = raw as Partial<PersistedServerConnectionsState>;
  const dedupedServers = new Map<string, SavedServerConnection>();
  for (const server of Array.isArray(record.servers) ? record.servers : []) {
    const normalized = normalizePersistedServer(server);
    if (!normalized) {
      continue;
    }
    dedupedServers.set(normalized.id, normalized);
  }
  if (dedupedServers.size === 0) {
    dedupedServers.set(fallbackServer.id, fallbackServer);
  }

  const activeServerId =
    typeof record.activeServerId === "string" && dedupedServers.has(record.activeServerId)
      ? record.activeServerId
      : dedupedServers.values().next().value?.id ?? fallbackServer.id;

  return {
    schemaVersion: SERVER_CONNECTIONS_SCHEMA_VERSION,
    activeServerId,
    servers: sortServerConnections([...dedupedServers.values()], activeServerId),
  };
}

function readServerConnectionsFromStorage(): PersistedServerConnectionsState {
  if (typeof window === "undefined") {
    return normalizeServerConnectionsState(null);
  }

  try {
    const raw = window.localStorage.getItem(SERVER_CONNECTIONS_STORAGE_KEY);
    const next = normalizeServerConnectionsState(
      raw ? (JSON.parse(raw) as unknown) : null
    );
    const key = JSON.stringify(next);
    if (key !== cachedServerConnectionsStateKey) {
      cachedServerConnectionsState = next;
      cachedServerConnectionsStateKey = key;
    }
    return cachedServerConnectionsState ?? next;
  } catch {
    const fallback = normalizeServerConnectionsState(null);
    cachedServerConnectionsState = fallback;
    cachedServerConnectionsStateKey = JSON.stringify(fallback);
    return fallback;
  }
}

export function writeServerConnectionsToStorage(
  nextState: PersistedServerConnectionsState
): PersistedServerConnectionsState {
  const normalized = normalizeServerConnectionsState(nextState);
  cachedServerConnectionsState = normalized;
  cachedServerConnectionsStateKey = JSON.stringify(normalized);
  if (typeof window !== "undefined") {
    try {
      window.localStorage.setItem(
        SERVER_CONNECTIONS_STORAGE_KEY,
        cachedServerConnectionsStateKey
      );
    } catch {
      // Ignore persistence failures and keep the in-memory snapshot.
    }
  }
  return normalized;
}

export function normalizeServerBaseUrl(raw: string): string {
  const trimmed = raw.trim();
  if (trimmed.length === 0) {
    throw new Error("Base URL is required.");
  }

  const candidate = hasExplicitScheme(trimmed) ? trimmed : `http://${trimmed}`;
  let parsed: URL;
  try {
    parsed = new URL(candidate);
  } catch {
    throw new Error("Enter a valid server URL, e.g. http://localhost:9100.");
  }

  if (!/^https?:$/.test(parsed.protocol)) {
    throw new Error("Server URL must use http:// or https://.");
  }
  if (parsed.username || parsed.password) {
    throw new Error("Server URL credentials are not supported.");
  }

  parsed.search = "";
  parsed.hash = "";
  return formatNormalizedUrl(parsed);
}

export function deriveServerConnectionName(baseUrl: string): string {
  try {
    const parsed = new URL(baseUrl);
    const host = parsed.port ? `${parsed.hostname}:${parsed.port}` : parsed.hostname;
    const pathname = parsed.pathname.replace(/\/+$/, "");
    return pathname && pathname !== "/" ? `${host}${pathname}` : host;
  } catch {
    return baseUrl;
  }
}

export function resolveServerRequestBaseUrl(baseUrl: string): string {
  if (typeof window === "undefined") {
    return normalizeServerBaseUrl(baseUrl);
  }

  try {
    const configured = new URL(normalizeServerBaseUrl(baseUrl));
    const currentHost = window.location.hostname;
    if (
      currentHost &&
      isLoopbackHost(currentHost) &&
      isLoopbackHost(configured.hostname) &&
      (configured.hostname !== currentHost || configured.protocol !== window.location.protocol)
    ) {
      configured.protocol = window.location.protocol;
      configured.hostname = currentHost;
      configured.port = configured.port || "9100";
      return formatNormalizedUrl(configured);
    }
  } catch {
    return normalizeServerBaseUrl(baseUrl);
  }

  return normalizeServerBaseUrl(baseUrl);
}

export function getDefaultServerBaseUrl(): string {
  return DEFAULT_SERVER_BASE_URL;
}

export function getServerConnectionsSnapshot(): PersistedServerConnectionsState {
  return readServerConnectionsFromStorage();
}

export function getActiveServerConnection(): SavedServerConnection {
  const snapshot = getServerConnectionsSnapshot();
  return (
    snapshot.servers.find((server) => server.id === snapshot.activeServerId) ??
    snapshot.servers[0] ??
    createDefaultServerConnection()
  );
}

export function getActiveServerRequestBaseUrl(): string {
  return resolveServerRequestBaseUrl(getActiveServerConnection().baseUrl);
}

export function getServerStorageScope(serverBaseUrl?: string | null): string {
  const normalized =
    typeof serverBaseUrl === "string" && serverBaseUrl.trim().length > 0
      ? normalizeServerBaseUrl(serverBaseUrl)
      : getActiveServerConnection().baseUrl;
  return encodeURIComponent(normalized);
}

export function buildServerScopedStorageKey(
  prefix: string,
  options?: {
    serverBaseUrl?: string | null;
    suffix?: string | null;
  }
): string {
  const scopeKey = `${prefix}${getServerStorageScope(options?.serverBaseUrl)}`;
  return options?.suffix ? `${scopeKey}::${options.suffix}` : scopeKey;
}

export function getServerScopedStoragePrefix(
  prefix: string,
  serverBaseUrl?: string | null
): string {
  return `${prefix}${getServerStorageScope(serverBaseUrl)}`;
}

export function getLegacyDefaultServerStorageScope(): string {
  return getServerStorageScope(DEFAULT_SERVER_BASE_URL);
}
