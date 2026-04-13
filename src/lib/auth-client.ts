"use client";

import {
  buildServerScopedStorageKey,
  createDefaultServerConnection,
  getActiveServerConnectionSnapshot,
} from "@/lib/server-connections";

export const AUTH_STORAGE_KEY = "opencursor.auth.session";
export const SESSION_TOKEN_HEADER = "x-opencursor-session-token";
export const ACCESS_TOKEN_QUERY_PARAM = "access_token";

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

const cachedTokenByServerId = new Map<string, string | null>();

function resolveServerId(serverId?: string | null): string {
  return serverId ?? getActiveServerConnectionSnapshot().id;
}

function getServerScopedAuthStorageKey(serverId?: string | null): string {
  return buildServerScopedStorageKey(AUTH_STORAGE_KEY, resolveServerId(serverId));
}

function readLegacyStoredAuthState(): StoredAuthState | null {
  if (typeof window === "undefined") {
    return null;
  }
  try {
    const raw = window.localStorage.getItem(AUTH_STORAGE_KEY);
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

function isDefaultServerId(serverId: string): boolean {
  return serverId === createDefaultServerConnection().id;
}

function readStoredAuthState(serverId?: string | null): StoredAuthState | null {
  if (typeof window === "undefined") {
    return null;
  }

  const resolvedServerId = resolveServerId(serverId);
  const scopedKey = getServerScopedAuthStorageKey(resolvedServerId);
  const scopedRaw = window.localStorage.getItem(scopedKey);
  if (scopedRaw) {
    try {
      const parsed = JSON.parse(scopedRaw) as Partial<StoredAuthState> | null;
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

  if (!isDefaultServerId(resolvedServerId)) {
    return null;
  }

  const legacy = readLegacyStoredAuthState();
  if (!legacy) {
    return null;
  }
  writeStoredAuthState(legacy, resolvedServerId);
  try {
    window.localStorage.removeItem(AUTH_STORAGE_KEY);
  } catch {
    // Ignore cleanup failures and continue using the scoped key.
  }
  return legacy;
}

function writeStoredAuthState(
  state: StoredAuthState | null,
  serverId?: string | null
): void {
  if (typeof window === "undefined") {
    return;
  }
  try {
    const resolvedServerId = resolveServerId(serverId);
    const scopedKey = getServerScopedAuthStorageKey(resolvedServerId);
    if (!state) {
      window.localStorage.removeItem(scopedKey);
      if (isDefaultServerId(resolvedServerId)) {
        window.localStorage.removeItem(AUTH_STORAGE_KEY);
      }
      return;
    }
    window.localStorage.setItem(scopedKey, JSON.stringify(state));
    if (isDefaultServerId(resolvedServerId)) {
      window.localStorage.removeItem(AUTH_STORAGE_KEY);
    }
  } catch {
    // Ignore local persistence failures and rely on cookies/in-memory state.
  }
}

export function getStoredSessionToken(serverId?: string | null): string | null {
  const resolvedServerId = resolveServerId(serverId);
  if (cachedTokenByServerId.has(resolvedServerId)) {
    return cachedTokenByServerId.get(resolvedServerId) ?? null;
  }
  const stored = readStoredAuthState(resolvedServerId);
  if (stored?.token) {
    cachedTokenByServerId.set(resolvedServerId, stored.token);
    return stored.token;
  }
  cachedTokenByServerId.set(resolvedServerId, null);
  return null;
}

export function setStoredSessionToken(
  token: string | null,
  session?: AuthSession | null,
  serverId?: string | null
): void {
  const resolvedServerId = resolveServerId(serverId);
  const normalizedToken = token?.trim() ? token.trim() : null;
  cachedTokenByServerId.set(resolvedServerId, normalizedToken);
  if (!normalizedToken) {
    writeStoredAuthState(null, resolvedServerId);
    return;
  }
  const existing = readStoredAuthState(resolvedServerId);
  writeStoredAuthState({
    token: normalizedToken,
    session: session ?? existing?.session ?? null,
    expiresAt: session?.expiresAt ?? existing?.expiresAt ?? null,
  }, resolvedServerId);
}

export function updateStoredAuthSession(
  session: AuthSession | null,
  serverId?: string | null
): void {
  const resolvedServerId = resolveServerId(serverId);
  const token = getStoredSessionToken(resolvedServerId);
  if (!token) {
    return;
  }
  writeStoredAuthState({
    token,
    session,
    expiresAt: session?.expiresAt ?? null,
  }, resolvedServerId);
}

export function clearStoredAuth(serverId?: string | null): void {
  const resolvedServerId = resolveServerId(serverId);
  cachedTokenByServerId.delete(resolvedServerId);
  writeStoredAuthState(null, resolvedServerId);
}

export function buildAuthenticatedUrl(
  url: string,
  serverId?: string | null
): string {
  const token = getStoredSessionToken(serverId);
  if (!token) {
    return url;
  }
  try {
    const resolved = new URL(
      url,
      typeof window !== "undefined" ? window.location.origin : "http://localhost"
    );
    resolved.searchParams.set(ACCESS_TOKEN_QUERY_PARAM, token);
    return resolved.toString();
  } catch {
    return url;
  }
}

export function attachSessionToken(
  headers?: HeadersInit,
  serverId?: string | null
): Headers {
  const next = new Headers(headers ?? {});
  const token = getStoredSessionToken(serverId);
  if (token) {
    next.set(SESSION_TOKEN_HEADER, token);
  }
  return next;
}

export function syncAuthTokenFromResponse(
  response: Response,
  serverId?: string | null
): string | null {
  const resolvedServerId = resolveServerId(serverId);
  const hasSessionTokenHeader = response.headers.has(SESSION_TOKEN_HEADER);
  const token = response.headers.get(SESSION_TOKEN_HEADER)?.trim() || null;
  if (hasSessionTokenHeader && !token) {
    clearStoredAuth(resolvedServerId);
    return null;
  }
  if (!token) {
    return getStoredSessionToken(resolvedServerId);
  }
  const expiresAtHeader = response.headers.get("x-opencursor-auth-session-expires-at");
  const existing = readStoredAuthState(resolvedServerId);
  const nextSession =
    existing?.session && typeof existing.session.username === "string"
      ? existing.session
      : null;
  setStoredSessionToken(token, nextSession, resolvedServerId);
  if (expiresAtHeader && nextSession) {
    updateStoredAuthSession({
      ...nextSession,
      expiresAt: Number.parseInt(expiresAtHeader, 10) || nextSession.expiresAt,
    }, resolvedServerId);
  }
  return token;
}
