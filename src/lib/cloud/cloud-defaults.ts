/**
 * Committed production cloud defaults. cloud-flags.ts only consumes these in
 * a real production deployment or a packaged file:// client; local dev,
 * previews, CI and agent builds stay local-only unless explicitly configured.
 *
 * Both values are public-safe by design: the Convex deployment URL and the
 * Clerk *publishable* key ship in client bundles on every platform. Secrets
 * (CLERK_SECRET_KEY, Convex deploy keys) never belong here.
 *
 * Resolution order (see cloud-flags.ts):
 * 1. `NEXT_PUBLIC_CESIUM_CLOUD=0` build env - kill switch, forces local-only.
 * 2. `NEXT_PUBLIC_CONVEX_URL` / `NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY` build env
 *    - per-deployment overrides (used by Vercel previews, CI, self-hosters).
 * 3. These committed defaults - what shipped apps use out of the box.
 *
 * Users can still flip any client to local-only at runtime from
 * Settings → Account → Cloud sync (see cloud-env.ts).
 */
export const CESIUM_CLOUD_DEFAULTS = {
  convexUrl: "https://insightful-wolverine-140.convex.cloud",
  rendezvousHttpUrl: "https://insightful-wolverine-140.convex.site",
  clerkPublishableKey: "pk_live_Y2xlcmsuY2VzaXVtLnRlY2hsaXRub3cuY29tJA",
} as const;
