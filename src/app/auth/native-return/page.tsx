import type { Metadata } from "next";
import { auth } from "@clerk/nextjs/server";
import { redirect } from "next/navigation";
import {
  CLERK_NATIVE_HANDOFF_UNAVAILABLE_MESSAGE,
  resolveClerkServerPosture,
} from "@/lib/cloud/clerk-server-posture";
import { createClerkNativeHandoffTicket } from "@/lib/cloud/create-clerk-sign-in-token";
import { NativeReturnClient } from "./NativeReturnClient";

export const metadata: Metadata = {
  title: "Return to Cesium",
};

export const dynamic = "force-dynamic";

/**
 * Browser landing pad after hosted Clerk sign-in from a packaged app.
 * Mints a short-lived sign-in ticket and hands it back over cesium://
 * so the Android / iOS / Electron client can activate the same session.
 */
export default async function NativeReturnPage() {
  // `auth()` throws when clerkMiddleware() did not run for the request, which
  // is exactly the case when the server has no CLERK_SECRET_KEY (see proxy.ts).
  // Minting the ticket needs that same secret, so explain instead of crashing.
  if (resolveClerkServerPosture().kind !== "ready") {
    return (
      <NativeReturnClient ticket={null} error={CLERK_NATIVE_HANDOFF_UNAVAILABLE_MESSAGE} />
    );
  }
  const { userId } = await auth();
  if (!userId) {
    redirect("/sign-in?native_handoff=1");
  }

  let ticket: string | null = null;
  let error: string | null = null;
  try {
    ticket = await createClerkNativeHandoffTicket(userId);
  } catch (cause) {
    error =
      cause instanceof Error
        ? cause.message
        : "Could not create a return ticket for the Cesium app.";
  }

  return <NativeReturnClient ticket={ticket} error={error} />;
}
