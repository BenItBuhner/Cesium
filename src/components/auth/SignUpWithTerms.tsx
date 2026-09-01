"use client";

import { useEffect, useMemo, useRef, useState, type RefObject } from "react";
import Link from "next/link";
import { SignUp } from "@clerk/nextjs";
import { CesiumMark } from "@/components/legal/CesiumMark";
import { TermsAgreementCheckbox } from "@/components/legal/TermsAgreement";
import { clerkHostCardClass, getClerkAppearance } from "@/lib/cloud/clerk-appearance";
import { buildTermsAcceptanceMetadata } from "@/lib/legal/terms";

const SIGN_UP_REDIRECT = "/setup?resume=1";

/**
 * Clerk sign-up with express Terms consent in the same place Clerk puts it:
 * between the last field and Continue, inside one card.
 */
export function SignUpWithTerms() {
  const [agreed, setAgreed] = useState(false);
  const acceptedAt = useMemo(
    () => (agreed ? new Date().toISOString() : null),
    [agreed]
  );
  const appearance = useMemo(
    () =>
      getClerkAppearance({
        embedInHostCard: true,
        primaryActionDisabled: !agreed,
      }),
    [agreed]
  );
  const widgetRef = useRef<HTMLDivElement>(null);
  const termsSlotRef = useRef<HTMLDivElement>(null);
  const clerkReady = useClerkWidgetReady(widgetRef);
  useInjectBeforeClerkPrimary(widgetRef, termsSlotRef, clerkReady);

  return (
    <div className={clerkHostCardClass}>
      {!clerkReady ? (
        <ClerkSignUpFrame agreed={agreed} onAgreed={setAgreed} />
      ) : null}
      <div
        ref={widgetRef}
        className={clerkReady ? undefined : "sr-only"}
        aria-hidden={!clerkReady}
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
        {clerkReady ? (
          <div ref={termsSlotRef} className="mb-[16px]">
            <TermsAgreementCheckbox checked={agreed} onChange={setAgreed} />
          </div>
        ) : null}
      </div>
    </div>
  );
}

function ClerkSignUpFrame({
  agreed,
  onAgreed,
}: {
  agreed: boolean;
  onAgreed: (agreed: boolean) => void;
}) {
  return (
    <form
      className="px-[28px] pb-[28px] pt-[32px]"
      onSubmit={(event) => event.preventDefault()}
    >
      <div className="mb-[22px] flex items-center gap-[8px] text-[var(--text-primary)]">
        <CesiumMark className="h-[18px] w-auto" />
        <span className="text-[13px] font-medium tracking-tight">Cesium</span>
      </div>
      <h1 className="text-[18px] font-semibold tracking-tight text-[var(--text-primary)]">
        Create your account
      </h1>
      <p className="mt-[6px] text-[13px] leading-relaxed text-[var(--text-secondary)]">
        Welcome! Please fill in the details to get started.
      </p>
      <label className="mt-[22px] block text-[13px] font-medium text-[var(--text-primary)]">
        Email address
        <input
          type="email"
          autoComplete="email"
          placeholder="Enter your email address"
          className="mt-[6px] h-[36px] w-full rounded-[8px] border border-[var(--border-card)] bg-[var(--bg-panel)] px-[12px] text-[13.5px] text-[var(--text-primary)] outline-none placeholder:text-[var(--text-disabled)] focus:border-[var(--accent)]"
        />
      </label>
      <div className="mt-[16px]">
        <TermsAgreementCheckbox checked={agreed} onChange={onAgreed} />
      </div>
      <button
        type="submit"
        disabled={!agreed}
        className="mt-[16px] h-[36px] w-full rounded-[8px] bg-[var(--accent)] text-[13.5px] font-medium text-[var(--bg-main)] disabled:pointer-events-none disabled:opacity-40"
      >
        Continue
      </button>
      <p className="mt-[18px] text-center text-[13px] text-[var(--text-secondary)]">
        Already have an account?{" "}
        <Link
          href="/sign-in"
          className="font-medium text-[var(--accent)] hover:text-[var(--accent-dark)]"
        >
          Sign in
        </Link>
      </p>
    </form>
  );
}

function useClerkWidgetReady(containerRef: RefObject<HTMLElement | null>): boolean {
  const [ready, setReady] = useState(false);
  useEffect(() => {
    const root = containerRef.current;
    if (!root) {
      return;
    }
    const isReady = () =>
      Boolean(
        root.querySelector(
          ".cl-formButtonPrimary, .cl-socialButtons, .cl-formFieldInput, iframe[src*='clerk']"
        )
      );
    if (isReady()) {
      setReady(true);
      return;
    }
    const observer = new MutationObserver(() => {
      if (isReady()) {
        setReady(true);
      }
    });
    observer.observe(root, { childList: true, subtree: true });
    return () => observer.disconnect();
  }, [containerRef]);
  return ready;
}

function useInjectBeforeClerkPrimary(
  containerRef: RefObject<HTMLElement | null>,
  slotRef: RefObject<HTMLElement | null>,
  enabled: boolean
) {
  useEffect(() => {
    if (!enabled) {
      return;
    }
    const root = containerRef.current;
    const slot = slotRef.current;
    if (!root || !slot) {
      return;
    }
    const place = () => {
      const button = root.querySelector(
        ".cl-formButtonPrimary, button[type='submit']"
      );
      if (
        button instanceof HTMLElement &&
        button.parentElement &&
        button.previousElementSibling !== slot
      ) {
        button.parentElement.insertBefore(slot, button);
      }
    };
    place();
    const observer = new MutationObserver(place);
    observer.observe(root, { childList: true, subtree: true });
    return () => observer.disconnect();
  }, [containerRef, slotRef, enabled]);
}
