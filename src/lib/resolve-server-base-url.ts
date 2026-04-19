/**
 * Build-time API base (`NEXT_PUBLIC_*` is inlined when `next build` runs).
 */
export function getConfiguredServerBaseUrl(): string {
  return (
    process.env.NEXT_PUBLIC_SERVER_URL?.replace(/\/+$/, "") ??
    "http://localhost:9100"
  );
}

/**
 * URL the browser should use for HTTP and WebSocket calls to the OpenCursor API.
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
 *   3. LAN plain-HTTP: if the bundle still says `http://localhost:9100` but
 *      the UI is opened as `http://192.168.x.x:3000`, rewrite to the same
 *      host as the page on port 9100.
 *   4. Otherwise: return the configured URL untouched.
 */
export function resolveClientServerBaseUrl(): string {
  const raw = getConfiguredServerBaseUrl();

  if (typeof window === "undefined") {
    return raw;
  }

  try {
    const configured = new URL(raw);
    const currentHost = window.location.hostname;
    const isLocalHost =
      currentHost === "127.0.0.1" || currentHost === "localhost";

    if (
      window.location.protocol === "https:" &&
      configured.protocol === "http:"
    ) {
      // Use same-origin so TLS covers the request. The reverse proxy is
      // responsible for routing `/api/*` and `/ws/*` to the API. For dev
      // (next-dev on HTTPS with an HTTP API) this still produces a relative
      // base URL, which matches the intent — avoid mixed content above all.
      return "";
    }

    if (
      currentHost &&
      isLocalHost &&
      (configured.hostname !== currentHost ||
        configured.protocol !== window.location.protocol)
    ) {
      configured.protocol = window.location.protocol;
      configured.hostname = currentHost;
      configured.port = configured.port || "9100";
      return configured.toString().replace(/\/+$/, "");
    }

    const configuredIsLoopback =
      configured.hostname === "localhost" ||
      configured.hostname === "127.0.0.1";

    if (
      currentHost &&
      !isLocalHost &&
      configuredIsLoopback &&
      window.location.protocol === "http:"
    ) {
      const next = new URL(raw);
      next.protocol = "http:";
      next.hostname = currentHost;
      next.port = "9100";
      return next.toString().replace(/\/+$/, "");
    }
  } catch {
    return raw;
  }
  return raw;
}
