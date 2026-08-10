"use client";

import { useState } from "react";
import { Link2 } from "lucide-react";
import { buildBrowserProxyUrl } from "@/lib/browser-proxy-url";
import { getServerBaseUrl } from "@/lib/server-api";

type LinkAttachmentPillProps = {
  title: string;
  url: string;
  faviconUrl?: string | null;
  /** Composer faux-caret selection ring. */
  selected?: boolean;
  className?: string;
  titleAttr?: string;
  "data-faux-offset-start"?: number;
  "data-faux-offset-end"?: number;
  "data-link-reference-id"?: string;
};

/**
 * Shared favicon + title chip for attached links in the composer and user bubbles.
 */
export function LinkAttachmentPill({
  title,
  url,
  faviconUrl,
  selected = false,
  className,
  titleAttr,
  ...dataAttrs
}: LinkAttachmentPillProps) {
  const [faviconFailed, setFaviconFailed] = useState(false);
  const faviconSrc =
    faviconUrl && !faviconFailed
      ? buildBrowserProxyUrl(getServerBaseUrl(), faviconUrl)
      : null;

  return (
    <span
      {...dataAttrs}
      title={titleAttr ?? `${title}\n${url}`}
      data-link-url={url}
      className={
        className ??
        `mx-[2px] inline-flex max-w-full items-center gap-[5px] rounded-[6px] border border-[var(--border-subtle)] bg-[var(--file-tag-bg)] px-[7px] py-[2px] align-baseline font-sans text-[13px] font-medium text-[var(--file-tag-text)] ${
          selected ? "ring-2 ring-[var(--accent)]" : ""
        }`
      }
    >
      {faviconSrc ? (
        // eslint-disable-next-line @next/next/no-img-element -- proxied remote favicon
        <img
          src={faviconSrc}
          alt=""
          draggable={false}
          className="size-[12px] shrink-0 rounded-[2px] object-contain"
          onError={() => setFaviconFailed(true)}
        />
      ) : (
        <Link2
          className="size-[12px] shrink-0 text-[var(--file-tag-icon)]"
          strokeWidth={1.75}
          aria-hidden
        />
      )}
      <span className="max-w-[260px] truncate">{title || "link"}</span>
    </span>
  );
}

/** Best-effort favicon guess from a page URL when history only has markdown. */
export function guessFaviconUrlFromPageUrl(pageUrl: string): string | null {
  try {
    const host = new URL(pageUrl).hostname;
    // Many sites 404 `/favicon.ico`; Google's icon service is a reliable fallback
    // for historical bubbles that only store markdown `[title](url)`.
    return `https://www.google.com/s2/favicons?domain=${encodeURIComponent(host)}&sz=64`;
  } catch {
    return null;
  }
}
