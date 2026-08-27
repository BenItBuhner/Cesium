"use client";

import { useEffect, useState, type ReactNode } from "react";
import { SignInButton, SignUpButton } from "@clerk/nextjs";
import { ArrowRight } from "lucide-react";
import { useCloudContext } from "@/contexts/CloudContext";
import {
  getHostedClerkSignInUrl,
  getHostedClerkSignUpUrl,
  shouldUseHostedClerkAuth,
} from "@/lib/cloud/clerk-urls";
import {
  dismissFirstRunAccount,
  isFirstRunAccountDismissed,
  shouldPromptFirstRunAccount,
} from "@/lib/cloud/first-run-account";
import { openExternalUrl } from "@/lib/mobile-bridge";

const accentButtonClass =
  "inline-flex w-full items-center justify-center gap-[8px] rounded-[var(--radius-tab)] bg-[var(--accent)] px-[20px] py-[12px] text-[14px] font-medium text-[var(--bg-main)] transition-colors hover:bg-[var(--accent-dark)]";

const outlineButtonClass =
  "inline-flex w-full items-center justify-center gap-[8px] rounded-[var(--radius-tab)] border border-[var(--border-card)] bg-[var(--bg-panel)] px-[20px] py-[12px] text-[14px] text-[var(--text-primary)] transition-colors hover:bg-[var(--bg-card-hover)]";

/**
 * First-install sign-in / sign-up wall for clerk-mode clients.
 *
 * Packaged apps never see the marketing landing page, so without this the
 * workbench mounts unsigned, fetches an engine that is not there, and toasts
 * "Workspace error / Failed to fetch". Guest is still available — local-first
 * is not a wall — but it is an explicit choice, not the silent default.
 *
 * Clerk widgets only work on allowlisted https origins. Android/iOS/Electron
 * file:// bundles and localhost open the hosted account pages instead, so a
 * Clerk origin mismatch can never pin the app on "Starting Cesium…".
 */
export function FirstRunAccountGate({ children }: { children: ReactNode }) {
  const cloud = useCloudContext();
  const [hydrated, setHydrated] = useState(false);
  const [dismissed, setDismissed] = useState(false);

  useEffect(() => {
    setDismissed(isFirstRunAccountDismissed());
    setHydrated(true);
  }, []);

  useEffect(() => {
    if (cloud.mode === "clerk" && cloud.status === "ready" && !dismissed) {
      dismissFirstRunAccount("signed-in");
      setDismissed(true);
    }
  }, [cloud.mode, cloud.status, dismissed]);

  const prompt = shouldPromptFirstRunAccount({
    cloudMode: cloud.mode,
    cloudStatus: cloud.status,
    dismissed,
  });
  const waitingOnClerk =
    cloud.mode === "clerk" && cloud.status === "loading" && !dismissed;

  if (!hydrated) {
    return <FirstRunSplash />;
  }
  if (!prompt && !waitingOnClerk) {
    return children;
  }

  const hosted = shouldUseHostedClerkAuth(
    typeof window === "undefined"
      ? null
      : { protocol: window.location.protocol, hostname: window.location.hostname },
    cloud.status
  );

  return (
    <div className="fixed inset-0 z-50 overflow-y-auto bg-[var(--bg-main)] text-[var(--text-primary)]">
      <div className="mx-auto flex min-h-full max-w-[440px] flex-col justify-center px-[24px] py-[48px]">
        <div className="mb-[28px] flex items-center gap-[10px]">
          <CesiumMark className="h-[22px] w-auto text-[var(--text-primary)]" />
          <span className="text-[15px] font-semibold tracking-tight">Cesium</span>
        </div>
        <h1 className="text-balance text-[32px] font-semibold leading-[1.1] tracking-tight sm:text-[36px]">
          Sign in to sync.
          <br />
          Or keep going locally.
        </h1>
        <p className="mt-[14px] text-pretty text-[14px] leading-relaxed text-[var(--text-secondary)]">
          Create an account to bring servers, preferences, and chats with you.
          Your code stays on your machine either way.
        </p>
        <div className="mt-[28px] flex flex-col gap-[10px]">
          {hosted ? (
            <>
              <button
                type="button"
                className={accentButtonClass}
                onClick={() => openExternalUrl(getHostedClerkSignUpUrl())}
              >
                Sign up
                <ArrowRight className="size-[15px]" strokeWidth={2} aria-hidden />
              </button>
              <button
                type="button"
                className={outlineButtonClass}
                onClick={() => openExternalUrl(getHostedClerkSignInUrl())}
              >
                Sign in
              </button>
            </>
          ) : (
            <>
              <SignUpButton mode="modal">
                <button type="button" className={accentButtonClass}>
                  Sign up
                  <ArrowRight className="size-[15px]" strokeWidth={2} aria-hidden />
                </button>
              </SignUpButton>
              <SignInButton mode="modal">
                <button type="button" className={outlineButtonClass}>
                  Sign in
                </button>
              </SignInButton>
            </>
          )}
          <button
            type="button"
            onClick={() => {
              dismissFirstRunAccount("guest");
              setDismissed(true);
            }}
            className="mt-[4px] text-[13px] text-[var(--text-secondary)] transition-colors hover:text-[var(--text-primary)]"
          >
            Continue as guest
          </button>
        </div>
      </div>
    </div>
  );
}

function FirstRunSplash() {
  return (
    <div className="flex h-screen w-screen items-center justify-center bg-[var(--bg-main)] font-sans text-[13px] text-[var(--text-secondary)]">
      Starting Cesium…
    </div>
  );
}

function CesiumMark({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 200 174" className={className} aria-hidden>
      <path
        fill="currentColor"
        fillRule="evenodd"
        d="M159.014 134.928L112 162.072a24 24 0 0 1-24 0l-47.014-27.144a24 24 0 0 1-12-20.784V59.856a24 24 0 0 1 12-20.784L88 11.928a24 24 0 0 1 24 0l47.014 27.144a24 24 0 0 1 12 20.784v54.288a24 24 0 0 1-12 20.784ZM151.014 121.072L104 148.215a8 8 0 0 1-8 0l-47.014-27.143a8 8 0 0 1-4-6.928V59.856a8 8 0 0 1 4-6.928L96 25.785a8 8 0 0 1 8 0l47.014 27.143a8 8 0 0 1 4 6.928v54.288a8 8 0 0 1-4 6.928Z"
      />
    </svg>
  );
}
