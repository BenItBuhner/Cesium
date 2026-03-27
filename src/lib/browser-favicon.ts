import { buildBrowserProxyUrl, normalizeBrowserTargetUrl } from "@/lib/browser-proxy-url";

function isLikelyImageResponse(contentType: string, url: string): boolean {
  const ct = contentType.toLowerCase();
  if (ct.includes("image/")) return true;
  if (ct.includes("octet-stream") && /\.ico$/i.test(url)) return true;
  return false;
}

function parseLinkIconsFromHtml(html: string, base: URL): string[] {
  const out: string[] = [];
  const linkTagRe = /<link\b[^>]*>/gi;
  let m: RegExpExecArray | null;
  while ((m = linkTagRe.exec(html)) !== null) {
    const tag = m[0];
    if (!/\brel\s*=\s*["'][^"']*icon[^"']*["']/i.test(tag)) continue;
    const hrefM = /\bhref\s*=\s*["']([^"']+)["']/i.exec(tag);
    if (!hrefM?.[1]) continue;
    try {
      out.push(new URL(hrefM[1].trim(), base.href).href);
    } catch {
      /* skip */
    }
  }
  return out;
}

/**
 * Resolve an absolute favicon URL for a page. Uses the proxy base URL so fetches
 * succeed in the browser (same-origin to the API server CORS).
 */
export async function resolveFaviconForPage(
  pageUrlStr: string,
  serverBase: string
): Promise<string | null> {
  let pageUrl: URL;
  try {
    pageUrl = normalizeBrowserTargetUrl(pageUrlStr);
  } catch {
    return null;
  }

  const origin = pageUrl.origin;
  const simpleCandidates = [
    new URL("/favicon.ico", origin).href,
    new URL("/favicon.png", origin).href,
    new URL("/apple-touch-icon.png", origin).href,
  ];

  for (const abs of simpleCandidates) {
    const proxy = buildBrowserProxyUrl(serverBase, abs);
    try {
      const r = await fetch(proxy, {
        method: "GET",
        signal: AbortSignal.timeout(8000),
      });
      if (!r.ok) continue;
      const ct = r.headers.get("content-type") ?? "";
      if (isLikelyImageResponse(ct, abs)) {
        return abs;
      }
    } catch {
      /* try next */
    }
  }

  try {
    const pageProxy = buildBrowserProxyUrl(serverBase, pageUrl.href);
    const r = await fetch(pageProxy, { signal: AbortSignal.timeout(12_000) });
    if (!r.ok) return null;
    const html = await r.text();
    const fromLinks = parseLinkIconsFromHtml(html, pageUrl);
    for (const href of fromLinks) {
      const proxy = buildBrowserProxyUrl(serverBase, href);
      try {
        const fr = await fetch(proxy, {
          method: "GET",
          signal: AbortSignal.timeout(8000),
        });
        if (!fr.ok) continue;
        const ct = fr.headers.get("content-type") ?? "";
        if (isLikelyImageResponse(ct, href)) return href;
      } catch {
        /* continue */
      }
    }
  } catch {
    /* ignore */
  }

  return null;
}
