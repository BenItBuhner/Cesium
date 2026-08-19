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
  syncAuthTokenFromResponse,
  updateStoredAuthSession,
  type AuthSession,
  type AuthStatusResponse,
} from "@/lib/auth-client";
import { useServerConnections } from "@/components/preferences/ServerConnectionsProvider";
import { resolveClientServerBaseUrl } from "@/lib/resolve-server-base-url";

type AuthContextValue = {
  ready: boolean;
  enabled: boolean;
  authenticated: boolean;
  session: AuthSession | null;
  connectionError: string | null;
  /** An actual auth-status response has been received for the active server. */
  hasServerStatus: boolean;
  refreshAuthStatus: () => Promise<void>;
  logout: () => Promise<void>;
};

const AuthContext = createContext<AuthContextValue | null>(null);
// Generous on purpose: a PWA resuming on iPad/Android regularly needs several
// seconds for the radio to wake and the socket to be usable again.
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

/**
 * Tracks the active server's auth status in the background. This never blocks
 * or gates the UI: the workbench always mounts, and sign-in / server
 * connection management happens inside the app (Settings -> Servers, the
 * server picker, DeviceConnectPanel). The workspace layer owns
 * disconnect/reconnect UX with toasts.
 */
export function AuthProvider({ children }: { children: ReactNode }) {
  const { activeServer } = useServerConnections();
  const [ready, setReady] = useState(false);
  const [enabled, setEnabled] = useState(false);
  const [authenticated, setAuthenticated] = useState(false);
  const [session, setSession] = useState<AuthSession | null>(null);
  const [connectionError, setConnectionError] = useState<string | null>(null);
  const [hasServerStatus, setHasServerStatus] = useState(false);
  /**
   * Server id whose auth status has been resolved (successfully or not) at
   * least once. Re-checks for the same server — including rendezvous base-URL
   * re-resolves — must not reset `ready`.
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
    setSession(payload.authenticated ? payload.session : null);
    if (payload.enabled && payload.authenticated) {
      updateStoredAuthSession(payload.session, activeServer.baseUrl);
    } else {
      clearStoredAuth(activeServer.baseUrl);
    }
    setConnectionError(null);
  }, [activeServer.baseUrl, activeServer.id]);

  useEffect(() => {
    let cancelled = false;

    // Switching to a *different server* is a real context change: forget what
    // we knew about the previous server. A base-URL update for the same server
    // (rendezvous re-resolve) keeps everything up.
    if (
      resolvedServerIdRef.current !== null &&
      resolvedServerIdRef.current !== activeServer.id
    ) {
      resolvedServerIdRef.current = null;
      serverStatusServerIdRef.current = null;
      setHasServerStatus(false);
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
        // failure as a (non-blocking) connection error.
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
      setConnectionError(null);
    }
  }, [activeServer.baseUrl]);

  const value = useMemo<AuthContextValue>(
    () => ({
      ready,
      enabled,
      authenticated,
      connectionError,
      session,
      hasServerStatus,
      refreshAuthStatus,
      logout,
    }),
    [
      authenticated,
      connectionError,
      enabled,
      hasServerStatus,
      logout,
      ready,
      refreshAuthStatus,
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
