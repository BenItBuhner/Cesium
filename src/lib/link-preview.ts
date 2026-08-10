import { buildBrowserProxyUrl, normalizeBrowserTargetUrl } from "@/lib/browser-proxy-url";
import { resolveFaviconForPage } from "@/lib/browser-favicon";
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
  const og = extractMetaContent(html, "og:title");
  if (og) return og;
  const twitter = extractMetaContent(html, "twitter:title");
  if (twitter) return twitter;
  const titleMatch = /<title\b[^>]*>([\s\S]*?)<\/title>/i.exec(html);
  if (!titleMatch?.[1]) return null;
  const cleaned = collapseWhitespace(decodeBasicEntities(titleMatch[1]));
  return cleaned || null;
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

  try {
    const pageProxy = buildBrowserProxyUrl(serverBase, pageUrl.href);
    const response = await fetch(pageProxy, {
      signal: signal ?? AbortSignal.timeout(12_000),
      headers: { Accept: "text/html,application/xhtml+xml" },
    });
    if (response.ok) {
      const html = await response.text();
      title = extractDocumentTitle(html) ?? fallbackTitle;
    }
  } catch {
    // Keep hostname fallback; favicon resolution still worth trying.
  }

  let faviconUrl: string | null = null;
  try {
    faviconUrl = await resolveFaviconForPage(pageUrl.href, serverBase);
  } catch {
    faviconUrl = null;
  }

  return {
    url: pageUrl.href,
    title,
    faviconUrl,
  };
}
