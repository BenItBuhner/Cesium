export type BrowserEngineKind = "proxy" | "electron-native" | "server-chromium";

export type BrowserNavigationState = {
  url: string | null;
  title?: string | null;
  faviconUrl?: string | null;
  canGoBack?: boolean;
  canGoForward?: boolean;
  isLoading?: boolean;
};

export type BrowserConsoleLevel = "log" | "info" | "warning" | "error" | "debug";

export type BrowserConsoleEntry = {
  id: string;
  ts: number;
  level: BrowserConsoleLevel;
  source: "console" | "exception" | "log" | "network" | "browser";
  text: string;
  url?: string;
  lineNumber?: number;
  columnNumber?: number;
};

export type BrowserNetworkEntry = {
  id: string;
  ts: number;
  url: string;
  method?: string;
  status?: number;
  statusText?: string;
  resourceType?: string;
};

export type BrowserEngineEvent =
  | ({ type: "navigation" } & BrowserNavigationState)
  | ({ type: "console"; entry: BrowserConsoleEntry })
  | ({ type: "network"; entry: BrowserNetworkEntry })
  | { type: "closed" }
  | { type: "error"; message: string };

export type BrowserViewportBounds = {
  x: number;
  y: number;
  width: number;
  height: number;
};

export type BrowserEngineSession = {
  id: string;
  kind: BrowserEngineKind;
};

export type BrowserEngineCapabilities = {
  nativeView: boolean;
  fullDevtools: boolean;
  realNetworkStack: boolean;
  customConsoleEvents: boolean;
};

export const REMOTE_BROWSER_POINTER_MOVE_THROTTLE_MS = 80;
export const REMOTE_BROWSER_HOVER_REFRESH_DELAY_MS = 90;
export const REMOTE_BROWSER_INPUT_REFRESH_DELAY_MS = 80;
export const REMOTE_BROWSER_NAVIGATION_REFRESH_DELAY_MS = 250;
export const REMOTE_BROWSER_EVENT_POLL_INTERVAL_MS = 1000;

export const BROWSER_ENGINE_CAPABILITIES: Record<
  BrowserEngineKind,
  BrowserEngineCapabilities
> = {
  proxy: {
    nativeView: false,
    fullDevtools: false,
    realNetworkStack: false,
    customConsoleEvents: false,
  },
  "electron-native": {
    nativeView: true,
    fullDevtools: true,
    realNetworkStack: true,
    customConsoleEvents: true,
  },
  "server-chromium": {
    nativeView: false,
    fullDevtools: true,
    realNetworkStack: true,
    customConsoleEvents: true,
  },
};

/**
 * Hosts served through GitHub Codespaces port forwarding / Microsoft dev
 * tunnels. Their ingress intercepts every `GET` document request (`Accept:
 * text/html`) with an anti-phishing interstitial ("You are about to access a
 * development port served by a codespace" → Continue → "Verifying session").
 * That verification never completes inside an embedded cross-origin iframe
 * (no GitHub cookies, partitioned third-party storage), so the in-app proxy
 * browser would hang on a black "Verifying session" page forever.
 *
 * Mirrored on the engine in `server/src/lib/tunnel-interstitial.ts`.
 */
export const TUNNEL_INTERSTITIAL_HOST_SUFFIXES = [
  ".app.github.dev",
  ".githubpreview.dev",
  ".devtunnels.ms",
] as const;

/**
 * Whether the engine base URL is reached through a tunnel that injects an
 * auth interstitial into document loads. Such engines must render the in-app
 * browser with the `server-chromium` engine (screenshot streaming over plain
 * API fetches, which the tunnel passes through untouched) instead of the
 * iframe proxy - and any residual iframe document loads must ride POST
 * navigations, which the tunnel also passes through.
 */
export function isTunnelInterstitialHost(baseUrl: string): boolean {
  if (!baseUrl) return false;
  let hostname: string;
  try {
    hostname = new URL(baseUrl).hostname.toLowerCase();
  } catch {
    return false;
  }
  return TUNNEL_INTERSTITIAL_HOST_SUFFIXES.some((suffix) =>
    hostname.endsWith(suffix)
  );
}

