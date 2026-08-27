/**
 * Decide when a WebView URL must leave the bundled workbench and open in the
 * phone's default browser. OAuth / device-auth / Sign In flows call
 * `window.open(https://…)` - Android WebView with `setSupportMultipleWindows={false}`
 * swallows that, and a same-document navigation would unload the `file://`
 * workbench. Both look like the app "just dying".
 */

export function parseAbsoluteUrl(value: string, baseUrl?: string): URL | null {
  const trimmed = value.trim();
  if (!trimmed) {
    return null;
  }
  try {
    return baseUrl ? new URL(trimmed, baseUrl) : new URL(trimmed);
  } catch {
    return null;
  }
}

export function isMobileHttpUrl(url: URL): boolean {
  return url.protocol === "http:" || url.protocol === "https:";
}

/**
 * Absolute http(s) URL suitable for `Linking.openURL` / ACTION_VIEW.
 * Relative or non-http schemes return null so we never hand `file:` or
 * `javascript:` to the system browser.
 */
export function mobileExternalHttpUrl(url: string, baseUrl?: string): string | null {
  const parsed = parseAbsoluteUrl(url, baseUrl);
  if (!parsed || !isMobileHttpUrl(parsed)) {
    return null;
  }
  return parsed.href;
}

/**
 * True when `requestUrl` is an http(s) document that is not the workbench
 * itself - a packaged `file://` shell treats every http(s) URL as foreign;
 * a hosted (dev) shell only treats a different origin as foreign.
 */
export function isMobileExternalHttpUrl(requestUrl: string, documentUrl: string): boolean {
  const request = parseAbsoluteUrl(requestUrl, documentUrl);
  const document = parseAbsoluteUrl(documentUrl);
  if (!request || !document || !isMobileHttpUrl(request)) {
    return false;
  }
  if (isWorkbenchDocumentUrl(request, document)) {
    return false;
  }
  if (document.protocol === "file:" || document.protocol === "about:") {
    return true;
  }
  return request.origin !== document.origin;
}

export function isWorkbenchDocumentUrl(request: URL, document: URL): boolean {
  return (
    request.protocol === document.protocol &&
    request.host === document.host &&
    stripTrailingSlash(request.pathname) === stripTrailingSlash(document.pathname)
  );
}

/**
 * Main-frame navigations to a foreign http(s) URL must be cancelled and opened
 * outside the WebView. Subframes (in-app browser proxy iframes, extension
 * surfaces) stay inside the workbench.
 */
export function shouldOpenMobileNavigationExternally(
  requestUrl: string,
  options: {
    documentUrl: string;
    isTopFrame?: boolean;
  }
): boolean {
  if (options.isTopFrame === false) {
    return false;
  }
  return isMobileExternalHttpUrl(requestUrl, options.documentUrl);
}

function stripTrailingSlash(pathname: string): string {
  if (pathname.length > 1 && pathname.endsWith("/")) {
    return pathname.slice(0, -1);
  }
  return pathname;
}
