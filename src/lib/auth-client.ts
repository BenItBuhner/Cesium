"use client";

export const AUTH_STORAGE_KEY = "opencursor.auth.session";
/** Ephemeral login form draft (sessionStorage) — survives Fast Refresh / full remounts while the tab stays open. */
export const AUTH_LOGIN_DRAFT_KEY = "opencursor.auth.loginDraft";
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

export type AuthLoginDraft = {
  username: string;
  password: string;
  remember: boolean;
};

export function readAuthLoginDraft(): AuthLoginDraft | null {
  if (typeof window === "undefined") {
    return null;
  }
  try {
    const raw = window.sessionStorage.getItem(AUTH_LOGIN_DRAFT_KEY);
    if (!raw) {
      return null;
    }
    const parsed = JSON.parse(raw) as Partial<AuthLoginDraft> | null;
    if (!parsed || typeof parsed !== "object") {
      return null;
    }
    return {
      username: typeof parsed.username === "string" ? parsed.username : "",
      password: typeof parsed.password === "string" ? parsed.password : "",
      remember: typeof parsed.remember === "boolean" ? parsed.remember : true,
    };
  } catch {
    return null;
  }
}

export function writeAuthLoginDraft(draft: AuthLoginDraft): void {
  if (typeof window === "undefined") {
    return;
  }
  try {
    window.sessionStorage.setItem(AUTH_LOGIN_DRAFT_KEY, JSON.stringify(draft));
  } catch {
    // Ignore quota / private mode failures.
  }
}

export function clearAuthLoginDraft(): void {
  if (typeof window === "undefined") {
    return;
  }
  try {
    window.sessionStorage.removeItem(AUTH_LOGIN_DRAFT_KEY);
  } catch {
    // Ignore.
  }
}

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
