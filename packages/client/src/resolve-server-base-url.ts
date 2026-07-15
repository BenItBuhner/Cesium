import { getConfiguredServerBaseUrl, getConfiguredServerPort } from "./configured-server-base-url";
import { getActiveServerBaseUrl } from "./server-connections";
import { clientLocation } from "./platform";

export { getConfiguredServerBaseUrl } from "./configured-server-base-url";

/**
 * URL the browser should use for HTTP and WebSocket calls to the Cesium API.
 *
 * Goal: never trip mixed-content, and never hit the browser's own loopback
 * when the page is opened from another host.
 *
 * Rules (in order):
 *   1. HTTPS page + HTTP configured base → return `""` (same-origin). The
 *      hosting reverse proxy (Caddy/nginx/Cloudflare) is expected to forward
 *      `/api/*` and `/ws/*` to the real API; this avoids mixed-content blocks
 *      when the bundle was built for a LAN URL but served over TLS.
 *   2. Dev on localhost: keep the cookie origin aligned with the page
 *      (http vs https, 127.0.0.1 vs localhost).
 *   3. LAN plain-HTTP: if the bundle still says loopback but the UI is opened
 *      as `http://192.168.x.x:3000`, rewrite to the same host as the page on
 *      the configured API port.
 *   4. Otherwise: return the configured URL untouched.
 */
export function resolveClientServerBaseUrl(): string {
  const raw = getActiveServerBaseUrl(getConfiguredServerBaseUrl());

  return resolveClientServerBaseUrlForCurrentWindow(raw);
}

function currentLocationSource(): { location: { protocol: string; hostname: string; host: string } } | null {
  const location = clientLocation();
  return location ? { location } : null;
}

export function resolveClientServerBaseUrlForCurrentWindow(raw: string): string {
  return resolveClientServerBaseUrlForLocation(raw, currentLocationSource());
}

/** Resolve an explicitly chosen server without collapsing it to the page origin. */
export function resolveExplicitServerBaseUrlForCurrentWindow(raw: string): string {
  return resolveClientServerBaseUrlForLocation(raw, currentLocationSource(), {
    explicitTarget: true,
  });
}

/** Parse `?serverUrl=` for one-time bootstrap (not used for every API call). */
export function parseServerUrlSearchParam(search: string): string | null {
  try {
    const value = new URLSearchParams(search).get("serverUrl")?.trim();
    if (!value) {
      return null;
    }
    const url = new URL(value);
    if (url.protocol !== "http:" && url.protocol !== "https:") {
      return null;
    }
    url.username = "";
    url.password = "";
    url.hash = "";
    return url.toString().replace(/\/+$/, "");
  } catch {
    return null;
  }
}

export function stripServerUrlSearchParamFromLocation(): void {
  if (typeof window === "undefined") {
    return;
  }
  let url: URL;
  try {
    url = new URL(window.location.href);
  } catch {
    return;
  }
  if (!url.searchParams.has("serverUrl")) {
    return;
  }
  url.searchParams.delete("serverUrl");
  const next =
    `${url.pathname}${url.searchParams.toString() ? `?${url.searchParams}` : ""}${url.hash}`;
  window.history.replaceState(window.history.state, "", next);
}

export type ResolveServerBaseUrlOptions = {
  /** Preserve the configured host for multi-server requests (no same-origin collapse). */
  explicitTarget?: boolean;
};

export function resolveClientServerBaseUrlForLocation(
  raw: string,
  locationSource:
    | {
        location: {
          protocol: string;
          hostname: string;
          host: string;
        };
      }
    | null,
  options?: ResolveServerBaseUrlOptions
): string {
  if (!locationSource) {
    return raw;
  }

  try {
    const configured = new URL(raw);
    const currentHost = locationSource.location.hostname;
    const isLocalHost =
      currentHost === "127.0.0.1" || currentHost === "localhost";
    const configuredIsLoopback =
      configured.hostname === "localhost" || configured.hostname === "127.0.0.1";

    if (
      !options?.explicitTarget &&
      locationSource.location.protocol === "https:" &&
      configured.protocol === "http:"
    ) {
      // Use same-origin so TLS covers the request. The reverse proxy is
      // responsible for routing `/api/*` and `/ws/*` to the API. For dev
      // (next-dev on HTTPS with an HTTP API) this still produces a relative
      // base URL, which matches the intent — avoid mixed content above all.
      return "";
    }

    if (
      !options?.explicitTarget &&
      currentHost &&
      isLocalHost &&
      (configured.hostname !== currentHost ||
        configured.protocol !== locationSource.location.protocol)
    ) {
      configured.protocol = locationSource.location.protocol;
      configured.hostname = currentHost;
      configured.port = configured.port || getConfiguredServerPort();
      return configured.toString().replace(/\/+$/, "");
    }

    if (
      options?.explicitTarget &&
      currentHost &&
      isLocalHost &&
      configuredIsLoopback &&
      configured.hostname !== currentHost
    ) {
      configured.hostname = currentHost;
      return configured.toString().replace(/\/+$/, "");
    }

    if (
      currentHost &&
      !isLocalHost &&
      configuredIsLoopback &&
      locationSource.location.protocol === "http:"
    ) {
      const next = new URL(raw);
      next.protocol = "http:";
      next.hostname = currentHost;
      next.port = getConfiguredServerPort();
      return next.toString().replace(/\/+$/, "");
    }
  } catch {
    return raw;
  }
  return raw;
}
