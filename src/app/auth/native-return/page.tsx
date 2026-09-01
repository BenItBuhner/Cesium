import type { Metadata } from "next";
import { auth } from "@clerk/nextjs/server";
import { redirect } from "next/navigation";
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
