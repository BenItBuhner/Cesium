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
 * - Dev on localhost: keep cookie origins aligned with the page (http vs https, 127.0.0.1 vs localhost).
 * - LAN / tailnet: if the bundle still says `http://localhost:9100` but the UI is opened as
 *   `http://192.168.x.x:3000`, calling `localhost` from the browser hits the **client machine** and
 *   the app hangs on “Loading workspace…”. Rewrite to the same host as the page on **plain HTTP**
 *   only (HTTPS + HTTP API would be mixed content; use an explicit `NEXT_PUBLIC_SERVER_URL` or a
 *   same-origin reverse proxy in that case).
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
