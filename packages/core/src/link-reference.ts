/**
 * Shared token/serialization format for attached URL links in the composer.
 *
 * Flow:
 *   1. Paste / attach menu inserts a compact `⟦link:<id>⟧` token and stores
 *      metadata (`draft.linkReferences[id]`) with the URL plus a resolved
 *      page title + favicon.
 *   2. `ChatComposer` expands each token into markdown `[title](url)` on
 *      submit so the agent sees a plaintext, markdown-friendly link.
 *   3. `parseUserMessageSegments` re-detects those markdown links in
 *      historical user content and emits `link` segments for pill rendering.
 */

import type { UserMessageSegment } from "./types";

export type LinkReferenceStatus = "loading" | "ready" | "failed";

export interface LinkReference {
  id: string;
  url: string;
  /** Resolved `<title>` / og:title, or a hostname fallback while loading. */
  title: string;
  /** Absolute favicon URL when known (composer displays via browser proxy). */
  faviconUrl?: string;
  status?: LinkReferenceStatus;
}

const OPEN = "\u27E6";
const CLOSE = "\u27E7";

export function makeComposerLinkReferenceToken(linkId: string): string {
  return `${OPEN}link:${linkId}${CLOSE}`;
}

export const COMPOSER_LINK_REFERENCE_TOKEN_REGEX =
  /\u27E6link:([A-Za-z0-9_-]+)\u27E7/g;

export function findComposerLinkReferenceTokens(
  text: string
): Array<{ start: number; end: number; linkId: string }> {
  const out: Array<{ start: number; end: number; linkId: string }> = [];
  const re = new RegExp(COMPOSER_LINK_REFERENCE_TOKEN_REGEX.source, "g");
  let match: RegExpExecArray | null;
  while ((match = re.exec(text))) {
    out.push({
      start: match.index,
      end: match.index + match[0].length,
      linkId: match[1]!,
    });
  }
  return out;
}

/** Hostname (or full URL) used as the interim / fallback pill label. */
export function fallbackTitleFromUrl(url: string): string {
  try {
    const parsed = new URL(url);
    return parsed.hostname.replace(/^www\./i, "") || url;
  } catch {
    return url;
  }
}

/**
 * True when `plain` is a single http(s) URL (optionally wrapped in whitespace).
 * Used to auto-promote pasted links into composer pills.
 */
export function tryParsePastedLinkUrl(plain: string): string | null {
  const trimmed = plain.trim();
  if (!trimmed || /\s/.test(trimmed)) return null;
  // Strip wrapping angle brackets / quotes commonly copied from docs.
  const unwrapped = trimmed
    .replace(/^<|>$/g, "")
    .replace(/^['"]|['"]$/g, "")
    .trim();
  if (!/^https?:\/\//i.test(unwrapped)) return null;
  try {
    const parsed = new URL(unwrapped);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return null;
    if (!parsed.hostname) return null;
    return parsed.href;
  } catch {
    return null;
  }
}

/** Strip brackets that would break the markdown link label syntax. */
export function sanitizeLinkMarkdownLabel(label: string): string {
  return label.replace(/[\[\]]/g, "").trim() || "link";
}

/**
 * Build the markdown the agent sees. Example:
 * `[Samsung | Mobile | TV | Home](https://www.samsung.com/us/)`
 */
export function buildLinkMarkdown(link: LinkReference): string {
  const title = sanitizeLinkMarkdownLabel(link.title || fallbackTitleFromUrl(link.url));
  // Parentheses/spaces would terminate the markdown destination early.
  // encodeURIComponent leaves `()` alone, so encode those explicitly.
  const href = link.url.replace(/[()\s]/g, (ch) => {
    if (ch === "(") return "%28";
    if (ch === ")") return "%29";
    return encodeURIComponent(ch);
  });
  return `[${title}](${href})`;
}

/**
 * Markdown links written as `[label](https://...)`. Intentionally requires an
 * http(s) scheme so relative / mailto / fragment links stay as plain text.
 */
export const MARKDOWN_HTTP_LINK_REGEX =
  /\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)/g;

export function splitContentByMarkdownLinks(
  content: string
): UserMessageSegment[] | null {
  const re = new RegExp(MARKDOWN_HTTP_LINK_REGEX.source, "g");
  const out: UserMessageSegment[] = [];
  let lastIndex = 0;
  let saw = false;
  let match: RegExpExecArray | null;
  while ((match = re.exec(content))) {
    saw = true;
    const start = match.index;
    const end = start + match[0].length;
    if (start > lastIndex) {
      out.push({ type: "text", text: content.slice(lastIndex, start) });
    }
    const label = match[1] ?? "";
    const url = match[2] ?? "";
    out.push({
      type: "link",
      text: label || fallbackTitleFromUrl(url),
      linkUrl: url,
    });
    lastIndex = end;
  }
  if (!saw) return null;
  if (lastIndex < content.length) {
    out.push({ type: "text", text: content.slice(lastIndex) });
  }
  return out.filter((segment) => segment.type !== "text" || segment.text.length > 0);
}
