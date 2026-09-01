"use client";

import { useEffect } from "react";
import {
  buildAndroidClerkHandoffIntent,
  buildClerkHandoffDeepLink,
} from "@/lib/cloud/clerk-native-handoff";

export function NativeReturnClient({
  ticket,
  error,
}: {
  ticket: string | null;
  error: string | null;
}) {
  const deepLink = ticket ? buildClerkHandoffDeepLink(ticket) : null;
  const intentLink = ticket ? buildAndroidClerkHandoffIntent(ticket) : null;

  useEffect(() => {
    if (!deepLink) {
      return;
    }
    const timer = window.setTimeout(() => {
      try {
        window.location.replace(deepLink);
      } catch {
        // Custom-scheme navigation can throw in some browsers; the button remains.
      }
    }, 50);
    return () => window.clearTimeout(timer);
  }, [deepLink]);

  return (
    <main className="flex min-h-screen items-center justify-center bg-[var(--bg-main)] px-[24px] py-[48px] text-[var(--text-primary)]">
      <div className="mx-auto flex w-full max-w-[440px] flex-col gap-[16px]">
        <h1 className="text-[28px] font-semibold tracking-tight">
          {error ? "Could not return to the app" : "Returning to Cesium"}
        </h1>
        <p className="text-[14px] leading-relaxed text-[var(--text-secondary)]">
          {error ??
            "You are signed in. Open the Cesium app to finish bringing this account onto the device."}
        </p>
        {deepLink ? (
          <a
            href={deepLink}
            className="inline-flex w-full items-center justify-center rounded-[var(--radius-tab)] bg-[var(--accent)] px-[20px] py-[12px] text-[14px] font-medium text-[var(--bg-main)]"
          >
            Open Cesium
          </a>
        ) : null}
        {intentLink ? (
          <a
            href={intentLink}
            className="inline-flex w-full items-center justify-center rounded-[var(--radius-tab)] border border-[var(--border-card)] px-[20px] py-[12px] text-[14px] text-[var(--text-primary)]"
          >
            Open Android app
          </a>
        ) : null}
        <a
          href="/setup?resume=1"
          className="text-[13px] text-[var(--text-secondary)] underline-offset-2 hover:text-[var(--text-primary)] hover:underline"
        >
          Continue in this browser
        </a>
      </div>
    </main>
  );
}
