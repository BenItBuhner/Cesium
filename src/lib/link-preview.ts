import {
  buildBrowserProxyUrl,
  decodeBrowserProxyHref,
  normalizeBrowserTargetUrl,
} from "@/lib/browser-proxy-url";
import { isLikelyImageResponse } from "@/lib/browser-favicon";
import { fallbackTitleFromUrl } from "@/lib/link-reference";

function decodeBasicEntities(value: string): string {
  return value
    .replace(/&amp;/gi, "&")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/&apos;/gi, "'")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&#(\d+);/g, (_, code: string) => {
      const n = Number.parseInt(code, 10);
      return Number.isFinite(n) ? String.fromCodePoint(n) : _;
    })
    .replace(/&#x([0-9a-f]+);/gi, (_, hex: string) => {
      const n = Number.parseInt(hex, 16);
      return Number.isFinite(n) ? String.fromCodePoint(n) : _;
    });
}

function collapseWhitespace(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

function extractMetaContent(html: string, propertyOrName: string): string | null {
  const attr = propertyOrName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const re = new RegExp(
    `<meta\\b[^>]*(?:property|name)\\s*=\\s*["']${attr}["'][^>]*>`,
    "i"
  );
  const tag = re.exec(html)?.[0];
  if (!tag) return null;
  const content = /\bcontent\s*=\s*["']([^"']*)["']/i.exec(tag)?.[1];
  if (!content) return null;
  const cleaned = collapseWhitespace(decodeBasicEntities(content));
  return cleaned || null;
}

function extractDocumentTitle(html: string): string | null {
  // Prefer the document `<title>` - "header title" - over social meta tags.
  const titleMatch = /<title\b[^>]*>([\s\S]*?)<\/title>/i.exec(html);
  if (titleMatch?.[1]) {
    const cleaned = collapseWhitespace(decodeBasicEntities(titleMatch[1]));
    if (cleaned) return cleaned;
  }
  const og = extractMetaContent(html, "og:title");
  if (og) return og;
  const twitter = extractMetaContent(html, "twitter:title");
  if (twitter) return twitter;
  return null;
}

function parseFaviconCandidates(html: string, pageUrl: URL, serverBase: string): string[] {
  const out: string[] = [];
  const linkTagRe = /<link\b[^>]*>/gi;
  let match: RegExpExecArray | null;
  while ((match = linkTagRe.exec(html)) !== null) {
    const tag = match[0];
    if (!/\brel\s*=\s*["'][^"']*icon[^"']*["']/i.test(tag)) continue;
    const hrefMatch = /\bhref\s*=\s*["']([^"']+)["']/i.exec(tag);
    if (!hrefMatch?.[1]) continue;
    const raw = hrefMatch[1].trim();
    // Proxied HTML may already rewrite icon hrefs to `/browser/https/...`.
    const decoded = decodeBrowserProxyHref(raw, serverBase);
    try {
      const absolute = new URL(decoded, pageUrl.href).href;
      // Decode again in case resolving against pageUrl reintroduced a proxy path.
      out.push(decodeBrowserProxyHref(absolute, serverBase));
    } catch {
      /* skip */
    }
  }
  return out;
}

async function firstWorkingImageUrl(
  candidates: string[],
  serverBase: string,
  signal?: AbortSignal
): Promise<string | null> {
  for (const abs of candidates) {
    const proxy = buildBrowserProxyUrl(serverBase, abs);
    try {
      const response = await fetch(proxy, {
        method: "GET",
        signal: signal ?? AbortSignal.timeout(8000),
      });
      if (!response.ok) continue;
      const contentType = response.headers.get("content-type") ?? "";
      if (isLikelyImageResponse(contentType, abs)) return abs;
    } catch {
      /* try next */
    }
  }
  return null;
}

export type LinkPreviewResult = {
  url: string;
  title: string;
  faviconUrl: string | null;
};

/**
 * Resolve a page's display title + favicon for a composer link pill.
 * Fetches HTML through the browser proxy (same-origin) so CORS is not an issue.
 */
export async function resolveLinkPreview(
  pageUrlStr: string,
  serverBase: string,
  signal?: AbortSignal
): Promise<LinkPreviewResult> {
  let pageUrl: URL;
  try {
    pageUrl = normalizeBrowserTargetUrl(pageUrlStr);
  } catch {
    return {
      url: pageUrlStr,
      title: fallbackTitleFromUrl(pageUrlStr),
      faviconUrl: null,
    };
  }

  const fallbackTitle = fallbackTitleFromUrl(pageUrl.href);
  let title = fallbackTitle;
  let html: string | null = null;

  try {
    const pageProxy = buildBrowserProxyUrl(serverBase, pageUrl.href);
    const response = await fetch(pageProxy, {
      signal: signal ?? AbortSignal.timeout(12_000),
      headers: { Accept: "text/html,application/xhtml+xml" },
    });
    if (response.ok) {
      html = await response.text();
      title = extractDocumentTitle(html) ?? fallbackTitle;
    }
  } catch {
    // Keep hostname fallback; still try origin favicon candidates below.
  }

  const candidates: string[] = [];
  if (html) {
    candidates.push(...parseFaviconCandidates(html, pageUrl, serverBase));
  }
  candidates.push(
    new URL("/favicon.ico", pageUrl.origin).href,
    new URL("/favicon.png", pageUrl.origin).href,
    new URL("/apple-touch-icon.png", pageUrl.origin).href
  );

  const faviconUrl = await firstWorkingImageUrl(candidates, serverBase, signal);

  return {
    url: pageUrl.href,
    title,
    faviconUrl,
  };
}
