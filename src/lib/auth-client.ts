"use client";

import {
  buildServerScopedStorageKey,
  getActiveServerConnection,
  getDefaultServerBaseUrl,
  normalizeServerBaseUrl,
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

const AUTH_STORAGE_PREFIX = `${AUTH_STORAGE_KEY}.`;

const cachedTokenByStorageKey = new Map<string, string | null>();

function getScopedAuthStorageKey(serverBaseUrl?: string | null): string {
  return buildServerScopedStorageKey(AUTH_STORAGE_PREFIX, { serverBaseUrl });
}

function getEffectiveServerBaseUrl(serverBaseUrl?: string | null): string {
  if (typeof serverBaseUrl === "string" && serverBaseUrl.trim().length > 0) {
    return normalizeServerBaseUrl(serverBaseUrl);
  }
  return getActiveServerConnection().baseUrl;
}

function shouldFallbackToLegacyAuthKey(serverBaseUrl?: string | null): boolean {
  return getEffectiveServerBaseUrl(serverBaseUrl) === getDefaultServerBaseUrl();
}

function getLegacyAuthStorageKey(): string {
  return AUTH_STORAGE_KEY;
}

function readStoredAuthState(serverBaseUrl?: string | null): StoredAuthState | null {
  if (typeof window === "undefined") {
    return null;
  }
  try {
    const scopedKey = getScopedAuthStorageKey(serverBaseUrl);
    const raw =
      window.localStorage.getItem(scopedKey) ??
      (shouldFallbackToLegacyAuthKey(serverBaseUrl)
        ? window.localStorage.getItem(getLegacyAuthStorageKey())
        : null);
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

function writeStoredAuthState(state: StoredAuthState | null, serverBaseUrl?: string | null): void {
  if (typeof window === "undefined") {
    return;
  }
  const scopedKey = getScopedAuthStorageKey(serverBaseUrl);
  try {
    if (!state) {
      window.localStorage.removeItem(scopedKey);
      if (shouldFallbackToLegacyAuthKey(serverBaseUrl)) {
        window.localStorage.removeItem(getLegacyAuthStorageKey());
      }
      return;
    }
    const serialized = JSON.stringify(state);
    window.localStorage.setItem(scopedKey, serialized);
    if (shouldFallbackToLegacyAuthKey(serverBaseUrl)) {
      window.localStorage.removeItem(getLegacyAuthStorageKey());
    }
  } catch {
    // Ignore local persistence failures and rely on cookies/in-memory state.
  }
}

export function getStoredSessionToken(serverBaseUrl?: string | null): string | null {
  const scopedKey = getScopedAuthStorageKey(serverBaseUrl);
  if (cachedTokenByStorageKey.has(scopedKey)) {
    return cachedTokenByStorageKey.get(scopedKey) ?? null;
  }
  const stored = readStoredAuthState(serverBaseUrl);
  if (stored?.token) {
    cachedTokenByStorageKey.set(scopedKey, stored.token);
    return stored.token;
  }
  cachedTokenByStorageKey.set(scopedKey, null);
  return null;
}

export function setStoredSessionToken(
  token: string | null,
  session?: AuthSession | null,
  serverBaseUrl?: string | null
): void {
  const scopedKey = getScopedAuthStorageKey(serverBaseUrl);
  const normalizedToken = token?.trim() ? token.trim() : null;
  cachedTokenByStorageKey.set(scopedKey, normalizedToken);
  if (!normalizedToken) {
    writeStoredAuthState(null, serverBaseUrl);
    return;
  }
  const existing = readStoredAuthState(serverBaseUrl);
  writeStoredAuthState({
    token: normalizedToken,
    session: session ?? existing?.session ?? null,
    expiresAt: session?.expiresAt ?? existing?.expiresAt ?? null,
  }, serverBaseUrl);
}

export function updateStoredAuthSession(
  session: AuthSession | null,
  serverBaseUrl?: string | null
): void {
  const token = getStoredSessionToken(serverBaseUrl);
  if (!token) {
    return;
  }
  writeStoredAuthState({
    token,
    session,
    expiresAt: session?.expiresAt ?? null,
  }, serverBaseUrl);
}

export function clearStoredAuth(serverBaseUrl?: string | null): void {
  const scopedKey = getScopedAuthStorageKey(serverBaseUrl);
  cachedTokenByStorageKey.set(scopedKey, null);
  writeStoredAuthState(null, serverBaseUrl);
}

export function buildAuthenticatedUrl(url: string, serverBaseUrl?: string | null): string {
  const token = getStoredSessionToken(serverBaseUrl);
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
  serverBaseUrl?: string | null
): Headers {
  const next = new Headers(headers ?? {});
  const token = getStoredSessionToken(serverBaseUrl);
  if (token) {
    next.set(SESSION_TOKEN_HEADER, token);
  }
  return next;
}

export function syncAuthTokenFromResponse(
  response: Response,
  serverBaseUrl?: string | null
): string | null {
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
  const existing = readStoredAuthState(serverBaseUrl);
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
