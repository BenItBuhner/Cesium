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

const BASE_URL =
  process.env.NEXT_PUBLIC_SERVER_URL?.replace(/\/+$/, "") ??
  "http://localhost:9100";

function resolveClientBaseUrl(): string {
  if (typeof window === "undefined") {
    return BASE_URL;
  }
  try {
    const configured = new URL(BASE_URL);
    const currentHost = window.location.hostname;
    if (
      currentHost &&
      currentHost !== configured.hostname &&
      (currentHost === "127.0.0.1" || currentHost === "localhost")
    ) {
      configured.hostname = currentHost;
      configured.port = configured.port || "9100";
      return configured.toString().replace(/\/+$/, "");
    }
  } catch {
    return BASE_URL;
  }
  return BASE_URL;
}

async function fetchAuth(
  path: string,
  init?: RequestInit
): Promise<Response> {
  return fetch(`${resolveClientBaseUrl()}${path}`, {
    ...init,
    headers: Object.fromEntries(
      attachSessionToken(init?.headers).entries()
    ),
    credentials: "include",
    cache: "no-store",
  });
}

export function AuthProvider({ children }: { children: ReactNode }) {
  const [ready, setReady] = useState(false);
  const [enabled, setEnabled] = useState(false);
  const [authenticated, setAuthenticated] = useState(false);
  const [session, setSession] = useState<AuthSession | null>(null);
  const [loginPending, setLoginPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const refreshAuthStatus = useCallback(async () => {
    const response = await fetchAuth("/api/auth/status");
    syncAuthTokenFromResponse(response);
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
      clearStoredAuth();
    } else if (payload.authenticated) {
      updateStoredAuthSession(payload.session);
    } else {
      clearStoredAuth();
    }
    if (!payload.authenticated) {
      setSession(null);
    }
    setError(null);
  }, []);

  useEffect(() => {
    let cancelled = false;
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
  }, [refreshAuthStatus]);

  const login = useCallback(
    async (input: LoginInput) => {
      setLoginPending(true);
      setError(null);
      try {
        const response = await fetchAuth("/api/auth/login", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(input),
        });
        syncAuthTokenFromResponse(response);
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
            clearStoredAuth();
          }
          return false;
        }
        setStoredSessionToken(getStoredSessionToken(), payload.session);
        updateStoredAuthSession(payload.session);
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
    try {
      const response = await fetchAuth("/api/auth/logout", {
        method: "POST",
      });
      if (response.ok) {
        syncAuthTokenFromResponse(response);
      }
    } catch {
      // Clearing local auth state is enough for the client.
    } finally {
      clearStoredAuth();
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
