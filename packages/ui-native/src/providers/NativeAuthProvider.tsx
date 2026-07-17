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
  resolveClientServerBaseUrl,
  setStoredSessionToken,
  syncAuthTokenFromResponse,
  updateStoredAuthSession,
  type AuthSession,
  type AuthStatusResponse,
} from "@cesium/client";
import { useServerConnections } from "@cesium/client/react";

/**
 * Native port of the web `AuthProvider` (src/components/auth/AuthProvider.tsx).
 * Identical status/login/logout flow against `/api/auth/*`, backed by the
 * shared @cesium/client auth-token storage (keyed per server).
 */

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
const AUTH_REQUEST_TIMEOUT_MS = 4_000;

async function fetchAuth(
  serverBaseUrl: string,
  resolvedBaseUrl: string,
  path: string,
  init?: RequestInit,
  externalSignal?: AbortSignal
): Promise<Response> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), AUTH_REQUEST_TIMEOUT_MS);
  const onExternalAbort = () => controller.abort();
  externalSignal?.addEventListener("abort", onExternalAbort);
  try {
    return await fetch(`${resolvedBaseUrl}${path}`, {
      ...init,
      headers: Object.fromEntries(
        attachSessionToken(init?.headers, serverBaseUrl).entries()
      ),
      cache: "no-store",
      signal: controller.signal,
    });
  } catch (error) {
    if (error instanceof Error && error.name === "AbortError") {
      if (externalSignal?.aborted) {
        throw new DOMException("Auth request aborted.", "AbortError");
      }
      throw new Error(`Auth request timed out after ${AUTH_REQUEST_TIMEOUT_MS}ms.`);
    }
    throw error;
  } finally {
    externalSignal?.removeEventListener("abort", onExternalAbort);
    clearTimeout(timeout);
  }
}

export function NativeAuthProvider({ children }: { children: ReactNode }) {
  const { activeServer } = useServerConnections();
  const [ready, setReady] = useState(false);
  const [enabled, setEnabled] = useState(false);
  const [authenticated, setAuthenticated] = useState(false);
  const [session, setSession] = useState<AuthSession | null>(null);
  const [loginPending, setLoginPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [connectionError, setConnectionError] = useState<string | null>(null);
  const authRequestIdRef = useRef(0);
  const authAbortRef = useRef<AbortController | null>(null);

  const refreshAuthStatus = useCallback(async () => {
    authAbortRef.current?.abort();
    const controller = new AbortController();
    authAbortRef.current = controller;
    const requestId = ++authRequestIdRef.current;
    const requestBaseUrl = activeServer.baseUrl;
    const isCurrent = () => requestId === authRequestIdRef.current;

    try {
      const resolvedBaseUrl = resolveClientServerBaseUrl();
      const response = await fetchAuth(
        requestBaseUrl,
        resolvedBaseUrl,
        "/api/auth/status",
        undefined,
        controller.signal
      );
      if (!isCurrent()) {
        return;
      }
      syncAuthTokenFromResponse(response, requestBaseUrl);
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
      if (!isCurrent()) {
        return;
      }
      setEnabled(payload.enabled);
      setAuthenticated(payload.authenticated);
      setSession(payload.session);
      if (!payload.enabled) {
        clearStoredAuth(requestBaseUrl);
      } else if (payload.authenticated) {
        updateStoredAuthSession(payload.session, requestBaseUrl);
      } else {
        clearStoredAuth(requestBaseUrl);
      }
      if (!payload.authenticated) {
        setSession(null);
      }
      setError(null);
      setConnectionError(null);
    } catch (nextError) {
      // A newer refresh (or effect cleanup) superseded this request — do not
      // clobber the current server's auth/connection state.
      if (!isCurrent()) {
        return;
      }
      const message =
        nextError instanceof Error
          ? nextError.message
          : "Failed to determine authentication status.";
      setEnabled(Boolean(getStoredSessionToken(requestBaseUrl)));
      setAuthenticated(false);
      setSession(null);
      setError(null);
      setConnectionError(message);
      throw nextError instanceof Error
        ? nextError
        : new Error("Failed to determine authentication status.");
    }
  }, [activeServer.baseUrl]);

  useEffect(() => {
    let cancelled = false;
    const hasCachedSession = Boolean(getStoredSessionToken(activeServer.baseUrl));
    if (!hasCachedSession) {
      setReady(false);
    }
    void refreshAuthStatus()
      .catch(() => {
        // connectionError is set inside refreshAuthStatus for current requests.
      })
      .finally(() => {
        if (!cancelled) {
          setReady(true);
        }
      });
    return () => {
      cancelled = true;
      authAbortRef.current?.abort();
      authRequestIdRef.current += 1;
    };
  }, [activeServer.baseUrl, refreshAuthStatus]);

  const login = useCallback(
    async (input: LoginInput) => {
      setLoginPending(true);
      setError(null);
      setConnectionError(null);
      try {
        const response = await fetchAuth(
          activeServer.baseUrl,
          resolveClientServerBaseUrl(),
          "/api/auth/login",
          {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(input),
          }
        );
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
      const response = await fetchAuth(
        activeServer.baseUrl,
        resolveClientServerBaseUrl(),
        "/api/auth/logout",
        { method: "POST" }
      );
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
    }
  }, [activeServer.baseUrl]);

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

export function useNativeAuth(): AuthContextValue {
  const context = useContext(AuthContext);
  if (!context) {
    throw new Error("useNativeAuth must be used within NativeAuthProvider");
  }
  return context;
}
