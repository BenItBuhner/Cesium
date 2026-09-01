"use client";

import { useEffect } from "react";
import {
  isNativeClerkHandoffSearch,
  NATIVE_CLERK_HANDOFF_PATH,
} from "@/lib/cloud/clerk-native-handoff";

/**
 * If hosted Clerk ignored forceRedirectUrl and dumped a native-app sign-in
 * onto /setup, bounce to the ticket handoff page immediately.
 */
export function NativeHandoffBounce() {
  useEffect(() => {
    if (typeof window === "undefined") {
      return;
    }
    if (!isNativeClerkHandoffSearch(new URLSearchParams(window.location.search))) {
      return;
    }
    window.location.replace(NATIVE_CLERK_HANDOFF_PATH);
  }, []);
  return null;
}
