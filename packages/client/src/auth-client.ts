"use client";

import { getActiveServerConnectionFromDefaults as getActiveServerConnection } from "./server-connections-provider-shared";
import { getServerConnectionKey, normalizeServerBaseUrl } from "./server-connections";
import { clientKeyValueStore, clientLocation } from "./platform";

export const AUTH_STORAGE_KEY = "opencursor.auth.sessions";
export const LEGACY_AUTH_STORAGE_KEY = "opencursor.auth.session";
export const SESSION_TOKEN_HEADER = "x-opencursor-session-token";
export const ACCESS_TOKEN_QUERY_PARAM = "access_token";
/**
 * Distinct query param for iframe navigations (browser proxy + DevTools). The
 * proxy strips this before forwarding upstream so we don't clobber a real
 * `?access_token=` that a target site might rely on.
 */
export const IFRAME_ACCESS_TOKEN_QUERY_PARAM = "__ocs_access";

export type AuthSession = {
  username: string;
  createdAt: number;
  expiresAt: number;
  lastSeenAt: number;
  remember: boolean;
};

export type AuthStatusResponse = {
  enabled: boolean;
  authenticated: boolean;
  session: AuthSession | null;
  rotationIntervalMs: number;
};

type StoredAuthState = {
  token: string;
  session: AuthSession | null;
  expiresAt: number | null;
};

type StoredAuthMap = Record<string, StoredAuthState>;

let cachedAuthMap: StoredAuthMap | null = null;

function getServerStorageKey(serverBaseUrl?: string): string {
  const baseUrl = serverBaseUrl?.trim() || getActiveServerConnection().baseUrl;
  return getServerConnectionKey(normalizeServerBaseUrl(baseUrl));
}

function isLoopbackServerKey(value: string): boolean {
  try {
    const url = new URL(decodeURIComponent(value));
    return (
      url.protocol === "http:" &&
      (url.hostname === "localhost" || url.hostname === "127.0.0.1")
    );
  } catch {
    return false;
  }
}

function readLegacyStoredAuthState(): StoredAuthState | null {
  try {
    const raw = clientKeyValueStore().getItem(LEGACY_AUTH_STORAGE_KEY);
    if (!raw) {
      return null;
    }
    const parsed = JSON.parse(raw) as Partial<StoredAuthState> | null;
    if (!parsed || typeof parsed.token !== "string" || parsed.token.trim().length === 0) {
      return null;
    }
    return {
      token: parsed.token,
      session:
        parsed.session &&
        typeof parsed.session === "object" &&
        typeof parsed.session.username === "string" &&
        typeof parsed.session.expiresAt === "number"
          ? (parsed.session as AuthSession)
          : null,
      expiresAt: typeof parsed.expiresAt === "number" ? parsed.expiresAt : null,
    };
  } catch {
    return null;
  }
}

function readStoredAuthMap(): StoredAuthMap {
  if (cachedAuthMap) {
    return cachedAuthMap;
  }
  try {
    const raw = clientKeyValueStore().getItem(AUTH_STORAGE_KEY);
    if (!raw) {
      const legacy = readLegacyStoredAuthState();
      cachedAuthMap = legacy ? { [getServerStorageKey()]: legacy } : {};
      return cachedAuthMap;
    }
    const parsed = JSON.parse(raw) as Record<string, Partial<StoredAuthState>> | null;
    if (!parsed || typeof parsed !== "object") {
      cachedAuthMap = {};
      return cachedAuthMap;
    }
    const next: StoredAuthMap = {};
    for (const [serverKey, value] of Object.entries(parsed)) {
      if (!value || typeof value.token !== "string" || value.token.trim().length === 0) {
        continue;
      }
      next[serverKey] = {
        token: value.token,
        session:
          value.session &&
          typeof value.session === "object" &&
          typeof value.session.username === "string" &&
          typeof value.session.expiresAt === "number"
            ? (value.session as AuthSession)
            : null,
        expiresAt: typeof value.expiresAt === "number" ? value.expiresAt : null,
      };
    }
    cachedAuthMap = next;
    return next;
  } catch {
    cachedAuthMap = {};
    return cachedAuthMap;
  }
}

function writeStoredAuthMap(state: StoredAuthMap): void {
  cachedAuthMap = state;
  try {
    const store = clientKeyValueStore();
    if (Object.keys(state).length === 0) {
      store.removeItem(AUTH_STORAGE_KEY);
    } else {
      store.setItem(AUTH_STORAGE_KEY, JSON.stringify(state));
    }
    store.removeItem(LEGACY_AUTH_STORAGE_KEY);
  } catch {
    // Ignore local persistence failures and rely on cookies/in-memory state.
  }
}

function getStoredAuthState(serverBaseUrl?: string): StoredAuthState | null {
  const map = readStoredAuthMap();
  const serverKey = getServerStorageKey(serverBaseUrl);
  const direct = map[serverKey] ?? null;
  if (direct) {
    return direct;
  }
  if (isLoopbackServerKey(serverKey)) {
    for (const [candidateKey, state] of Object.entries(map)) {
      if (isLoopbackServerKey(candidateKey)) {
        return state;
      }
    }
  }
  return null;
}

export function getStoredSessionToken(serverBaseUrl?: string): string | null {
  return getStoredAuthState(serverBaseUrl)?.token ?? null;
}

export function setStoredSessionToken(
  token: string | null,
  session?: AuthSession | null,
  serverBaseUrl?: string
): void {
  const serverKey = getServerStorageKey(serverBaseUrl);
  const nextToken = token?.trim() ? token.trim() : null;
  const map = { ...readStoredAuthMap() };
  if (!nextToken) {
    delete map[serverKey];
    writeStoredAuthMap(map);
    return;
  }
  const existing = map[serverKey] ?? null;
  map[serverKey] = {
    token: nextToken,
    session: session ?? existing?.session ?? null,
    expiresAt: session?.expiresAt ?? existing?.expiresAt ?? null,
  };
  writeStoredAuthMap(map);
}

export function updateStoredAuthSession(session: AuthSession | null, serverBaseUrl?: string): void {
  const token = getStoredSessionToken(serverBaseUrl);
  if (!token) {
    return;
  }
  setStoredSessionToken(token, session, serverBaseUrl);
}

export function clearStoredAuth(serverBaseUrl?: string): void {
  const serverKey = getServerStorageKey(serverBaseUrl);
  const map = { ...readStoredAuthMap() };
  delete map[serverKey];
  writeStoredAuthMap(map);
}

export function buildAuthenticatedUrl(url: string, serverBaseUrl?: string): string {
  const token = getStoredSessionToken(serverBaseUrl);
  if (!token) {
    return url;
  }
  try {
    const resolved = new URL(url, clientLocation()?.origin ?? "http://localhost");
    resolved.searchParams.set(ACCESS_TOKEN_QUERY_PARAM, token);
    return resolved.toString();
  } catch {
    return url;
  }
}

/**
 * Like {@link buildAuthenticatedUrl} but for iframe navigations to the server's
 * `/browser/*` and `/browser-debug/*` surfaces. Uses a distinct query param so
 * the proxy can safely strip it before forwarding upstream.
 */
export function buildIframeAuthenticatedUrl(url: string, serverBaseUrl?: string): string {
  const token = getStoredSessionToken(serverBaseUrl);
  if (!token) {
    return url;
  }
  try {
    const resolved = new URL(url, clientLocation()?.origin ?? "http://localhost");
    resolved.searchParams.set(IFRAME_ACCESS_TOKEN_QUERY_PARAM, token);
    return resolved.toString();
  } catch {
    return url;
  }
}

export function attachSessionToken(headers?: HeadersInit, serverBaseUrl?: string): Headers {
  const next = new Headers(headers ?? {});
  const token = getStoredSessionToken(serverBaseUrl);
  if (token) {
    next.set(SESSION_TOKEN_HEADER, token);
  }
  return next;
}

export function syncAuthTokenFromResponse(response: Response, serverBaseUrl?: string): string | null {
  const hasSessionTokenHeader = response.headers.has(SESSION_TOKEN_HEADER);
  const token = response.headers.get(SESSION_TOKEN_HEADER)?.trim() || null;
  if (hasSessionTokenHeader && !token) {
    clearStoredAuth(serverBaseUrl);
    return null;
  }
  if (!token) {
    return getStoredSessionToken(serverBaseUrl);
  }
  const expiresAtHeader = response.headers.get("x-opencursor-auth-session-expires-at");
  const existing = getStoredAuthState(serverBaseUrl);
  const nextSession =
    existing?.session && typeof existing.session.username === "string"
      ? existing.session
      : null;
  setStoredSessionToken(token, nextSession, serverBaseUrl);
  if (expiresAtHeader && nextSession) {
    updateStoredAuthSession({
      ...nextSession,
      expiresAt: Number.parseInt(expiresAtHeader, 10) || nextSession.expiresAt,
    }, serverBaseUrl);
  }
  return token;
}
