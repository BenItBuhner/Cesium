"use client";

import { isLoopbackServerBaseUrl } from "@/lib/configured-server-base-url";

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
  /** Stores theme, shortcuts, models, and other cross-server preferences. */
  defaultServerId: string | null;
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
  const normalized = normalizeServerBaseUrl(baseUrl);
  try {
    const url = new URL(normalized);
    const host = canonicalServerHost(url.hostname);
    const port = url.port || (url.protocol === "https:" ? "443" : "80");
    return `${url.protocol}//${host}:${port}`;
  } catch {
    return normalized;
  }
}

function canonicalServerHost(hostname: string): string {
  const lower = hostname.toLowerCase();
  if (lower === "localhost" || lower === "::1" || /^127(?:\.\d{1,3}){3}$/.test(lower)) {
    return "localhost";
  }
  return lower;
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
    const updatedAt =
      typeof raw.updatedAt === "number"
        ? raw.updatedAt
        : typeof raw.createdAt === "number"
          ? raw.createdAt
          : 0;
    const createdAt = typeof raw.createdAt === "number" ? raw.createdAt : updatedAt;
    return {
      id: typeof raw.id === "string" && raw.id.trim() ? raw.id.trim() : fallbackId(),
      label:
        typeof raw.label === "string" && raw.label.trim()
          ? raw.label.trim()
          : deriveServerLabel(baseUrl),
      baseUrl,
      createdAt,
      updatedAt,
      lastUsedAt: typeof raw.lastUsedAt === "number" ? raw.lastUsedAt : updatedAt,
    };
  } catch {
    return null;
  }
}

function dedupeServers(servers: ServerConnection[]): ServerConnection[] {
  const seenByBaseUrl = new Map<string, ServerConnection>();
  for (const server of servers) {
    const key = getServerConnectionKey(server.baseUrl);
    const existing = seenByBaseUrl.get(key);
    if (!existing || existing.updatedAt < server.updatedAt) {
      seenByBaseUrl.set(key, server);
    }
  }
  return [...seenByBaseUrl.values()].sort((a, b) => {
    if (b.lastUsedAt !== a.lastUsedAt) {
      return b.lastUsedAt - a.lastUsedAt;
    }
    return a.label.localeCompare(b.label, undefined, { sensitivity: "base" });
  });
}

function pickDefaultServerId(
  servers: ServerConnection[],
  preferredDefaultId: unknown,
  activeServerId: string | null
): string | null {
  if (servers.length === 0) {
    return null;
  }
  if (servers.length === 1) {
    return servers[0]?.id ?? null;
  }
  if (typeof preferredDefaultId === "string") {
    const preferred = servers.find((server) => server.id === preferredDefaultId);
    if (preferred) {
      return preferred.id;
    }
  }
  if (typeof activeServerId === "string") {
    const active = servers.find((server) => server.id === activeServerId);
    if (active) {
      return active.id;
    }
  }
  return null;
}

export function requiresDefaultServerSelection(state: ServerConnectionsState): boolean {
  return state.servers.length > 1 && !getSettingsServerConnection(state);
}

export function getSettingsServerConnection(
  state: ServerConnectionsState
): ServerConnection | null {
  if (state.servers.length === 0) {
    return null;
  }
  if (state.servers.length === 1) {
    return state.servers[0] ?? null;
  }
  if (!state.defaultServerId) {
    return null;
  }
  return state.servers.find((server) => server.id === state.defaultServerId) ?? null;
}

function pickActiveServerId(
  servers: ServerConnection[],
  preferredActiveId: unknown
): string | null {
  if (servers.length === 0) {
    return null;
  }
  if (typeof preferredActiveId === "string") {
    const preferred = servers.find((server) => server.id === preferredActiveId);
    if (preferred) {
      return preferred.id;
    }
  }
  return servers.reduce((best, server) =>
    server.lastUsedAt > best.lastUsedAt ? server : best
  ).id;
}

export function shouldApplyServerUrlFromSearch(
  state: ServerConnectionsState,
  candidateBaseUrl: string,
  options?: { isElectron?: boolean }
): boolean {
  if (options?.isElectron) {
    return true;
  }
  const normalized = normalizeServerBaseUrl(candidateBaseUrl);
  const candidateKey = getServerConnectionKey(normalized);
  const active =
    state.servers.find((server) => server.id === state.activeServerId) ?? null;
  if (active && getServerConnectionKey(active.baseUrl) === candidateKey) {
    return false;
  }
  const existingServer =
    state.servers.find((server) => getServerConnectionKey(server.baseUrl) === candidateKey) ?? null;
  const isNewServer = !existingServer;
  if (active && existingServer) {
    const activeIsLoopback = isLoopbackServerBaseUrl(active.baseUrl);
    const candidateIsLoopback = isLoopbackServerBaseUrl(normalized);
    return !candidateIsLoopback || !activeIsLoopback;
  }
  if (active && isNewServer) {
    const activeIsLoopback = isLoopbackServerBaseUrl(active.baseUrl);
    const candidateIsLoopback = isLoopbackServerBaseUrl(normalized);
    if (!candidateIsLoopback || !activeIsLoopback) {
      return true;
    }
    return false;
  }
  if (active) {
    return false;
  }
  if (isNewServer) {
    return true;
  }
  return false;
}

export function applyServerUrlBootstrap(
  state: ServerConnectionsState,
  candidateBaseUrl: string,
  options?: { force?: boolean; isElectron?: boolean }
): ServerConnectionsState {
  const normalized = normalizeServerBaseUrl(candidateBaseUrl);
  const candidateKey = getServerConnectionKey(normalized);
  if (
    !options?.force &&
    !shouldApplyServerUrlFromSearch(state, normalized, { isElectron: options?.isElectron })
  ) {
    return state;
  }
  const upserted = upsertServerConnection(state, {
    label: deriveServerLabel(normalized),
    baseUrl: normalized,
  });
  const server = upserted.servers.find(
    (entry) => getServerConnectionKey(entry.baseUrl) === candidateKey
  );
  return server ? markServerConnectionUsed(upserted, server.id) : upserted;
}

export function createDefaultServerConnectionsState(configuredDefaultBaseUrl: string): ServerConnectionsState {
  const initial = createServerConnection({ baseUrl: configuredDefaultBaseUrl });
  return {
    version: 1,
    activeServerId: initial.id,
    defaultServerId: initial.id,
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
    defaultServerId?: unknown;
    servers?: unknown;
  };
  const serverList = Array.isArray(parsed.servers)
    ? parsed.servers
        .map((entry) => sanitizeServerConnection((entry ?? {}) as PartialServerConnection))
        .filter((entry): entry is ServerConnection => Boolean(entry))
    : [];
  const configuredDefault = createServerConnection({
    baseUrl: configuredDefaultBaseUrl,
    now: 0,
  });
  const withConfiguredDefault =
    configuredDefault &&
    !serverList.some(
      (server) =>
        getServerConnectionKey(server.baseUrl) === getServerConnectionKey(configuredDefault.baseUrl)
    )
      ? [configuredDefault, ...serverList]
      : serverList;
  const servers = dedupeServers(withConfiguredDefault);
  if (servers.length === 0) {
    return fallback;
  }

  const activeServerId = pickActiveServerId(
    servers,
    parsed.activeServerId
  );
  const defaultServerId = pickDefaultServerId(
    servers,
    parsed.defaultServerId,
    activeServerId
  );

  return {
    version: 1,
    activeServerId,
    defaultServerId,
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
    window.localStorage.setItem(SERVER_CONNECTIONS_STORAGE_KEY, JSON.stringify(cachedState));
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
  const normalizedKey = getServerConnectionKey(normalizedBaseUrl);
  const now = Date.now();
  const existingById = input.id ? state.servers.find((server) => server.id === input.id) : null;
  const existingByBaseUrl = state.servers.find(
    (server) => getServerConnectionKey(server.baseUrl) === normalizedKey
  );
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
    (server) => server.id !== target?.id && getServerConnectionKey(server.baseUrl) !== normalizedKey
  );
  const servers = dedupeServers([nextServer, ...remaining]);
  const defaultServerId =
    state.defaultServerId &&
    servers.some((server) => server.id === state.defaultServerId)
      ? state.defaultServerId
      : servers.length === 1
        ? (servers[0]?.id ?? null)
        : state.defaultServerId;
  return {
    version: 1,
    activeServerId: state.activeServerId ?? nextServer.id,
    defaultServerId,
    servers,
  };
}

export function setDefaultServerConnection(
  state: ServerConnectionsState,
  serverId: string
): ServerConnectionsState {
  if (!state.servers.some((server) => server.id === serverId)) {
    return state;
  }
  return {
    ...state,
    defaultServerId: serverId,
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
  const activeServerId =
    state.activeServerId === serverId ? (servers[0]?.id ?? null) : state.activeServerId;
  let defaultServerId = state.defaultServerId;
  if (defaultServerId === serverId) {
    defaultServerId = servers.length === 1 ? (servers[0]?.id ?? null) : null;
  }
  if (servers.length === 1) {
    defaultServerId = servers[0]?.id ?? null;
  }
  return {
    version: 1,
    activeServerId,
    defaultServerId,
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
  const servers = dedupeServers(
    state.servers.map((server) =>
      server.id === serverId
        ? { ...server, lastUsedAt: now, updatedAt: now }
        : server
    )
  );
  const defaultServerId =
    state.defaultServerId && servers.some((server) => server.id === state.defaultServerId)
      ? state.defaultServerId
      : servers.length === 1
        ? (servers[0]?.id ?? null)
        : state.defaultServerId;
  return {
    version: 1,
    activeServerId: serverId,
    defaultServerId,
    servers,
  };
}
