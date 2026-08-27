/**
 * Local engines may run without a password (loopback-only `npm run dev`).
 * Anything reachable off this machine must already have engine auth on -
 * Cesium will not treat a pasted URL as a usable remote if `/api/auth/status`
 * says the engine is open.
 */

const LOOPBACK_HOSTS = new Set([
  "localhost",
  "127.0.0.1",
  "0.0.0.0",
  "::1",
  // Android emulator alias for the host loopback interface.
  "10.0.2.2",
]);

export const REMOTE_ENGINE_AUTH_REQUIRED_MESSAGE =
  "Cesium will not connect to a non-local engine that has no sign-in. Enable engine authentication (cesium install does this) or use a loopback URL.";

/** The public account / signup site. It is never an engine. */
export const CESIUM_ACCOUNT_SITE_HOSTS = [
  "cesium.techlitnow.com",
  "www.cesium.techlitnow.com",
] as const;

export const CESIUM_ACCOUNT_SITE_NOT_A_SERVER_MESSAGE =
  "cesium.techlitnow.com is the Cesium account site, not an engine. Add your own server.";

export function isCesiumAccountSiteHostname(hostname: string): boolean {
  const host = hostname.trim().toLowerCase().replace(/\.$/, "").replace(/^\[|\]$/g, "");
  return (CESIUM_ACCOUNT_SITE_HOSTS as readonly string[]).includes(host);
}

export function isCesiumAccountSiteUrl(baseUrl: string): boolean {
  try {
    return isCesiumAccountSiteHostname(new URL(baseUrl).hostname);
  } catch {
    return false;
  }
}

export function assertEngineServerUrlAllowed(baseUrl: string): void {
  if (isCesiumAccountSiteUrl(baseUrl)) {
    throw new Error(CESIUM_ACCOUNT_SITE_NOT_A_SERVER_MESSAGE);
  }
}

export function isLoopbackEngineHostname(hostname: string): boolean {
  const host = hostname.trim().toLowerCase().replace(/^\[|\]$/g, "");
  return LOOPBACK_HOSTS.has(host);
}

export function isLoopbackEngineUrl(baseUrl: string): boolean {
  try {
    return isLoopbackEngineHostname(new URL(baseUrl).hostname);
  } catch {
    return false;
  }
}

export function assertEngineConnectionAllowed(input: {
  baseUrl: string;
  authEnabled: boolean | null;
}): void {
  assertEngineServerUrlAllowed(input.baseUrl);
  if (isLoopbackEngineUrl(input.baseUrl)) {
    return;
  }
  if (input.authEnabled === true) {
    return;
  }
  throw new Error(REMOTE_ENGINE_AUTH_REQUIRED_MESSAGE);
}
