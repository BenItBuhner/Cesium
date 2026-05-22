import { attachSessionToken } from "@/lib/auth-client";
import { normalizeServerBaseUrl } from "@/lib/server-connections";

export type ServerProbeResult = {
  ok: boolean;
  healthOk: boolean;
  authEnabled: boolean | null;
  authenticated: boolean | null;
  error: string | null;
};

export async function probeServerBaseUrl(baseUrl: string): Promise<ServerProbeResult> {
  const normalizedBaseUrl = normalizeServerBaseUrl(baseUrl);
  try {
    const healthResponse = await fetch(`${normalizedBaseUrl}/health`, {
      method: "GET",
      cache: "no-store",
      signal: AbortSignal.timeout(8_000),
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
      const authResponse = await fetch(`${normalizedBaseUrl}/api/auth/status`, {
        method: "GET",
        headers: attachSessionToken(undefined, normalizedBaseUrl),
        credentials: "include",
        cache: "no-store",
        signal: AbortSignal.timeout(8_000),
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
