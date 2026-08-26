"use client";

import Link from "next/link";
import { ArrowRight } from "lucide-react";
import { UserButton } from "@clerk/nextjs";
import { useCloudContext } from "@/contexts/CloudContext";
import { WorkbenchLink } from "@/components/landing/WorkbenchLink";

const accentButtonClass =
  "inline-flex items-center gap-[8px] rounded-[var(--radius-tab)] bg-[var(--accent)] px-[20px] py-[10px] text-[14px] font-medium text-[var(--bg-main)] transition-colors hover:bg-[var(--accent-dark)]";

const headerAccentClass =
  "rounded-[var(--radius-tab)] bg-[var(--accent)] px-[14px] py-[6px] text-[13px] font-medium text-[var(--bg-main)] transition-colors hover:bg-[var(--accent-dark)]";

const outlineButtonClass =
  "inline-flex items-center gap-[8px] rounded-[var(--radius-tab)] border border-[var(--border-card)] bg-[var(--bg-panel)] px-[20px] py-[10px] text-[14px] text-[var(--text-primary)] transition-colors hover:bg-[var(--bg-card-hover)]";

function useSignedInCloudAccount(): boolean {
  const cloud = useCloudContext();
  return cloud.mode === "clerk" && cloud.status !== "signed-out" && cloud.status !== "disabled";
}

export function LandingHeaderActions() {
  const signedIn = useSignedInCloudAccount();

  if (signedIn) {
    return (
      <>
        <span className="hidden items-center sm:inline-flex">
          <UserButton />
        </span>
        <WorkbenchLink className={headerAccentClass}>Open workbench</WorkbenchLink>
      </>
    );
  }

  return (
    <Link href="/sign-in" className={headerAccentClass}>
      Sign in
    </Link>
  );
}

export function LandingHeroActions() {
  const signedIn = useSignedInCloudAccount();

  if (signedIn) {
    return (
      <WorkbenchLink className={accentButtonClass}>
        Open workbench
        <ArrowRight className="size-[15px]" strokeWidth={2} aria-hidden />
      </WorkbenchLink>
    );
  }

  return (
    <>
      <Link href="/sign-up" className={accentButtonClass}>
        Sign up
        <ArrowRight className="size-[15px]" strokeWidth={2} aria-hidden />
      </Link>
      <WorkbenchLink className={outlineButtonClass}>Continue as guest</WorkbenchLink>
    </>
  );
}

export function LandingClosingActions() {
  const signedIn = useSignedInCloudAccount();

  if (signedIn) {
    return (
      <WorkbenchLink className={accentButtonClass}>
        Open workbench
        <ArrowRight className="size-[15px]" strokeWidth={2} aria-hidden />
      </WorkbenchLink>
    );
  }

  return (
    <Link href="/sign-up" className={accentButtonClass}>
      Sign up
      <ArrowRight className="size-[15px]" strokeWidth={2} aria-hidden />
    </Link>
  );
}

export function LandingFooterActions() {
  const signedIn = useSignedInCloudAccount();

  if (signedIn) {
    return (
      <WorkbenchLink className="transition-colors hover:text-[var(--text-primary)]">
        Workbench
      </WorkbenchLink>
    );
  }

  return (
    <Link href="/sign-in" className="transition-colors hover:text-[var(--text-primary)]">
      Sign in
    </Link>
  );
}
