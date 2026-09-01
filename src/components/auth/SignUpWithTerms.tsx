"use client";

import { useMemo, useState } from "react";
import { SignUp } from "@clerk/nextjs";
import { TermsAgreementCheckbox } from "@/components/legal/TermsAgreement";
import {
  clerkHostCardClass,
  clerkHostLegalRowClass,
  clerkWidgetGateStyle,
  getClerkAppearance,
} from "@/lib/cloud/clerk-appearance";
import { buildTermsAcceptanceMetadata } from "@/lib/legal/terms";

const SIGN_UP_REDIRECT = "/setup?resume=1";

/**
 * Clerk SignUp with an express Terms checkbox in the same card.
 * The widget stays mounted; agreeing enables it and stamps unsafeMetadata.
 */
export function SignUpWithTerms() {
  const [agreed, setAgreed] = useState(false);
  const acceptedAt = useMemo(
    () => (agreed ? new Date().toISOString() : null),
    [agreed]
  );
  const appearance = useMemo(() => getClerkAppearance({ embedInHostCard: true }), []);

  return (
    <div className={clerkHostCardClass}>
      <div
        aria-disabled={!agreed}
        className={agreed ? undefined : "pointer-events-none select-none"}
        style={agreed ? undefined : clerkWidgetGateStyle}
      >
        <SignUp
          forceRedirectUrl={SIGN_UP_REDIRECT}
          fallbackRedirectUrl={SIGN_UP_REDIRECT}
          appearance={appearance}
          unsafeMetadata={
            agreed && acceptedAt
              ? buildTermsAcceptanceMetadata(acceptedAt)
              : undefined
          }
        />
      </div>
      <div className={clerkHostLegalRowClass}>
        <TermsAgreementCheckbox checked={agreed} onChange={setAgreed} />
      </div>
    </div>
  );
}
