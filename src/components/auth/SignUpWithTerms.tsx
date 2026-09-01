"use client";

import { useMemo } from "react";
import { SignUp } from "@clerk/nextjs";
import { TermsNotice } from "@/components/legal/TermsAgreement";
import { buildTermsAcceptanceMetadata } from "@/lib/legal/terms";

const DEFAULT_SIGN_UP_REDIRECT = "/setup?resume=1";

/**
 * The real Clerk SignUp widget (Google, GitHub, email, whatever is enabled
 * on the instance) plus a notice and acceptance metadata. Do not replace
 * this with a custom email-only form.
 */
export function SignUpWithTerms({
  redirectUrl = DEFAULT_SIGN_UP_REDIRECT,
}: {
  redirectUrl?: string;
}) {
  const acceptedAt = useMemo(() => new Date().toISOString(), []);
  return (
    <div className="flex flex-col items-center gap-[14px]">
      <SignUp
        forceRedirectUrl={redirectUrl}
        fallbackRedirectUrl={redirectUrl}
        unsafeMetadata={buildTermsAcceptanceMetadata(acceptedAt)}
      />
      <TermsNotice className="max-w-[360px] text-center text-[12px] leading-relaxed text-[var(--text-disabled)]" />
    </div>
  );
}
