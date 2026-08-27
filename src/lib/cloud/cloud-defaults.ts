/**
 * Committed production cloud defaults - the single place that makes every
 * packaged client (Vercel web, Electron on macOS/Windows/Linux, Android and
 * iOS mobile) default to production cloud behavior without any build-time
 * environment variables.
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
 *
 * Populate these once the production Convex deployment and Clerk application
 * exist (e.g. "https://<deployment>.convex.cloud" and "pk_live_..."). Empty
 * strings mean "no default" - clients without build env stay local-first.
 */
export const CESIUM_CLOUD_DEFAULTS = {
  convexUrl: "",
  clerkPublishableKey: "",
} as const;
