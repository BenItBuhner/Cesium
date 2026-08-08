import { clerkMiddleware } from "@clerk/nextjs/server";
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
 *   request passes straight through — identical to pre-cloud behavior.
 * - Clerk mode: Clerk's handler runs. With
 *   `NEXT_PUBLIC_CESIUM_REQUIRE_SIGN_IN=1`, every matched route requires a
 *   signed-in user (public production posture); otherwise sign-in stays
 *   optional and only powers sync.
 */
const clerkEnabled = Boolean(getClerkPublishableKey());
const requireSignIn = isSignInRequired();

export default clerkEnabled
  ? clerkMiddleware(async (auth) => {
      if (requireSignIn) {
        await auth.protect();
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
