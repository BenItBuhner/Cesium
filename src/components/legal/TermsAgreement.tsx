"use client";

import Link from "next/link";
import { LICENSE_PATH, TERMS_PATH } from "@/lib/legal/terms";

const legalLinkClass =
  "text-[var(--text-primary)] underline decoration-[var(--border-card)] underline-offset-[3px] hover:decoration-[var(--text-primary)]";

export function TermsAgreementCheckbox({
  checked,
  onChange,
  id = "terms-agreement",
}: {
  checked: boolean;
  onChange: (checked: boolean) => void;
  id?: string;
}) {
  return (
    <label htmlFor={id} className="flex cursor-pointer items-start gap-[10px] text-left">
      <input
        id={id}
        type="checkbox"
        checked={checked}
        onChange={(event) => onChange(event.target.checked)}
        className="mt-[3px] size-[15px] shrink-0 accent-[var(--accent)]"
      />
      <span className="min-w-0 text-[13px] leading-[1.45] text-[var(--text-secondary)]">
        I agree to the{" "}
        <Link
          href={TERMS_PATH}
          target="_blank"
          rel="noreferrer"
          className={legalLinkClass}
          onClick={(event) => event.stopPropagation()}
        >
          Terms of Service
        </Link>{" "}
        and{" "}
        <Link
          href={LICENSE_PATH}
          target="_blank"
          rel="noreferrer"
          className={legalLinkClass}
          onClick={(event) => event.stopPropagation()}
        >
          License
        </Link>
      </span>
    </label>
  );
}

export function TermsNotice({ className }: { className?: string }) {
  return (
    <p className={className ?? "text-[12px] leading-relaxed text-[var(--text-disabled)]"}>
      By continuing you agree to the{" "}
      <Link
        href={TERMS_PATH}
        className="text-[var(--text-secondary)] underline decoration-[var(--border-card)] underline-offset-[3px] hover:text-[var(--text-primary)]"
      >
        Terms of Service
      </Link>
      .
    </p>
  );
}
