/** Build `/browser/{scheme}/{encodedHostPort}{path}` matching the OpenCursor server proxy. */

export function normalizeBrowserTargetUrl(input: string): URL {
  const trimmed = input.trim();
  if (!trimmed) {
    throw new Error("URL is empty");
  }
  if (/^https?:\/\//i.test(trimmed)) {
    return new URL(trimmed);
  }
  return new URL(`http://${trimmed}`);
}

export function buildBrowserProxyPath(target: URL): string {
  const scheme = target.protocol.replace(":", "");
  const hostport = target.host;
  const enc = encodeURIComponent(hostport);
  const path = target.pathname === "" ? "/" : target.pathname;
  const tail =
    path === "/" && !target.search && !target.hash
      ? ""
      : `${path}${target.search}${target.hash}`;
  return `/browser/${scheme}/${enc}${tail === "/" ? "" : tail}`;
}

export function buildBrowserProxyUrl(serverBase: string, target: string | URL): string {
  const u = typeof target === "string" ? normalizeBrowserTargetUrl(target) : target;
  const base = serverBase.replace(/\/+$/, "");
  return `${base}${buildBrowserProxyPath(u)}`;
}
