import { isCesiumAccountSiteHostname } from "@cesium/client";
import {
  WEB_CLERK_REDIRECT_PATH,
  withNativeClerkHandoffQuery,
} from "@/lib/cloud/clerk-native-handoff";
import { DEFAULT_PRODUCTION_SITE_URL } from "@/lib/site-url";

export type ClerkAuthLocation = {
  protocol: string;
  hostname: string;
};

export type ClerkAuthRuntime = {
  /** Electron, React Native WebView, or another packaged shell. */
  packaged?: boolean;
};

export type ClerkAuthStatus = "disabled" | "signed-out" | "loading" | "ready";

type ClerkRuntimeWindow = {
  location?: { protocol?: string };
  document?: {
    documentElement?: { classList?: { contains: (name: string) => boolean } | null } | null;
  };
  cesiumMobile?: { isReactNative?: boolean };
  cesiumDesktop?: { isElectron?: boolean };
  ReactNativeWebView?: unknown;
  __CESIUM_MOBILE_SERVER__?: unknown;
};

const LOOPBACK_AND_EMULATOR_HOSTS = new Set([
  "localhost",
  "127.0.0.1",
  "0.0.0.0",
  "::1",
  // Android emulator → host machine.
  "10.0.2.2",
  // Genymotion emulator → host machine.
  "10.0.3.2",
]);

export function getHostedClerkSignInUrl(): string {
  return withNativeClerkHandoffQuery(
    resolveHostedClerkPageUrl(
      process.env.NEXT_PUBLIC_CLERK_SIGN_IN_URL,
      "/sign-in"
    )
  );
}

export function getHostedClerkSignUpUrl(): string {
  return withNativeClerkHandoffQuery(
    resolveHostedClerkPageUrl(
      process.env.NEXT_PUBLIC_CLERK_SIGN_UP_URL,
      "/sign-up"
    )
  );
}

export function readClerkAuthLocation(
  win: { location?: { protocol?: string; hostname?: string } } | null | undefined =
    typeof window === "undefined" ? null : window
): ClerkAuthLocation | null {
  const protocol = win?.location?.protocol;
  const hostname = win?.location?.hostname;
  if (!protocol || hostname == null) {
    return null;
  }
  return { protocol, hostname };
}

/**
 * Packaged workbenches (Android/iOS WebView, Electron) must never use the
 * in-app Clerk modal. Their document origin is `file://`, an emulator host,
 * or a WebView asset-loader https origin - Clerk rejects those redirect
 * schemes ("The provided redirect url has a prohibited URL scheme").
 */
export function isPackagedClerkRuntime(win?: ClerkRuntimeWindow | null): boolean {
  const target =
    win ?? (typeof window === "undefined" ? null : (window as ClerkRuntimeWindow));
  if (!target) {
    return false;
  }
  return (
    target.cesiumMobile?.isReactNative === true ||
    Boolean(target.ReactNativeWebView) ||
    target.cesiumDesktop?.isElectron === true ||
    target.__CESIUM_MOBILE_SERVER__ != null ||
    target.document?.documentElement?.classList?.contains("opencursor-mobile-native") ===
      true ||
    target.location?.protocol === "file:"
  );
}

export function isLoopbackOrEmulatorHostname(hostname: string): boolean {
  const host = hostname.trim().toLowerCase().replace(/^\[|\]$/g, "");
  return LOOPBACK_AND_EMULATOR_HOSTS.has(host);
}

/**
 * In-app Clerk `<SignIn />` / modal widgets are only valid on the production
 * account site. Every other origin (file://, emulator, LAN, packaged shells)
 * must open the hosted pages and return via the native ticket handoff.
 */
export function isClerkWidgetOrigin(location: ClerkAuthLocation): boolean {
  if (location.protocol !== "http:" && location.protocol !== "https:") {
    return false;
  }
  return isCesiumAccountSiteHostname(location.hostname);
}

/**
 * In-app Clerk widgets only work on origins Clerk has allowlisted for the
 * publishable key (production web). Packaged clients, emulator hosts, and
 * localhost must open the hosted account pages instead - otherwise Settings
 * → Account sign-in mounts a modal that dies on a `file://` / custom-scheme
 * redirect, and the first-run wall hangs on "Starting Cesium…".
 */
export function shouldUseHostedClerkAuth(
  location: ClerkAuthLocation | null,
  clerkStatus: ClerkAuthStatus,
  runtime: ClerkAuthRuntime = {}
): boolean {
  if (clerkStatus !== "signed-out") {
    return true;
  }
  if (runtime.packaged) {
    return true;
  }
  if (!location) {
    return true;
  }
  if (location.protocol === "file:" || location.protocol === "about:") {
    return true;
  }
  if (isLoopbackOrEmulatorHostname(location.hostname)) {
    return true;
  }
  return !isClerkWidgetOrigin(location);
}

/**
 * ClerkProvider fallback after a completed sign-in. Relative `/setup` becomes
 * `file:///setup` (or another banned scheme) inside packaged WebViews - Clerk
 * then errors with "prohibited URL scheme". Always hand it a real https URL
 * off the production site unless we are already on that site.
 */
export function getClerkFallbackRedirectUrl(
  location?: ClerkAuthLocation | null,
  runtime?: ClerkAuthRuntime
): string {
  // Next.js SSR of the production site has no window. Stay path-relative so
  // ClerkProvider markup matches the hydrated account-site render.
  if (typeof window === "undefined" && location === undefined) {
    return WEB_CLERK_REDIRECT_PATH;
  }
  const resolvedLocation =
    location === undefined ? readClerkAuthLocation() : location;
  const resolvedRuntime = runtime ?? { packaged: isPackagedClerkRuntime() };
  if (shouldUseHostedClerkAuth(resolvedLocation, "signed-out", resolvedRuntime)) {
    return `${DEFAULT_PRODUCTION_SITE_URL}${WEB_CLERK_REDIRECT_PATH}`;
  }
  return WEB_CLERK_REDIRECT_PATH;
}

function resolveHostedClerkPageUrl(
  envValue: string | undefined,
  fallbackPath: "/sign-in" | "/sign-up"
): string {
  const explicit = envValue?.trim();
  if (explicit && /^https?:\/\//i.test(explicit)) {
    return explicit;
  }
  return `${DEFAULT_PRODUCTION_SITE_URL}${fallbackPath}`;
}

/**
 * Clerk hosted-page URLs for this client.
 *
 * Path-relative `/sign-in` works on the Next app. Packaged file:// renderers
 * (Electron, Android, iOS) have no such route - pointing Clerk at the
 * production site keeps OAuth / fallback redirects on a real origin instead
 * of `file:///sign-in`.
 */
export function getClerkSignInUrl(): string {
  return resolveClerkPageUrl(
    process.env.NEXT_PUBLIC_CLERK_SIGN_IN_URL,
    "/sign-in"
  );
}

export function getClerkSignUpUrl(): string {
  return resolveClerkPageUrl(
    process.env.NEXT_PUBLIC_CLERK_SIGN_UP_URL,
    "/sign-up"
  );
}

function needsAbsoluteClerkPageUrl(): boolean {
  if (typeof window === "undefined") {
    return false;
  }
  return shouldUseHostedClerkAuth(readClerkAuthLocation(), "signed-out", {
    packaged: isPackagedClerkRuntime(),
  });
}

function resolveClerkPageUrl(
  envValue: string | undefined,
  fallbackPath: "/sign-in" | "/sign-up"
): string {
  const explicit = envValue?.trim();
  if (explicit && /^https?:\/\//i.test(explicit)) {
    return explicit;
  }
  if (needsAbsoluteClerkPageUrl()) {
    if (explicit?.startsWith("/")) {
      return `${DEFAULT_PRODUCTION_SITE_URL}${explicit}`;
    }
    return `${DEFAULT_PRODUCTION_SITE_URL}${fallbackPath}`;
  }
  return explicit || fallbackPath;
}
