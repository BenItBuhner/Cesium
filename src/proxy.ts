import { clerkMiddleware, createRouteMatcher } from "@clerk/nextjs/server";
import { NextResponse } from "next/server";
import {
  getClerkPublishableKey,
  isSignInRequired,
} from "@/lib/cloud/cloud-flags";

/**
 * Next.js 16 network-boundary file (the `middleware.ts` successor).
 *
 * - Local-only / device-mode builds (including the Electron desktop app, or
 *   any build with the `NEXT_PUBLIC_CESIUM_CLOUD=0` kill switch): every
 *   request passes straight through - identical to pre-cloud behavior.
 * - Clerk mode: Clerk's handler runs. With
 *   `NEXT_PUBLIC_CESIUM_REQUIRE_SIGN_IN=1`, workbench routes require a
 *   signed-in user (public production posture) while the marketing surface
 *   (landing, download), the auth pages themselves, and
 *   machine-to-machine APIs (engine rendezvous) stay public; otherwise
 *   sign-in stays optional and only powers sync.
 */
const clerkEnabled = Boolean(getClerkPublishableKey());
const requireSignIn = isSignInRequired();

/**
 * Routes that must stay reachable signed-out even in the gated posture:
 * - `/`, `/download` - the public marketing surface.
 * - `/terms`, `/license` - legal documents must stay reachable signed-out.
 * - `/sign-in`, `/sign-up` - the Clerk pages (gating these would loop).
 * - `/auth/native-return` - packaged-app ticket handoff; the page itself
 *   bounces unsigned visitors back to sign-in with `native_handoff=1`.
 * - `/api/rendezvous` - engines (curl, no browser session) publish here.
 * - `/api/releases` - powers the download page for signed-out visitors.
 * - `/~offline`, `/manifest.json` - PWA plumbing fetched without credentials.
 */
const isPublicRoute = createRouteMatcher([
  "/",
  "/download(.*)",
  "/terms(.*)",
  "/license(.*)",
  "/sign-in(.*)",
  "/sign-up(.*)",
  "/auth/native-return",
  "/api/rendezvous(.*)",
  "/api/releases(.*)",
  "/~offline",
  "/manifest.json",
]);

const signInUrl = process.env.NEXT_PUBLIC_CLERK_SIGN_IN_URL?.trim() || "/sign-in";

export default clerkEnabled
  ? clerkMiddleware(async (auth, request) => {
      if (requireSignIn && !isPublicRoute(request)) {
        await auth.protect({
          unauthenticatedUrl: new URL(signInUrl, request.url).toString(),
        });
      }
    })
  : () => NextResponse.next();

export const config = {
  matcher: [
    // Skip Next.js internals and all static assets.
    "/((?!_next|[^?]*\\.(?:html?|css|js(?!on)|jpe?g|webp|png|gif|svg|ttf|woff2?|ico|csv|docx?|xlsx?|zip|webmanifest)).*)",
    "/(api|trpc)(.*)",
    // Clerk frontend-API proxy routes.
    "/__clerk/(.*)",
  ],
};
