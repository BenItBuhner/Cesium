import { clientLocation } from "./platform";

/** Parse a URL without throwing — useful for Electron `file://` history edge cases. */
export function tryParseUrl(input: string, base?: string): URL | null {
  try {
    return base === undefined ? new URL(input) : new URL(input, base);
  } catch {
    return null;
  }
}

export function safeWindowLocationUrl(): URL | null {
  const location = clientLocation();
  if (!location) {
    return null;
  }
  return tryParseUrl(location.href);
}

export function safeReadLocationSearchParam(name: string): string | null {
  const url = safeWindowLocationUrl();
  if (!url) {
    return null;
  }
  const value = url.searchParams.get(name)?.trim();
  return value || null;
}

export function safeReplaceLocationSearchParams(
  mutate: (params: URLSearchParams) => void
): boolean {
  const url = safeWindowLocationUrl();
  if (!url) {
    return false;
  }
  mutate(url.searchParams);
  const nextUrl = `${url.pathname}${url.search}${url.hash}`;
  const currentUrl = `${window.location.pathname}${window.location.search}${window.location.hash}`;
  if (nextUrl !== currentUrl) {
    window.history.replaceState(null, "", nextUrl);
  }
  return true;
}
