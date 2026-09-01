"use client";

import { useMemo, useState } from "react";
import { SignUp } from "@clerk/nextjs";
import { TermsAgreementCheckbox } from "@/components/legal/TermsAgreement";
import { buildTermsAcceptanceMetadata } from "@/lib/legal/terms";

const SIGN_UP_REDIRECT = "/setup?resume=1";

/**
 * Clerk sign-up gated on an express Terms of Service checkbox.
 * Acceptance is copied onto the created user as unsafeMetadata.
 */
export function SignUpWithTerms() {
  const [agreed, setAgreed] = useState(false);
  const acceptedAt = useMemo(
    () => (agreed ? new Date().toISOString() : null),
    [agreed]
  );

  return (
    <div className="flex w-full max-w-[420px] flex-col gap-[16px]">
      <div>
        <h1 className="text-[22px] font-semibold tracking-tight text-[var(--text-primary)]">
          Create your account
        </h1>
        <p className="mt-[8px] text-[13px] leading-relaxed text-[var(--text-secondary)]">
          Agree to the Terms first. That is the click that binds you — not the
          OAuth button.
        </p>
      </div>
      <TermsAgreementCheckbox checked={agreed} onChange={setAgreed} />
      {agreed && acceptedAt ? (
        <SignUp
          forceRedirectUrl={SIGN_UP_REDIRECT}
          fallbackRedirectUrl={SIGN_UP_REDIRECT}
          unsafeMetadata={buildTermsAcceptanceMetadata(acceptedAt)}
        />
      ) : (
        <div
          role="status"
          className="rounded-[var(--radius-card)] border border-dashed border-[var(--border-card)] bg-[var(--bg-panel)] px-[18px] py-[22px] text-center text-[13px] leading-relaxed text-[var(--text-disabled)]"
        >
          Check the box above to continue to sign-up.
        </div>
      )}
    </div>
  );
}
