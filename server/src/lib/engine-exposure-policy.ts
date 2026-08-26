const LOOPBACK_HOSTS = new Set([
  "localhost",
  "127.0.0.1",
  "::1",
  "10.0.2.2",
]);

export function isLoopbackEngineHostname(hostname: string): boolean {
  const host = hostname.trim().toLowerCase().replace(/^\[|\]$/g, "");
  return LOOPBACK_HOSTS.has(host);
}

export const ENGINE_EXPOSURE_AUTH_REQUIRED_MESSAGE =
  "Cesium refuses to expose an engine without authentication. Set OPENCURSOR_AUTH_USERNAME and OPENCURSOR_AUTH_PASSWORD, or run `cesium install`, which generates them.";

export const PUBLIC_ACCESS_LOCAL_CONTROL_MESSAGE =
  "Public access can only be turned on from this machine until engine authentication is configured.";

export function isLoopbackBindHost(host: string): boolean {
  return isLoopbackEngineHostname(host);
}

export function requestHostname(url: string): string {
  try {
    return new URL(url).hostname;
  } catch {
    return "";
  }
}

export function isLoopbackControlRequest(url: string): boolean {
  return isLoopbackBindHost(requestHostname(url));
}

/**
 * Binding anything other than loopback, or publishing a tunnel / custom
 * public URL, is exposure. Exposure without engine auth is never allowed.
 */
export function assertEngineExposureAllowed(input: {
  bindHost: string;
  authEnabled: boolean;
  publicAccessEnabled?: boolean;
  customPublicUrl?: string | null;
}): void {
  const exposing =
    !isLoopbackBindHost(input.bindHost) ||
    input.publicAccessEnabled === true ||
    Boolean(input.customPublicUrl?.trim());
  if (!exposing) {
    return;
  }
  if (!input.authEnabled) {
    throw new Error(ENGINE_EXPOSURE_AUTH_REQUIRED_MESSAGE);
  }
}
