import { DEFAULT_PRODUCTION_SITE_URL } from "@/lib/site-url";

/**
 * Clerk hosted-page URLs for this client.
 *
 * Path-relative `/sign-in` works on the Next app. Packaged file:// renderers
 * (Electron, Android, iOS) have no such route — pointing Clerk at the
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
