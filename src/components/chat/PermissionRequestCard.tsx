"use client";

import { useCallback, useLayoutEffect, useRef, useState } from "react";
import { ShieldAlert } from "lucide-react";
import type { PermissionChoiceOption } from "@/lib/types";

/** Shared metrics so reject/deny matches allow-* buttons (primary vs outline only). */
const btnBase =
  "inline-flex min-h-[32px] shrink-0 items-center justify-center rounded-[var(--radius-tab)] px-[12px] py-[5px] font-sans text-[12px] font-normal leading-none tracking-normal box-border transition-colors disabled:pointer-events-none disabled:opacity-45";

const btnSecondary = `${btnBase} border border-[var(--border-card)] bg-transparent text-[var(--text-primary)] hover:bg-[var(--accent-bg)]`;

const btnPrimary = `${btnBase} border border-[var(--accent)] bg-[var(--accent)] text-[var(--bg-main)] hover:opacity-90`;

interface PermissionRequestCardProps {
  title: string;
  detail?: string;
  options: PermissionChoiceOption[];
  resolved?: boolean;
  selectedOptionId?: string;
  onSelect?: (optionId: string) => void;
  onCancel?: () => void;
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
  onCancel,
}: PermissionRequestCardProps) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const [fade, setFade] = useState({ left: false, right: false });

  const updateFade = useCallback(() => {
    const el = scrollRef.current;
    if (!el) {
      return;
    }
    const { scrollLeft, scrollWidth, clientWidth } = el;
    const maxScroll = scrollWidth - clientWidth;
    setFade({
      left: scrollLeft > 2,
      right: maxScroll > 2 && scrollLeft < maxScroll - 2,
    });
  }, []);

  useLayoutEffect(() => {
    updateFade();
  }, [detail, resolved, updateFade]);

  useLayoutEffect(() => {
    const el = scrollRef.current;
    if (!el) {
      return;
    }
    const ro = new ResizeObserver(() => updateFade());
    ro.observe(el);
    return () => ro.disconnect();
  }, [updateFade]);

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
    <div className="rounded-[var(--radius-card)] border border-[var(--border-card)] bg-[var(--bg-card)] px-[12px] py-[10px]">
      <div className="flex items-start gap-[10px]">
        <div className="mt-[1px] shrink-0 text-[var(--text-secondary)]">
          <ShieldAlert className="size-[15px]" strokeWidth={1.8} />
        </div>
        <div className="min-w-0 flex-1">
          <div className="font-sans text-[13px] font-medium text-[var(--text-primary)]">
            {title}
          </div>
          {detail && !resolved ? (
            <div className="relative mt-[6px] min-h-[1.25rem]">
              {fade.left ? (
                <div
                  className="pointer-events-none absolute inset-y-0 left-0 z-[1] w-[28px] bg-gradient-to-r from-[var(--bg-card)] to-transparent"
                  aria-hidden
                />
              ) : null}
              {fade.right ? (
                <div
                  className="pointer-events-none absolute inset-y-0 right-0 z-[1] w-[28px] bg-gradient-to-l from-[var(--bg-card)] to-transparent"
                  aria-hidden
                />
              ) : null}
              <div
                ref={scrollRef}
                onScroll={updateFade}
                className="hide-scrollbar-x overflow-x-auto overflow-y-hidden whitespace-nowrap py-[2px] font-mono text-[12px] leading-tight text-[var(--text-secondary)]"
              >
                {detail}
              </div>
            </div>
          ) : null}
          {!resolved ? (
            <>
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
              {onCancel ? (
                <div className="mt-[8px] flex justify-end">
                  <button
                    type="button"
                    className="font-sans text-[11px] text-[var(--text-secondary)] underline decoration-dotted underline-offset-2 hover:text-[var(--text-primary)]"
                    onClick={onCancel}
                  >
                    Cancel request
                  </button>
                </div>
              ) : null}
            </>
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
