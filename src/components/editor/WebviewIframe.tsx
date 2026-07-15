"use client";

import type { RefObject } from "react";

export const DEFAULT_WEBVIEW_HTML = `<!doctype html>
<html>
  <head><meta charset="utf-8" /></head>
  <body><main><p>Extension webview session is ready.</p></main></body>
</html>`;

export function WebviewIframe({
  iframeRef,
  title,
  frameDoc,
}: {
  iframeRef: RefObject<HTMLIFrameElement | null>;
  title: string;
  frameDoc: string;
}) {
  return (
    <iframe
      ref={iframeRef}
      title={title}
      className="h-full w-full border-0 bg-[var(--bg-main)]"
      sandbox="allow-scripts allow-same-origin allow-forms allow-popups-by-user-activation"
      referrerPolicy="no-referrer"
      srcDoc={frameDoc || DEFAULT_WEBVIEW_HTML}
    />
  );
}
