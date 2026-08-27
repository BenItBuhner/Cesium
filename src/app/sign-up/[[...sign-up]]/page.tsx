import type { Metadata } from "next";
import Link from "next/link";
import { SignUp } from "@clerk/nextjs";
import { getCloudMode } from "@/lib/cloud/cloud-flags";

export const metadata: Metadata = {
  title: "Sign up - Cesium",
};

/** Dedicated Clerk sign-up route; see sign-in/page.tsx for the mode notes. */
export default function SignUpPage() {
  if (getCloudMode() !== "clerk") {
    return (
      <main className="flex min-h-screen flex-col items-center justify-center gap-[14px] bg-[var(--bg-main)] px-[24px] text-center">
        <h1 className="text-[22px] font-semibold tracking-tight text-[var(--text-primary)]">
          Cloud accounts are not configured
        </h1>
        <p className="max-w-[420px] text-[13.5px] leading-relaxed text-[var(--text-secondary)]">
          This deployment runs in local-first mode without a Clerk account system. Head back to
          the workbench - no account is needed.
        </p>
        <Link
          href="/"
          className="rounded-[var(--radius-tab)] bg-[var(--accent)] px-[18px] py-[8px] text-[13.5px] font-medium text-[var(--bg-main)] transition-colors hover:bg-[var(--accent-dark)]"
        >
          Back to Cesium
        </Link>
      </main>
    );
  }
  return (
    <main className="flex min-h-screen items-center justify-center bg-[var(--bg-main)] px-[24px] py-[48px]">
      <SignUp forceRedirectUrl="/setup?resume=1" fallbackRedirectUrl="/setup?resume=1" />
    </main>
  );
}
