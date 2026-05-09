"use client";

import { ShieldAlert } from "lucide-react";
import type { PermissionChoiceOption } from "@/lib/types";
import { HorizontalFadedScroll } from "./HorizontalFadedScroll";

/** Shared metrics so reject/deny matches allow-* buttons (primary vs outline only). */
const btnBase =
  "pointer-events-auto relative z-[4] inline-flex min-h-[32px] shrink-0 items-center justify-center rounded-[var(--radius-tab)] px-[12px] py-[5px] font-sans text-[12px] font-normal leading-none tracking-normal box-border transition-colors disabled:pointer-events-none disabled:opacity-45";

const btnSecondary = `${btnBase} border border-[var(--border-card)] bg-transparent text-[var(--text-primary)] hover:bg-[var(--accent-bg)]`;

const btnPrimary = `${btnBase} border border-[var(--accent)] bg-[var(--accent)] text-[var(--bg-main)] hover:opacity-90`;

interface PermissionRequestCardProps {
  title: string;
  detail?: string;
  options: PermissionChoiceOption[];
  resolved?: boolean;
  selectedOptionId?: string;
  onSelect?: (optionId: string) => void;
}

function buttonClassForKind(kind: PermissionChoiceOption["kind"]): string {
  return kind === "allow_once" || kind === "allow_always" ? btnPrimary : btnSecondary;
}

export function PermissionRequestCard({
  title,
  detail,
  options,
  resolved = false,
  selectedOptionId,
  onSelect,
}: PermissionRequestCardProps) {
  const resolvedOutcomeText = (() => {
    if (!resolved) {
      return null;
    }
    if (detail?.includes("cancelled") || detail?.includes("cancel")) {
      return detail;
    }
    if (selectedOptionId) {
      const label = (options ?? []).find((o) => o.id === selectedOptionId)?.label;
      if (label) {
        return label;
      }
    }
    return detail ?? "Permission resolved.";
  })();

  return (
    <div className="pointer-events-auto relative z-[4] rounded-[var(--radius-card)] border border-[var(--border-card)] bg-[var(--bg-card)] px-[12px] py-[10px]">
      <div className="flex items-start gap-[10px]">
        <div className="mt-[1px] shrink-0 text-[var(--text-secondary)]">
          <ShieldAlert className="size-[15px]" strokeWidth={1.8} />
        </div>
        <div className="min-w-0 flex-1">
          <div className="font-sans text-[13px] font-medium text-[var(--text-primary)]">
            {title}
          </div>
          {detail && !resolved ? (
            <div className="mt-[6px]">
              <HorizontalFadedScroll
                scrollClassName="hide-scrollbar-x overflow-x-auto py-[2px] font-mono text-[12px] leading-tight text-[var(--text-primary)] opacity-90 whitespace-pre"
                edgeColorVar="var(--bg-card)"
                measureKey={detail}
              >
                {detail}
              </HorizontalFadedScroll>
            </div>
          ) : null}
          {!resolved ? (
            <div className="mt-[10px] flex flex-wrap justify-end gap-[6px]">
              {(options ?? []).map((option) => (
                <button
                  key={option.id}
                  type="button"
                  onClick={() => onSelect?.(option.id)}
                  className={buttonClassForKind(option.kind)}
                >
                  {option.label}
                </button>
              ))}
            </div>
          ) : resolvedOutcomeText ? (
            <div className="mt-[10px] flex justify-end">
              <span className="max-w-full text-right font-sans text-[12px] text-[var(--text-disabled)]">
                {resolvedOutcomeText}
              </span>
            </div>
          ) : null}
        </div>
      </div>
    </div>
  );
}
