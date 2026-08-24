/**
 * Canonical site origin for SEO metadata (robots, sitemap, metadataBase).
 *
 * Resolution order:
 * 1. `NEXT_PUBLIC_SITE_URL` — set this to the custom domain in production
 *    (e.g. https://cesium.example.com).
 * 2. `VERCEL_PROJECT_PRODUCTION_URL` — provided automatically by Vercel.
 * 3. localhost fallback for local development.
 */
export function getSiteUrl(): string {
  const explicit = process.env.NEXT_PUBLIC_SITE_URL?.trim();
  if (explicit) {
    return explicit.replace(/\/+$/, "");
  }
  const vercel = process.env.VERCEL_PROJECT_PRODUCTION_URL?.trim();
  if (vercel) {
    return `https://${vercel}`;
  }
  return "http://localhost:3000";
}
