"use client";

import { useEffect } from "react";
import { getPendingEngineConnect } from "@/lib/cloud/engine-pairing";

/**
 * Resumes a `/connect/<code>` approval after sign-in. Clerk's sign-in and
 * sign-up pages force their redirect to `/setup`, and packaged clients come
 * back through the native ticket page, so the approval page stashes the
 * code before sending the user off and this hook brings them back once the
 * account is ready.
 */
export function PendingEngineConnectRedirect({ status }: { status: string }) {
  useEffect(() => {
    if (status !== "ready" || typeof window === "undefined") {
      return;
    }
    const pathname = window.location.pathname;
    if (pathname.startsWith("/connect/") || pathname.startsWith("/auth/")) {
      return;
    }
    const code = getPendingEngineConnect();
    if (code) {
      window.location.assign(`/connect/${code}`);
    }
  }, [status]);
  return null;
}
