"use client";

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
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
  refreshAuthStatus: () => Promise<void>;
  login: (input: LoginInput) => Promise<boolean>;
  logout: () => Promise<void>;
};

const AuthContext = createContext<AuthContextValue | null>(null);

async function fetchAuth(
  serverBaseUrl: string,
  resolvedBaseUrl: string,
  path: string,
  init?: RequestInit
): Promise<Response> {
  return fetch(`${resolvedBaseUrl}${path}`, {
    ...init,
    headers: Object.fromEntries(
      attachSessionToken(init?.headers, serverBaseUrl).entries()
    ),
    credentials: "include",
    cache: "no-store",
  });
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
    setEnabled(payload.enabled);
    setAuthenticated(payload.authenticated);
    setSession(payload.session);
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
  }, [activeServer.baseUrl]);

  useEffect(() => {
    let cancelled = false;
    setReady(false);
    void refreshAuthStatus()
      .catch((nextError) => {
        if (cancelled) {
          return;
        }
        setEnabled(Boolean(getStoredSessionToken(activeServer.baseUrl)));
        setAuthenticated(false);
        setSession(null);
        const message =
          nextError instanceof Error
            ? nextError.message
            : "Failed to determine authentication status.";
        setError(null);
        setConnectionError(message);
      })
      .finally(() => {
        if (!cancelled) {
          setReady(true);
        }
      });
    return () => {
      cancelled = true;
    };
  }, [activeServer.baseUrl, refreshAuthStatus]);

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
          }
          return false;
        }
        setStoredSessionToken(
          getStoredSessionToken(activeServer.baseUrl),
          payload.session,
          activeServer.baseUrl
        );
        updateStoredAuthSession(payload.session, activeServer.baseUrl);
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
    [activeServer.baseUrl]
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
      refreshAuthStatus,
      login,
      logout,
    }),
    [
      authenticated,
      connectionError,
      enabled,
      error,
      login,
      loginPending,
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
