"use client";

import Link from "next/link";
import { CESIUM_SOURCE_URL, LICENSE_PATH, TERMS_PATH } from "@/lib/legal/terms";

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
    <label
      htmlFor={id}
      className="flex cursor-pointer items-start gap-[10px] rounded-[var(--radius-card)] border border-[var(--border-card)] bg-[var(--bg-panel)] px-[14px] py-[12px] text-left"
    >
      <input
        id={id}
        type="checkbox"
        checked={checked}
        onChange={(event) => onChange(event.target.checked)}
        className="mt-[3px] size-[15px] shrink-0 accent-[var(--accent)]"
      />
      <span className="text-[12.5px] leading-relaxed text-[var(--text-secondary)]">
        I have read and agree to the{" "}
        <Link
          href={TERMS_PATH}
          target="_blank"
          rel="noreferrer"
          className="text-[var(--text-primary)] underline decoration-[var(--border-card)] underline-offset-[3px] hover:decoration-[var(--text-primary)]"
          onClick={(event) => event.stopPropagation()}
        >
          Terms of Service
        </Link>
        . I am responsible for secrets I store, agents I run, and everything I
        sync or connect.{" "}
        <Link
          href={LICENSE_PATH}
          target="_blank"
          rel="noreferrer"
          className="text-[var(--text-primary)] underline decoration-[var(--border-card)] underline-offset-[3px] hover:decoration-[var(--text-primary)]"
          onClick={(event) => event.stopPropagation()}
        >
          License
        </Link>
        {" · "}
        <a
          href={CESIUM_SOURCE_URL}
          target="_blank"
          rel="noreferrer"
          className="text-[var(--text-primary)] underline decoration-[var(--border-card)] underline-offset-[3px] hover:decoration-[var(--text-primary)]"
          onClick={(event) => event.stopPropagation()}
        >
          Source
        </a>
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
