/** Match `buildBrowserProxyPath` in the client (`src/lib/browser-proxy-url.ts`). */

export function buildBrowserProxyPathFromHref(href: string): string {
  const u = new URL(href.trim());
  const scheme = u.protocol.replace(":", "");
  const hostport = u.host;
  const enc = encodeURIComponent(hostport);
  const path = u.pathname === "" ? "/" : u.pathname;
  const tail =
    path === "/" && !u.search && !u.hash
      ? ""
      : `${path}${u.search}${u.hash}`;
  return `/browser/${scheme}/${enc}${tail === "/" ? "" : tail}`;
}
