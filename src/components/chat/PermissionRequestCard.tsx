"use client";

import { CheckCircle2, CircleSlash, ShieldAlert } from "lucide-react";
import type { PermissionChoiceOption } from "@/lib/types";

interface PermissionRequestCardProps {
  title: string;
  detail?: string;
  options: PermissionChoiceOption[];
  resolved?: boolean;
  selectedOptionId?: string;
  onSelect?: (optionId: string) => void;
}

function optionTone(kind: PermissionChoiceOption["kind"]): string {
  if (kind === "allow_once" || kind === "allow_always") {
    return "border-[var(--plan-accent)] bg-[var(--plan-accent-bg)] text-[var(--plan-accent)]";
  }
  return "border-[var(--border-card)] bg-[var(--bg-panel)] text-[var(--text-primary)]";
}

export function PermissionRequestCard({
  title,
  detail,
  options,
  resolved = false,
  selectedOptionId,
  onSelect,
}: PermissionRequestCardProps) {
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
          {detail ? (
            <div className="mt-[2px] font-sans text-[12px] text-[var(--text-secondary)]">
              {detail}
            </div>
          ) : null}
          <div className="mt-[10px] flex flex-wrap gap-[8px]">
            {options.map((option) => {
              const selected = option.id === selectedOptionId;
              return (
                <button
                  key={option.id}
                  type="button"
                  disabled={resolved}
                  onClick={() => onSelect?.(option.id)}
                  className={`inline-flex items-center gap-[6px] rounded-[var(--radius-pill)] border px-[9px] py-[5px] font-sans text-[12px] transition-opacity hover:opacity-80 disabled:cursor-not-allowed disabled:opacity-60 ${optionTone(option.kind)}`}
                >
                  {selected ? (
                    <CheckCircle2 className="size-[12px]" strokeWidth={2} />
                  ) : option.kind === "reject_once" || option.kind === "reject_always" ? (
                    <CircleSlash className="size-[12px]" strokeWidth={2} />
                  ) : null}
                  <span>{option.label}</span>
                </button>
              );
            })}
          </div>
          {resolved ? (
            <div className="mt-[8px] font-sans text-[11px] text-[var(--text-secondary)]">
              {selectedOptionId
                ? `Sent ${selectedOptionId}.`
                : "Awaiting the provider to continue the turn."}
            </div>
          ) : null}
        </div>
      </div>
    </div>
  );
}
