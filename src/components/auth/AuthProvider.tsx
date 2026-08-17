"use client";

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import {
  attachSessionToken,
  clearStoredAuth,
  getStoredSessionToken,
  setStoredSessionToken,
  syncAuthTokenFromResponse,
  updateStoredAuthSession,
  type AuthSession,
  type AuthStatusResponse,
} from "@/lib/auth-client";
import { useServerConnections } from "@/components/preferences/ServerConnectionsProvider";
import { resolveClientServerBaseUrl } from "@/lib/resolve-server-base-url";

type LoginInput = {
  username: string;
  password: string;
  remember: boolean;
};

type AuthContextValue = {
  ready: boolean;
  enabled: boolean;
  authenticated: boolean;
  session: AuthSession | null;
  loginPending: boolean;
  error: string | null;
  connectionError: string | null;
  /** An actual auth-status response has been received for the active server. */
  hasServerStatus: boolean;
  /**
   * The latest *server response* said auth is enabled and this client is not
   * authenticated. Network failures never set this — only real HTTP answers.
   */
  serverConfirmedSignedOut: boolean;
  refreshAuthStatus: () => Promise<void>;
  login: (input: LoginInput) => Promise<boolean>;
  logout: () => Promise<void>;
};

const AuthContext = createContext<AuthContextValue | null>(null);
// Generous on purpose: a PWA resuming on iPad/Android regularly needs several
// seconds for the radio to wake and the socket to be usable again. The old 4s
// budget produced spurious "Check Cesium server" screens on every resume.
const AUTH_REQUEST_TIMEOUT_MS = 8_000;
/** One silent retry before surfacing a boot connection error. */
const AUTH_STATUS_RETRY_DELAY_MS = 1_500;

async function fetchAuth(
  serverBaseUrl: string,
  resolvedBaseUrl: string,
  path: string,
  init?: RequestInit
): Promise<Response> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), AUTH_REQUEST_TIMEOUT_MS);
  try {
    return await fetch(`${resolvedBaseUrl}${path}`, {
      ...init,
      headers: Object.fromEntries(
        attachSessionToken(init?.headers, serverBaseUrl).entries()
      ),
      credentials: "include",
      cache: "no-store",
      signal: controller.signal,
    });
  } catch (error) {
    if (error instanceof Error && error.name === "AbortError") {
      throw new Error(`Auth request timed out after ${AUTH_REQUEST_TIMEOUT_MS}ms.`);
    }
    throw error;
  } finally {
    clearTimeout(timeout);
  }
}

export function AuthProvider({ children }: { children: ReactNode }) {
  const { activeServer } = useServerConnections();
  const [ready, setReady] = useState(false);
  const [enabled, setEnabled] = useState(false);
  const [authenticated, setAuthenticated] = useState(false);
  const [session, setSession] = useState<AuthSession | null>(null);
  const [loginPending, setLoginPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [connectionError, setConnectionError] = useState<string | null>(null);
  const [hasServerStatus, setHasServerStatus] = useState(false);
  const [serverConfirmedSignedOut, setServerConfirmedSignedOut] = useState(false);
  /**
   * Server id whose auth status has been resolved (successfully or not) at
   * least once. Re-checks for the same server — including rendezvous base-URL
   * re-resolves — must not tear the UI back down to the boot splash.
   */
  const resolvedServerIdRef = useRef<string | null>(null);
  /** Server id for which a real auth-status response has been received. */
  const serverStatusServerIdRef = useRef<string | null>(null);

  const refreshAuthStatus = useCallback(async () => {
    const resolvedBaseUrl = resolveClientServerBaseUrl();
    const response = await fetchAuth(activeServer.baseUrl, resolvedBaseUrl, "/api/auth/status");
    syncAuthTokenFromResponse(response, activeServer.baseUrl);
    if (!response.ok) {
      let message = `Auth status request failed (${response.status})`;
      try {
        const payload = (await response.json()) as { error?: string };
        if (payload.error) {
          message = payload.error;
        }
      } catch {
        // fall through
      }
      throw new Error(message);
    }
    const payload = (await response.json()) as AuthStatusResponse;
    serverStatusServerIdRef.current = activeServer.id;
    setHasServerStatus(true);
    setEnabled(payload.enabled);
    setAuthenticated(payload.authenticated);
    setSession(payload.session);
    setServerConfirmedSignedOut(payload.enabled && !payload.authenticated);
    if (!payload.enabled) {
      clearStoredAuth(activeServer.baseUrl);
    } else if (payload.authenticated) {
      updateStoredAuthSession(payload.session, activeServer.baseUrl);
    } else {
      clearStoredAuth(activeServer.baseUrl);
    }
    if (!payload.authenticated) {
      setSession(null);
    }
    setError(null);
    setConnectionError(null);
  }, [activeServer.baseUrl, activeServer.id]);

  useEffect(() => {
    let cancelled = false;

    // Switching to a *different server* is a real context change: forget what
    // we knew and show the splash while the new server is checked. A base-URL
    // update for the same server (rendezvous re-resolve) keeps everything up.
    if (
      resolvedServerIdRef.current !== null &&
      resolvedServerIdRef.current !== activeServer.id
    ) {
      resolvedServerIdRef.current = null;
      serverStatusServerIdRef.current = null;
      setHasServerStatus(false);
      setServerConfirmedSignedOut(false);
    }
    const isRecheck = resolvedServerIdRef.current === activeServer.id;

    const hasCachedSession = Boolean(getStoredSessionToken(activeServer.baseUrl));
    if (!hasCachedSession && !isRecheck) {
      setReady(false);
    }

    const applyNetworkFailure = (nextError: unknown) => {
      const message =
        nextError instanceof Error
          ? nextError.message
          : "Failed to determine authentication status.";
      if (serverStatusServerIdRef.current === activeServer.id) {
        // This server already answered before; a failed re-check is a
        // connectivity blip, not an auth decision. Keep the session state and
        // let the workspace layer own the disconnect UX.
        setConnectionError(message);
        return;
      }
      setEnabled(Boolean(getStoredSessionToken(activeServer.baseUrl)));
      setAuthenticated(false);
      setSession(null);
      setError(null);
      setConnectionError(message);
    };

    void (async () => {
      try {
        await refreshAuthStatus();
      } catch (firstError) {
        if (cancelled) {
          return;
        }
        // Cold boots and PWA resumes routinely lose the very first request
        // while the network stack wakes up. Retry once before surfacing the
        // failure and (potentially) blocking the UI on a connection screen.
        await new Promise((resolve) =>
          setTimeout(resolve, AUTH_STATUS_RETRY_DELAY_MS)
        );
        if (cancelled) {
          return;
        }
        try {
          await refreshAuthStatus();
        } catch (retryError) {
          if (cancelled) {
            return;
          }
          applyNetworkFailure(retryError ?? firstError);
        }
      } finally {
        if (!cancelled) {
          resolvedServerIdRef.current = activeServer.id;
          setReady(true);
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [activeServer.baseUrl, activeServer.id, refreshAuthStatus]);

  const login = useCallback(
    async (input: LoginInput) => {
      setLoginPending(true);
      setError(null);
      setConnectionError(null);
      try {
        const response = await fetchAuth(activeServer.baseUrl, resolveClientServerBaseUrl(), "/api/auth/login", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(input),
        });
        syncAuthTokenFromResponse(response, activeServer.baseUrl);
        const payload = (await response.json().catch(() => ({}))) as
          | {
              authenticated?: boolean;
              session?: AuthSession | null;
              token?: string;
              error?: string;
            }
          | Record<string, never>;
        if (!response.ok || payload.authenticated !== true || !payload.session) {
          const message =
            typeof payload.error === "string"
              ? payload.error
              : "Invalid username or password.";
          setAuthenticated(false);
          setSession(null);
          setError(message);
          if (response.status === 401) {
            clearStoredAuth(activeServer.baseUrl);
            serverStatusServerIdRef.current = activeServer.id;
            setHasServerStatus(true);
            setServerConfirmedSignedOut(true);
          }
          return false;
        }
        setStoredSessionToken(
          typeof payload.token === "string"
            ? payload.token
            : getStoredSessionToken(activeServer.baseUrl),
          payload.session,
          activeServer.baseUrl
        );
        updateStoredAuthSession(payload.session, activeServer.baseUrl);
        serverStatusServerIdRef.current = activeServer.id;
        setHasServerStatus(true);
        setServerConfirmedSignedOut(false);
        setEnabled(true);
        setAuthenticated(true);
        setSession(payload.session);
        setError(null);
        setConnectionError(null);
        return true;
      } catch (nextError) {
        const message =
          nextError instanceof Error ? nextError.message : "Login failed.";
        setConnectionError(message);
        setError(null);
        setAuthenticated(false);
        setSession(null);
        return false;
      } finally {
        setLoginPending(false);
      }
    },
    [activeServer.baseUrl, activeServer.id]
  );

  const logout = useCallback(async () => {
    try {
      const response = await fetchAuth(activeServer.baseUrl, resolveClientServerBaseUrl(), "/api/auth/logout", {
        method: "POST",
      });
      if (response.ok) {
        syncAuthTokenFromResponse(response, activeServer.baseUrl);
      }
    } catch {
      // Clearing local auth state is enough for the client.
    } finally {
      clearStoredAuth(activeServer.baseUrl);
      setAuthenticated(false);
      setSession(null);
      setError(null);
      setConnectionError(null);
      if (enabled) {
        setEnabled(true);
        // An explicit logout is the user confirming the signed-out state; the
        // gate must come back even though the workbench was latched open.
        setServerConfirmedSignedOut(true);
      }
    }
  }, [activeServer.baseUrl, enabled]);

  const value = useMemo<AuthContextValue>(
    () => ({
      ready,
      enabled,
      authenticated,
      connectionError,
      session,
      loginPending,
      error,
      hasServerStatus,
      serverConfirmedSignedOut,
      refreshAuthStatus,
      login,
      logout,
    }),
    [
      authenticated,
      connectionError,
      enabled,
      error,
      hasServerStatus,
      login,
      loginPending,
      logout,
      ready,
      refreshAuthStatus,
      serverConfirmedSignedOut,
      session,
    ]
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthContextValue {
  const context = useContext(AuthContext);
  if (!context) {
    throw new Error("useAuth must be used within AuthProvider");
  }
  return context;
}

/**
 * Auth context when available, null otherwise. For surfaces (e.g. settings
 * account chrome) that may render outside the engine-auth provider tree.
 */
export function useOptionalAuth(): AuthContextValue | null {
  return useContext(AuthContext);
}
