"use client";

export const SERVER_CONNECTIONS_STORAGE_KEY = "opencursor.server-connections";
export const SERVER_CONNECTIONS_EVENT = "opencursor:server-connections-changed";

export type ServerConnection = {
  id: string;
  label: string;
  baseUrl: string;
  createdAt: number;
  updatedAt: number;
  lastUsedAt: number;
};

export type ServerConnectionsState = {
  version: 1;
  activeServerId: string | null;
  servers: ServerConnection[];
};

type PartialServerConnection = {
  id?: unknown;
  label?: unknown;
  baseUrl?: unknown;
  createdAt?: unknown;
  updatedAt?: unknown;
  lastUsedAt?: unknown;
};

let cachedState: ServerConnectionsState | null = null;

function fallbackId(): string {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return crypto.randomUUID();
  }
  return `server-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}

function trimTrailingSlash(value: string): string {
  return value.replace(/\/+$/, "");
}

export function normalizeServerBaseUrl(input: string): string {
  const trimmed = input.trim();
  if (!trimmed) {
    throw new Error("Server URL is empty.");
  }
  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    throw new Error("Server URL must be an absolute http(s) URL.");
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error("Server URL must use http or https.");
  }
  url.username = "";
  url.password = "";
  url.hash = "";
  return trimTrailingSlash(url.toString());
}

export function getServerConnectionKey(baseUrl: string): string {
  return normalizeServerBaseUrl(baseUrl);
}

function deriveServerLabel(baseUrl: string): string {
  try {
    const url = new URL(baseUrl);
    return url.port ? `${url.hostname}:${url.port}` : url.hostname;
  } catch {
    return baseUrl;
  }
}

export function createServerConnection(input: {
  label?: string;
  baseUrl: string;
  id?: string;
  now?: number;
}): ServerConnection {
  const now = input.now ?? Date.now();
  const baseUrl = normalizeServerBaseUrl(input.baseUrl);
  const label = input.label?.trim() || deriveServerLabel(baseUrl);
  return {
    id: input.id?.trim() || fallbackId(),
    label,
    baseUrl,
    createdAt: now,
    updatedAt: now,
    lastUsedAt: now,
  };
}

function sanitizeServerConnection(raw: PartialServerConnection): ServerConnection | null {
  if (typeof raw.baseUrl !== "string") {
    return null;
  }
  try {
    const baseUrl = normalizeServerBaseUrl(raw.baseUrl);
    const now = Date.now();
    return {
      id: typeof raw.id === "string" && raw.id.trim() ? raw.id.trim() : fallbackId(),
      label:
        typeof raw.label === "string" && raw.label.trim()
          ? raw.label.trim()
          : deriveServerLabel(baseUrl),
      baseUrl,
      createdAt: typeof raw.createdAt === "number" ? raw.createdAt : now,
      updatedAt: typeof raw.updatedAt === "number" ? raw.updatedAt : now,
      lastUsedAt: typeof raw.lastUsedAt === "number" ? raw.lastUsedAt : now,
    };
  } catch {
    return null;
  }
}

function dedupeServers(servers: ServerConnection[]): ServerConnection[] {
  const seenByBaseUrl = new Map<string, ServerConnection>();
  for (const server of servers) {
    const existing = seenByBaseUrl.get(server.baseUrl);
    if (!existing || existing.updatedAt < server.updatedAt) {
      seenByBaseUrl.set(server.baseUrl, server);
    }
  }
  return [...seenByBaseUrl.values()].sort((a, b) => {
    if (b.lastUsedAt !== a.lastUsedAt) {
      return b.lastUsedAt - a.lastUsedAt;
    }
    return a.label.localeCompare(b.label, undefined, { sensitivity: "base" });
  });
}

export function createDefaultServerConnectionsState(configuredDefaultBaseUrl: string): ServerConnectionsState {
  const initial = createServerConnection({ baseUrl: configuredDefaultBaseUrl });
  return {
    version: 1,
    activeServerId: initial.id,
    servers: [initial],
  };
}

export function normalizeServerConnectionsState(
  raw: unknown,
  configuredDefaultBaseUrl: string
): ServerConnectionsState {
  const fallback = createDefaultServerConnectionsState(configuredDefaultBaseUrl);
  if (!raw || typeof raw !== "object") {
    return fallback;
  }

  const parsed = raw as {
    version?: unknown;
    activeServerId?: unknown;
    servers?: unknown;
  };
  const serverList = Array.isArray(parsed.servers)
    ? parsed.servers
        .map((entry) => sanitizeServerConnection((entry ?? {}) as PartialServerConnection))
        .filter((entry): entry is ServerConnection => Boolean(entry))
    : [];
  const configuredDefault = fallback.servers[0];
  const withConfiguredDefault =
    configuredDefault && !serverList.some((server) => server.baseUrl === configuredDefault.baseUrl)
      ? [configuredDefault, ...serverList]
      : serverList;
  const servers = dedupeServers(withConfiguredDefault);
  if (servers.length === 0) {
    return fallback;
  }

  const configuredServer = configuredDefault
    ? servers.find((server) => server.baseUrl === configuredDefault.baseUrl)
    : undefined;
  const parsedActiveServer =
    typeof parsed.activeServerId === "string"
      ? servers.find((server) => server.id === parsed.activeServerId)
      : undefined;
  const parsedActiveLooksLikeStaleLocal =
    parsedActiveServer?.baseUrl != null &&
    /^http:\/\/(?:localhost|127\.0\.0\.1):(?:91|92)\d\d$/i.test(parsedActiveServer.baseUrl) &&
    configuredServer != null &&
    configuredServer.baseUrl !== parsedActiveServer.baseUrl;
  let activeServerId: string | null = servers[0]?.id ?? null;
  if (parsedActiveServer?.id) {
    activeServerId = parsedActiveServer.id;
  }
  if (parsedActiveLooksLikeStaleLocal) {
    activeServerId = configuredServer.id;
  }

  return {
    version: 1,
    activeServerId,
    servers,
  };
}

function notifyStateChange(): void {
  if (typeof window === "undefined") {
    return;
  }
  window.dispatchEvent(new CustomEvent(SERVER_CONNECTIONS_EVENT));
}

export function readStoredServerConnectionsState(
  configuredDefaultBaseUrl: string
): ServerConnectionsState {
  if (cachedState) {
    return cachedState;
  }
  const fallback = createDefaultServerConnectionsState(configuredDefaultBaseUrl);
  if (typeof window === "undefined") {
    cachedState = fallback;
    return fallback;
  }
  try {
    const raw = window.localStorage.getItem(SERVER_CONNECTIONS_STORAGE_KEY);
    if (!raw) {
      cachedState = fallback;
      window.localStorage.setItem(SERVER_CONNECTIONS_STORAGE_KEY, JSON.stringify(fallback));
      return fallback;
    }
    cachedState = normalizeServerConnectionsState(JSON.parse(raw), configuredDefaultBaseUrl);
    return cachedState;
  } catch {
    cachedState = fallback;
    return fallback;
  }
}

export function writeStoredServerConnectionsState(state: ServerConnectionsState): void {
  cachedState = state;
  if (typeof window === "undefined") {
    return;
  }
  try {
    window.localStorage.setItem(SERVER_CONNECTIONS_STORAGE_KEY, JSON.stringify(state));
  } catch {
    // Ignore local persistence failures and keep the in-memory state.
  }
  notifyStateChange();
}

export function getActiveServerConnection(
  configuredDefaultBaseUrl: string
): ServerConnection {
  const state = readStoredServerConnectionsState(configuredDefaultBaseUrl);
  return (
    state.servers.find((server) => server.id === state.activeServerId) ??
    state.servers[0] ??
    createServerConnection({ baseUrl: configuredDefaultBaseUrl })
  );
}

export function getActiveServerBaseUrl(configuredDefaultBaseUrl: string): string {
  return getActiveServerConnection(configuredDefaultBaseUrl).baseUrl;
}

export function getActiveServerStorageKey(configuredDefaultBaseUrl: string): string {
  return encodeURIComponent(getServerConnectionKey(getActiveServerBaseUrl(configuredDefaultBaseUrl)));
}

export function upsertServerConnection(
  state: ServerConnectionsState,
  input: { id?: string; label?: string; baseUrl: string }
): ServerConnectionsState {
  const normalizedBaseUrl = normalizeServerBaseUrl(input.baseUrl);
  const now = Date.now();
  const existingById = input.id ? state.servers.find((server) => server.id === input.id) : null;
  const existingByBaseUrl = state.servers.find((server) => server.baseUrl === normalizedBaseUrl);
  const target = existingById ?? existingByBaseUrl;
  const nextServer: ServerConnection = target
    ? {
        ...target,
        label: input.label?.trim() || target.label || deriveServerLabel(normalizedBaseUrl),
        baseUrl: normalizedBaseUrl,
        updatedAt: now,
      }
    : createServerConnection({ label: input.label, baseUrl: normalizedBaseUrl, now });

  const remaining = state.servers.filter(
    (server) => server.id !== target?.id && server.baseUrl !== normalizedBaseUrl
  );
  const servers = dedupeServers([nextServer, ...remaining]);
  return {
    version: 1,
    activeServerId: state.activeServerId ?? nextServer.id,
    servers,
  };
}

export function removeServerConnection(
  state: ServerConnectionsState,
  serverId: string,
  configuredDefaultBaseUrl: string
): ServerConnectionsState {
  const servers = state.servers.filter((server) => server.id !== serverId);
  if (servers.length === 0) {
    return createDefaultServerConnectionsState(configuredDefaultBaseUrl);
  }
  return {
    version: 1,
    activeServerId:
      state.activeServerId === serverId ? (servers[0]?.id ?? null) : state.activeServerId,
    servers,
  };
}

export function markServerConnectionUsed(
  state: ServerConnectionsState,
  serverId: string
): ServerConnectionsState {
  if (!state.servers.some((server) => server.id === serverId)) {
    return state;
  }
  const now = Date.now();
  return {
    version: 1,
    activeServerId: serverId,
    servers: dedupeServers(
      state.servers.map((server) =>
        server.id === serverId
          ? { ...server, lastUsedAt: now, updatedAt: now }
          : server
      )
    ),
  };
}
