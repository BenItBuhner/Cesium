"use client";

export const AUTH_STORAGE_KEY = "opencursor.auth.session";
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

let cachedToken: string | null = null;

function readStoredAuthState(): StoredAuthState | null {
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

function writeStoredAuthState(state: StoredAuthState | null): void {
  if (typeof window === "undefined") {
    return;
  }
  try {
    if (!state) {
      window.localStorage.removeItem(AUTH_STORAGE_KEY);
      return;
    }
    window.localStorage.setItem(AUTH_STORAGE_KEY, JSON.stringify(state));
  } catch {
    // Ignore local persistence failures and rely on cookies/in-memory state.
  }
}

export function getStoredSessionToken(): string | null {
  if (cachedToken) {
    return cachedToken;
  }
  const stored = readStoredAuthState();
  if (stored?.token) {
    cachedToken = stored.token;
    return stored.token;
  }
  return null;
}

export function setStoredSessionToken(token: string | null, session?: AuthSession | null): void {
  cachedToken = token?.trim() ? token.trim() : null;
  if (!cachedToken) {
    writeStoredAuthState(null);
    return;
  }
  const existing = readStoredAuthState();
  writeStoredAuthState({
    token: cachedToken,
    session: session ?? existing?.session ?? null,
    expiresAt: session?.expiresAt ?? existing?.expiresAt ?? null,
  });
}

export function updateStoredAuthSession(session: AuthSession | null): void {
  const token = getStoredSessionToken();
  if (!token) {
    return;
  }
  writeStoredAuthState({
    token,
    session,
    expiresAt: session?.expiresAt ?? null,
  });
}

export function clearStoredAuth(): void {
  cachedToken = null;
  writeStoredAuthState(null);
}

export function buildAuthenticatedUrl(url: string): string {
  const token = getStoredSessionToken();
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

/**
 * Like {@link buildAuthenticatedUrl} but for iframe navigations to the server's
 * `/browser/*` and `/browser-debug/*` surfaces. Uses a distinct query param so
 * the proxy can safely strip it before forwarding upstream.
 */
export function buildIframeAuthenticatedUrl(url: string): string {
  const token = getStoredSessionToken();
  if (!token) {
    return url;
  }
  try {
    const resolved = new URL(
      url,
      typeof window !== "undefined" ? window.location.origin : "http://localhost"
    );
    resolved.searchParams.set(IFRAME_ACCESS_TOKEN_QUERY_PARAM, token);
    return resolved.toString();
  } catch {
    return url;
  }
}

export function attachSessionToken(headers?: HeadersInit): Headers {
  const next = new Headers(headers ?? {});
  const token = getStoredSessionToken();
  if (token) {
    next.set(SESSION_TOKEN_HEADER, token);
  }
  return next;
}

export function syncAuthTokenFromResponse(response: Response): string | null {
  const hasSessionTokenHeader = response.headers.has(SESSION_TOKEN_HEADER);
  const token = response.headers.get(SESSION_TOKEN_HEADER)?.trim() || null;
  if (hasSessionTokenHeader && !token) {
    clearStoredAuth();
    return null;
  }
  if (!token) {
    return getStoredSessionToken();
  }
  const expiresAtHeader = response.headers.get("x-opencursor-auth-session-expires-at");
  const existing = readStoredAuthState();
  const nextSession =
    existing?.session && typeof existing.session.username === "string"
      ? existing.session
      : null;
  setStoredSessionToken(token, nextSession);
  if (expiresAtHeader && nextSession) {
    updateStoredAuthSession({
      ...nextSession,
      expiresAt: Number.parseInt(expiresAtHeader, 10) || nextSession.expiresAt,
    });
  }
  return token;
}
