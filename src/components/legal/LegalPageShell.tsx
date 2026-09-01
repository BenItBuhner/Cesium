import Link from "next/link";
import type { ReactNode } from "react";
import { CesiumMark } from "@/components/legal/CesiumMark";
import {
  AGPL_SPDX,
  CESIUM_SOURCE_URL,
  LICENSE_PATH,
  TERMS_PATH,
} from "@/lib/legal/terms";

const navLinkClass =
  "rounded-[var(--radius-tab)] px-[12px] py-[6px] text-[13px] text-[var(--text-secondary)] transition-colors hover:bg-[var(--accent-bg)] hover:text-[var(--text-primary)]";

export function LegalPageShell({
  title,
  children,
}: {
  title: string;
  children: ReactNode;
}) {
  return (
    <div className="fixed inset-0 z-0 overflow-y-auto overflow-x-hidden bg-[var(--bg-main)] text-[var(--text-primary)]">
      <header className="sticky top-0 z-20 border-b border-[var(--border-subtle)] bg-[color-mix(in_srgb,var(--bg-main)_82%,transparent)] backdrop-blur-md">
        <div className="mx-auto flex h-[56px] max-w-[1100px] items-center justify-between px-[24px]">
          <Link href="/" className="flex items-center gap-[10px]">
            <CesiumMark className="h-[22px] w-auto text-[var(--text-primary)]" />
            <span className="text-[15px] font-semibold tracking-tight">Cesium</span>
          </Link>
          <nav className="flex items-center gap-[6px]">
            <Link href={TERMS_PATH} className={navLinkClass}>
              Terms
            </Link>
            <Link href={LICENSE_PATH} className={navLinkClass}>
              License
            </Link>
            <Link href="/sign-in" className={navLinkClass}>
              Sign in
            </Link>
          </nav>
        </div>
      </header>
      <main className="mx-auto max-w-[720px] px-[24px] py-[48px]">{children}</main>
      <footer className="border-t border-[var(--border-subtle)]">
        <div className="mx-auto flex max-w-[1100px] flex-wrap items-center justify-between gap-[14px] px-[24px] py-[26px]">
          <div className="flex items-center gap-[8px] text-[var(--text-disabled)]">
            <CesiumMark className="h-[16px] w-auto" />
            <span className="text-[12px]">{title}</span>
          </div>
          <div className="flex flex-wrap items-center gap-[18px] text-[12px] text-[var(--text-disabled)]">
            <Link href={TERMS_PATH} className="transition-colors hover:text-[var(--text-primary)]">
              Terms
            </Link>
            <Link href={LICENSE_PATH} className="transition-colors hover:text-[var(--text-primary)]">
              License
            </Link>
            <a
              href={CESIUM_SOURCE_URL}
              target="_blank"
              rel="noreferrer"
              className="transition-colors hover:text-[var(--text-primary)]"
            >
              Source
            </a>
            <span className="font-mono">{AGPL_SPDX}</span>
          </div>
        </div>
      </footer>
    </div>
  );
}
