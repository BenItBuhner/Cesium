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
import { getServerBaseUrl } from "@/lib/server-api";
import { useServerConnections } from "@/components/server/ServerConnectionsProvider";

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
  refreshAuthStatus: () => Promise<void>;
  login: (input: LoginInput) => Promise<boolean>;
  logout: () => Promise<void>;
};

const AuthContext = createContext<AuthContextValue | null>(null);

async function fetchAuth(
  serverBaseUrl: string,
  path: string,
  init?: RequestInit
): Promise<Response> {
  return fetch(`${serverBaseUrl}${path}`, {
    ...init,
    headers: Object.fromEntries(
      attachSessionToken(init?.headers, serverBaseUrl).entries()
    ),
    credentials: "include",
    cache: "no-store",
  });
}

export function AuthProvider({ children }: { children: ReactNode }) {
  const { activeServerId } = useServerConnections();
  const [ready, setReady] = useState(false);
  const [enabled, setEnabled] = useState(false);
  const [authenticated, setAuthenticated] = useState(false);
  const [session, setSession] = useState<AuthSession | null>(null);
  const [loginPending, setLoginPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const refreshAuthStatus = useCallback(async () => {
    const serverBaseUrl = getServerBaseUrl();
    const response = await fetchAuth(serverBaseUrl, "/api/auth/status");
    syncAuthTokenFromResponse(response, serverBaseUrl);
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
      clearStoredAuth(serverBaseUrl);
    } else if (payload.authenticated) {
      updateStoredAuthSession(payload.session, serverBaseUrl);
    } else {
      clearStoredAuth(serverBaseUrl);
    }
    if (!payload.authenticated) {
      setSession(null);
    }
    setError(null);
  }, []);

  useEffect(() => {
    let cancelled = false;
    setReady(false);
    void refreshAuthStatus()
      .catch((nextError) => {
        if (cancelled) {
          return;
        }
        setEnabled(Boolean(getStoredSessionToken()));
        setAuthenticated(false);
        setSession(null);
        setError(
          nextError instanceof Error
            ? nextError.message
            : "Failed to determine authentication status."
        );
      })
      .finally(() => {
        if (!cancelled) {
          setReady(true);
        }
      });
    return () => {
      cancelled = true;
    };
  }, [activeServerId, refreshAuthStatus]);

  const login = useCallback(
    async (input: LoginInput) => {
      setLoginPending(true);
      setError(null);
      try {
        const serverBaseUrl = getServerBaseUrl();
        const response = await fetchAuth(serverBaseUrl, "/api/auth/login", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(input),
        });
        syncAuthTokenFromResponse(response, serverBaseUrl);
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
            clearStoredAuth(serverBaseUrl);
          }
          return false;
        }
        setStoredSessionToken(
          getStoredSessionToken(serverBaseUrl),
          payload.session,
          serverBaseUrl
        );
        updateStoredAuthSession(payload.session, serverBaseUrl);
        setEnabled(true);
        setAuthenticated(true);
        setSession(payload.session);
        setError(null);
        return true;
      } catch (nextError) {
        const message =
          nextError instanceof Error ? nextError.message : "Login failed.";
        setError(message);
        setAuthenticated(false);
        setSession(null);
        return false;
      } finally {
        setLoginPending(false);
      }
    },
    []
  );

  const logout = useCallback(async () => {
    const serverBaseUrl = getServerBaseUrl();
    try {
      const response = await fetchAuth(serverBaseUrl, "/api/auth/logout", {
        method: "POST",
      });
      if (response.ok) {
        syncAuthTokenFromResponse(response, serverBaseUrl);
      }
    } catch {
      // Clearing local auth state is enough for the client.
    } finally {
      clearStoredAuth(serverBaseUrl);
      setAuthenticated(false);
      setSession(null);
      setError(null);
      if (enabled) {
        setEnabled(true);
      }
    }
  }, [enabled]);

  const value = useMemo<AuthContextValue>(
    () => ({
      ready,
      enabled,
      authenticated,
      session,
      loginPending,
      error,
      refreshAuthStatus,
      login,
      logout,
    }),
    [
      authenticated,
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
