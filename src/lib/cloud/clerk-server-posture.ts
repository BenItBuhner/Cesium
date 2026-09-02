/**
 * Server-side Clerk readiness.
 *
 * `cloud-flags.ts` answers "is Clerk on for the client bundle?" from
 * build-time `NEXT_PUBLIC_*` env plus the committed defaults - the browser
 * only needs the publishable key. The proxy needs a stricter answer:
 * `clerkMiddleware()` asserts BOTH a publishable key and `CLERK_SECRET_KEY`
 * on every request, and the secret only exists at runtime on the server.
 * Deriving "install the middleware" from the committed publishable key alone
 * made every workbench route 500 (`@clerk/nextjs: Missing publishableKey` /
 * `Missing secretKey`) on a self-hosted `next start` that never configured
 * Clerk - the README's own "run production locally" flow.
 *
 * Pure functions; `process.env` is read on every call so tests can drive the
 * matrix, and `NEXT_PUBLIC_*` reads stay inside `cloud-flags.ts` where Next
 * can inline them.
 */

import { getClerkPublishableKey, isSignInRequired } from "./cloud-flags";

export type ClerkServerPosture =
  /** Cloud disabled or device mode - Clerk is not configured anywhere. */
  | { kind: "off" }
  /** Both keys present: `clerkMiddleware()` can verify sessions. */
  | { kind: "ready"; publishableKey: string; secretKey: string }
  /**
   * The browser bundle has a publishable key (committed default or env) but
   * the server has no secret, so sessions cannot be verified server-side.
   */
  | { kind: "client-only"; publishableKey: string; signInRequired: boolean };

export type ClerkProxyBehavior =
  /** Run `clerkMiddleware()` with the resolved keys. */
  | "clerk"
  /** No server-side Clerk; every request passes straight through. */
  | "passthrough"
  /**
   * Sign-in gating was requested but cannot be enforced. Serve only the
   * public routes and answer everything else with a 503 that names the
   * missing variable - never silently open a deployment that asked to be gated.
   */
  | "fail-closed";

export function getClerkSecretKey(): string | null {
  const raw = process.env.CLERK_SECRET_KEY?.trim();
  return raw ? raw : null;
}

export function resolveClerkServerPosture(): ClerkServerPosture {
  const publishableKey = getClerkPublishableKey();
  if (!publishableKey) {
    return { kind: "off" };
  }
  const secretKey = getClerkSecretKey();
  if (secretKey) {
    return { kind: "ready", publishableKey, secretKey };
  }
  return { kind: "client-only", publishableKey, signInRequired: isSignInRequired() };
}

export function selectClerkProxyBehavior(posture: ClerkServerPosture): ClerkProxyBehavior {
  switch (posture.kind) {
    case "ready":
      return "clerk";
    case "client-only":
      return posture.signInRequired ? "fail-closed" : "passthrough";
    case "off":
      return "passthrough";
  }
}

export const CLERK_CLIENT_ONLY_WARNING =
  "[cesium] Clerk is enabled for the browser (publishable key resolved) but CLERK_SECRET_KEY " +
  "is not set on this server, so sessions cannot be verified server-side: clerkMiddleware() " +
  "is not installed, sign-in gating is unavailable and /auth/native-return cannot mint " +
  "hand-off tickets. Set CLERK_SECRET_KEY to enable them, or NEXT_PUBLIC_CESIUM_CLOUD=0 " +
  "for a local-only build.";

export const CLERK_FAIL_CLOSED_MESSAGE =
  "This Cesium deployment requires sign-in (NEXT_PUBLIC_CESIUM_REQUIRE_SIGN_IN=1) but the " +
  "server has no CLERK_SECRET_KEY, so it cannot verify sessions. Refusing to serve the " +
  "workbench unauthenticated. Set CLERK_SECRET_KEY on the server, or drop the sign-in " +
  "requirement.";

export const CLERK_NATIVE_HANDOFF_UNAVAILABLE_MESSAGE =
  "This Cesium deployment cannot hand a session back to the app: Clerk is not fully " +
  "configured on the server (CLERK_SECRET_KEY is required), so sign-in cannot be verified " +
  "or exchanged for an app ticket.";
