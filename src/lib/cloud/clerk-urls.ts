import { DEFAULT_PRODUCTION_SITE_URL } from "@/lib/site-url";

export function getHostedClerkSignInUrl(): string {
  return resolveHostedClerkPageUrl(
    process.env.NEXT_PUBLIC_CLERK_SIGN_IN_URL,
    "/sign-in"
  );
}

export function getHostedClerkSignUpUrl(): string {
  return resolveHostedClerkPageUrl(
    process.env.NEXT_PUBLIC_CLERK_SIGN_UP_URL,
    "/sign-up"
  );
}

/**
 * In-app Clerk widgets only work on origins Clerk has allowlisted for the
 * publishable key (production web). Packaged file:// clients and localhost
 * must open the hosted account pages instead - otherwise sign-in never
 * appears and the first-run wall hangs on "Starting Cesium…".
 */
export function shouldUseHostedClerkAuth(
  location: { protocol: string; hostname: string } | null,
  clerkStatus: "disabled" | "signed-out" | "loading" | "ready"
): boolean {
  if (clerkStatus !== "signed-out") {
    return true;
  }
  if (!location) {
    return true;
  }
  if (location.protocol === "file:") {
    return true;
  }
  return location.hostname === "localhost" || location.hostname === "127.0.0.1";
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

function resolveClerkPageUrl(
  envValue: string | undefined,
  fallbackPath: "/sign-in" | "/sign-up"
): string {
  const explicit = envValue?.trim();
  if (explicit) {
    return explicit;
  }
  if (typeof window !== "undefined" && window.location.protocol === "file:") {
    return `${DEFAULT_PRODUCTION_SITE_URL}${fallbackPath}`;
  }
  return fallbackPath;
}
