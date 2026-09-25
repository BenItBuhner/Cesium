"use client";

import type { ProjectChildBucket } from "@cesium/core";

const DOT_TONE: Record<ProjectChildBucket, string> = {
  working: "bg-[var(--accent)]",
  needs_attention: "bg-[var(--status-warning)]",
  failed: "bg-[var(--status-error)]",
  idle: "bg-[var(--status-success)]",
  stopped: "bg-[var(--text-disabled)]",
  deleted: "bg-transparent border border-[var(--text-disabled)]",
};

export function ProjectStatusDot({
  bucket,
  className = "",
}: {
  bucket: ProjectChildBucket;
  className?: string;
}) {
  return (
    <span className={`relative inline-flex size-[7px] shrink-0 ${className}`} aria-hidden>
      {bucket === "working" ? (
        <span className="absolute inset-0 animate-ping rounded-full bg-[var(--accent)] opacity-50" />
      ) : null}
      <span className={`relative inline-flex size-[7px] rounded-full ${DOT_TONE[bucket]}`} />
    </span>
  );
}

export function ProjectEngineBadge({ label, remote }: { label: string; remote: boolean }) {
  return (
    <span
      className={`inline-flex max-w-[140px] shrink-0 items-center truncate rounded-[4px] px-[5px] py-[0.5px] font-sans text-[10px] leading-[15px] ${
        remote
          ? "bg-[color-mix(in_srgb,var(--accent)_16%,transparent)] text-[var(--accent)]"
          : "bg-[var(--bg-card)] text-[var(--text-secondary)]"
      }`}
      title={remote ? `Runs on ${label}` : `Runs on ${label} (this engine)`}
    >
      {label}
    </span>
  );
}

export const projectButtonClass =
  "inline-flex shrink-0 items-center gap-[5px] rounded-[var(--radius-tab)] border border-[var(--border-card)] bg-[var(--bg-panel)] px-[8px] py-[3px] font-sans text-[11.5px] text-[var(--text-primary)] transition-colors hover:bg-[var(--accent-bg)] disabled:cursor-not-allowed disabled:opacity-50";

export const projectPrimaryButtonClass =
  "inline-flex shrink-0 items-center gap-[5px] rounded-[var(--radius-tab)] border border-[var(--accent)] bg-[var(--accent)] px-[9px] py-[3px] font-sans text-[11.5px] font-medium text-[var(--bg-main)] transition-opacity hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-50";

export const projectDangerButtonClass =
  "inline-flex shrink-0 items-center gap-[5px] rounded-[var(--radius-tab)] border border-[color-mix(in_srgb,var(--status-error)_45%,var(--border-card))] bg-[var(--bg-panel)] px-[8px] py-[3px] font-sans text-[11.5px] text-[var(--status-error)] transition-colors hover:bg-[color-mix(in_srgb,var(--status-error)_12%,transparent)] disabled:cursor-not-allowed disabled:opacity-50";

export const projectInputClass =
  "box-border min-h-[30px] w-full rounded-[var(--radius-tab)] border border-[var(--border-card)] bg-[var(--bg-card)] px-[8px] py-[5px] font-sans text-[12.5px] text-[var(--text-primary)] outline-none placeholder:text-[var(--text-disabled)] focus:border-[var(--accent)]";

export const projectSectionLabelClass =
  "font-sans text-[10.5px] font-medium uppercase tracking-[0.04em] text-[var(--text-secondary)]";

export const projectIconButtonClass =
  "inline-flex size-[26px] shrink-0 items-center justify-center rounded-[var(--radius-tab)] text-[var(--text-secondary)] transition-colors hover:bg-[var(--accent-bg)] hover:text-[var(--text-primary)] disabled:cursor-not-allowed disabled:opacity-50";

export const projectSelectClass = `${projectInputClass} appearance-auto`;

export const projectErrorTextClass =
  "font-sans text-[11.5px] leading-[1.4] text-[var(--status-error)]";

export const projectHintTextClass =
  "font-sans text-[11.5px] leading-[1.45] text-[var(--text-disabled)]";

export function projectErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
