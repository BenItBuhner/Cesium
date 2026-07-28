import { attachSessionToken } from "./auth-client";
import { normalizeServerBaseUrl } from "./server-connections";
import { resolveServerRequestBaseUrlForCurrentWindow } from "./resolve-server-base-url";

export type ServerProbeResult = {
  ok: boolean;
  healthOk: boolean;
  authEnabled: boolean | null;
  authenticated: boolean | null;
  error: string | null;
};

export function timeoutSignal(timeoutMs: number): AbortSignal {
  if (typeof AbortSignal.timeout === "function") {
    return AbortSignal.timeout(timeoutMs);
  }
  const controller = new AbortController();
  setTimeout(() => controller.abort(), timeoutMs);
  return controller.signal;
}

export async function probeServerBaseUrl(baseUrl: string): Promise<ServerProbeResult> {
  const normalizedBaseUrl = normalizeServerBaseUrl(baseUrl);
  // Probe through the same URL real requests use. Behind an HTTPS reverse
  // proxy the raw stored URL (HTTP loopback/LAN) is unreachable from the
  // browser, and probing it directly would keep the active server marked
  // "offline" forever (and could trigger bogus active-server failover) even
  // though every actual API call works via same-origin.
  const requestBaseUrl = resolveServerRequestBaseUrlForCurrentWindow(normalizedBaseUrl);
  try {
    const healthResponse = await fetch(`${requestBaseUrl}/health`, {
      method: "GET",
      cache: "no-store",
      signal: timeoutSignal(8_000),
    });
    if (!healthResponse.ok) {
      return {
        ok: false,
        healthOk: false,
        authEnabled: null,
        authenticated: null,
        error: `Health check failed (${healthResponse.status}).`,
      };
    }

    try {
      const authResponse = await fetch(`${requestBaseUrl}/api/auth/status`, {
        method: "GET",
        headers: attachSessionToken(undefined, normalizedBaseUrl),
        credentials: "include",
        cache: "no-store",
        signal: timeoutSignal(8_000),
      });
      if (!authResponse.ok) {
        return {
          ok: true,
          healthOk: true,
          authEnabled: null,
          authenticated: null,
          error: null,
        };
      }
      const payload = (await authResponse.json()) as {
        enabled?: boolean;
        authenticated?: boolean;
      };
      return {
        ok: true,
        healthOk: true,
        authEnabled: payload.enabled === true,
        authenticated:
          typeof payload.authenticated === "boolean" ? payload.authenticated : null,
        error: null,
      };
    } catch {
      return {
        ok: true,
        healthOk: true,
        authEnabled: null,
        authenticated: null,
        error: null,
      };
    }
  } catch (error) {
    return {
      ok: false,
      healthOk: false,
      authEnabled: null,
      authenticated: null,
      error: error instanceof Error ? error.message : "Failed to reach server.",
    };
  }
}
