/**
 * Cesium Cloud master switches - pure env parsing, safe to import anywhere
 * (client bundles, the Next proxy boundary, and node test runners alike).
 *
 * Deployment postures, from one knob:
 *
 * - Production cloud (the default): committed Convex + Clerk values in
 *   `cloud-defaults.ts`, unless build env overrides them. First install
 *   prompts for sign-in / sign-up; guest remains available.
 * - Local-only: force it with `NEXT_PUBLIC_CESIUM_CLOUD=0` even when Convex
 *   / Clerk vars are present. No cloud code paths execute; the optional
 *   engine password login (`OPENCURSOR_AUTH_*`) remains the only "account".
 * - Device sync: `NEXT_PUBLIC_CONVEX_URL` only (and no Clerk key). Keyless
 *   per-browser identity against a deployment that opted in with
 *   `CESIUM_ALLOW_DEVICE_KEYS=1`.
 * - Gated public deployments: add `NEXT_PUBLIC_CESIUM_REQUIRE_SIGN_IN=1` to
 *   require Clerk for every non-public route.
 *
 * Every env var is referenced literally so Next.js can inline it into
 * client bundles at build time.
 */

import { CESIUM_CLOUD_DEFAULTS } from "./cloud-defaults";

export type CloudMode = "disabled" | "device" | "clerk";

const OFF_VALUES = new Set(["0", "off", "false", "disabled", "no"]);
const ON_VALUES = new Set(["1", "on", "true", "yes", "required"]);

/**
 * Master switch. Unset (or any "on" value) means "derive the mode from which
 * cloud vars exist"; an explicit off value disables the cloud layer entirely
 * regardless of other configuration.
 */
export function isCloudExplicitlyDisabled(): boolean {
  const raw = process.env.NEXT_PUBLIC_CESIUM_CLOUD?.trim().toLowerCase();
  return raw !== undefined && raw !== "" && OFF_VALUES.has(raw);
}

export function getConvexUrl(): string | null {
  if (isCloudExplicitlyDisabled()) {
    return null;
  }
  const url =
    process.env.NEXT_PUBLIC_CONVEX_URL?.trim() ||
    CESIUM_CLOUD_DEFAULTS.convexUrl.trim();
  return url ? url : null;
}

export function getClerkPublishableKey(): string | null {
  if (isCloudExplicitlyDisabled()) {
    return null;
  }
  const raw = process.env.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY;
  if (raw !== undefined && raw !== "") {
    const trimmed = raw.trim();
    if (OFF_VALUES.has(trimmed.toLowerCase())) {
      return null;
    }
    return trimmed;
  }
  const key = CESIUM_CLOUD_DEFAULTS.clerkPublishableKey.trim();
  return key ? key : null;
}

export function getCloudMode(): CloudMode {
  if (!getConvexUrl()) {
    return "disabled";
  }
  return getClerkPublishableKey() ? "clerk" : "device";
}

/**
 * Public-deployment gate: when true (and Clerk is active), the network
 * boundary redirects every signed-out request to Clerk sign-in, so only
 * authenticated users can reach the client at all.
 */
export function isSignInRequired(): boolean {
  if (getCloudMode() !== "clerk") {
    return false;
  }
  const raw = process.env.NEXT_PUBLIC_CESIUM_REQUIRE_SIGN_IN?.trim().toLowerCase();
  return raw !== undefined && ON_VALUES.has(raw);
}
