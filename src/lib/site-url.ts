/**
 * Canonical site origin for SEO metadata (robots, sitemap, metadataBase).
 *
 * Resolution order:
 * 1. `NEXT_PUBLIC_SITE_URL` - set this to the custom domain in production
 *    (e.g. https://cesium.techlitnow.com).
 * 2. `VERCEL_PROJECT_PRODUCTION_URL` - provided automatically by Vercel.
 * 3. The committed production origin when building for production.
 * 4. localhost fallback for local development.
 */
export const DEFAULT_PRODUCTION_SITE_URL = "https://cesium.techlitnow.com";

export function getSiteUrl(): string {
  const explicit = process.env.NEXT_PUBLIC_SITE_URL?.trim();
  if (explicit) {
    return explicit.replace(/\/+$/, "");
  }
  const vercel = process.env.VERCEL_PROJECT_PRODUCTION_URL?.trim();
  // Prefer the custom domain over the default *.vercel.app production host.
  if (vercel && !vercel.endsWith(".vercel.app")) {
    return `https://${vercel}`;
  }
  if (process.env.VERCEL || process.env.NODE_ENV === "production") {
    return DEFAULT_PRODUCTION_SITE_URL;
  }
  if (vercel) {
    return `https://${vercel}`;
  }
  return "http://localhost:3000";
}
