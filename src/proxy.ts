import { clerkMiddleware, createRouteMatcher } from "@clerk/nextjs/server";
import { NextResponse, type NextRequest } from "next/server";
import {
  CLERK_CLIENT_ONLY_WARNING,
  CLERK_FAIL_CLOSED_MESSAGE,
  resolveClerkServerPosture,
  selectClerkProxyBehavior,
} from "@/lib/cloud/clerk-server-posture";
import { isSignInRequired } from "@/lib/cloud/cloud-flags";

/**
 * Next.js 16 network-boundary file (the `middleware.ts` successor).
 *
 * - Local-only / device-mode builds (including the Electron desktop app, or
 *   any build with the `NEXT_PUBLIC_CESIUM_CLOUD=0` kill switch): every
 *   request passes straight through - identical to pre-cloud behavior.
 * - Clerk mode with `CLERK_SECRET_KEY` on the server: Clerk's handler runs.
 *   With `NEXT_PUBLIC_CESIUM_REQUIRE_SIGN_IN=1`, workbench routes require a
 *   signed-in user (public production posture) while the marketing surface
 *   (landing, download), the auth pages themselves, and
 *   machine-to-machine APIs (engine rendezvous) stay public; otherwise
 *   sign-in stays optional and only powers sync.
 * - Clerk mode WITHOUT a server secret (a self-hosted `next start` on the
 *   committed publishable default): `clerkMiddleware()` would assert the
 *   missing key and 500 every route, so it is not installed. Requests pass
 *   through and a warning is logged once - unless sign-in gating was
 *   requested, in which case non-public routes fail closed with a 503 that
 *   names the missing variable rather than opening the workbench.
 */
const posture = resolveClerkServerPosture();
const behavior = selectClerkProxyBehavior(posture);
const requireSignIn = isSignInRequired();

if (posture.kind === "client-only") {
  console.warn(CLERK_CLIENT_ONLY_WARNING);
}

/**
 * Routes that must stay reachable signed-out even in the gated posture:
 * - `/`, `/download` - the public marketing surface.
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
  "/sign-in(.*)",
  "/sign-up(.*)",
  "/auth/native-return",
  "/api/rendezvous(.*)",
  "/api/releases(.*)",
  "/~offline",
  "/manifest.json",
]);

const signInUrl = process.env.NEXT_PUBLIC_CLERK_SIGN_IN_URL?.trim() || "/sign-in";

function buildProxy() {
  if (behavior === "clerk" && posture.kind === "ready") {
    // Pass the resolved keys explicitly: the publishable key may come from the
    // committed default rather than NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY, which is
    // the only place Clerk's own runtime looks.
    return clerkMiddleware(
      async (auth, request) => {
        if (requireSignIn && !isPublicRoute(request)) {
          await auth.protect({
            unauthenticatedUrl: new URL(signInUrl, request.url).toString(),
          });
        }
      },
      { publishableKey: posture.publishableKey, secretKey: posture.secretKey }
    );
  }
  if (behavior === "fail-closed") {
    return (request: NextRequest) => {
      if (isPublicRoute(request)) {
        return NextResponse.next();
      }
      return new NextResponse(CLERK_FAIL_CLOSED_MESSAGE, {
        status: 503,
        headers: { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-store" },
      });
    };
  }
  return () => NextResponse.next();
}

export default buildProxy();

export const config = {
  matcher: [
    // Skip Next.js internals and all static assets.
    "/((?!_next|[^?]*\\.(?:html?|css|js(?!on)|jpe?g|webp|png|gif|svg|ttf|woff2?|ico|csv|docx?|xlsx?|zip|webmanifest)).*)",
    "/(api|trpc)(.*)",
    // Clerk frontend-API proxy routes.
    "/__clerk/(.*)",
  ],
};
