import type { Metadata } from "next";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { LegalPageShell } from "@/components/legal/LegalPageShell";
import {
  AGPL_CANONICAL_URL,
  AGPL_NAME,
  AGPL_SPDX,
  CESIUM_LICENSE_BLOB_URL,
  CESIUM_LICENSE_RAW_URL,
  CESIUM_SOURCE_URL,
} from "@/lib/legal/terms";

export const metadata: Metadata = {
  title: "License - Cesium",
  description: `Cesium is licensed under the ${AGPL_NAME}.`,
};

function readRepositoryLicense(): string {
  return readFileSync(join(process.cwd(), "LICENSE"), "utf8");
}

export default function LicensePage() {
  const licenseText = readRepositoryLicense();
  return (
    <LegalPageShell title={`${AGPL_SPDX} license`}>
      <article>
        <p className="mb-[10px] font-mono text-[11px] font-medium uppercase tracking-[0.14em] text-[var(--text-disabled)]">
          Software license · {AGPL_SPDX}
        </p>
        <h1 className="text-balance text-[32px] font-semibold leading-tight tracking-tight">
          License
        </h1>
        <p className="mt-[14px] text-[14.5px] leading-relaxed text-[var(--text-secondary)]">
          Cesium is free software under the {AGPL_NAME}. You may run, study,
          share, and modify it under that license. Network use of a modified
          version requires an offer of corresponding source (AGPL-3.0 section
          13).
        </p>
        <div className="mt-[20px] flex flex-wrap gap-[10px] text-[13px]">
          <a
            href={CESIUM_SOURCE_URL}
            target="_blank"
            rel="noreferrer"
            className="rounded-[var(--radius-tab)] bg-[var(--accent)] px-[14px] py-[7px] font-medium text-[var(--bg-main)] transition-colors hover:bg-[var(--accent-dark)]"
          >
            Source on GitHub
          </a>
          <a
            href={CESIUM_LICENSE_BLOB_URL}
            target="_blank"
            rel="noreferrer"
            className="rounded-[var(--radius-tab)] border border-[var(--border-card)] bg-[var(--bg-panel)] px-[14px] py-[7px] text-[var(--text-primary)] transition-colors hover:bg-[var(--bg-card-hover)]"
          >
            LICENSE in the repo
          </a>
          <a
            href={AGPL_CANONICAL_URL}
            target="_blank"
            rel="noreferrer"
            className="rounded-[var(--radius-tab)] border border-[var(--border-card)] bg-[var(--bg-panel)] px-[14px] py-[7px] text-[var(--text-primary)] transition-colors hover:bg-[var(--bg-card-hover)]"
          >
            GNU AGPL-3.0
          </a>
        </div>
        <p className="mt-[16px] text-[12.5px] leading-relaxed text-[var(--text-disabled)]">
          This page embeds the repository LICENSE file. Canonical copies:{" "}
          <a
            href={CESIUM_LICENSE_RAW_URL}
            target="_blank"
            rel="noreferrer"
            className="underline decoration-[var(--border-card)] underline-offset-[3px] hover:text-[var(--text-primary)]"
          >
            raw LICENSE
          </a>{" "}
          and the GNU text linked above.
        </p>
        <pre className="mt-[28px] overflow-x-auto whitespace-pre-wrap rounded-[var(--radius-card)] border border-[var(--border-card)] bg-[var(--bg-card)] px-[18px] py-[18px] font-mono text-[11.5px] leading-[1.65] text-[var(--text-secondary)]">
          {licenseText}
        </pre>
      </article>
    </LegalPageShell>
  );
}
