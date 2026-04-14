"use client";

import { LayoutTemplate, X } from "lucide-react";
import type { DesignPromptSelection } from "@/lib/types";

interface DesignSelectionChipsProps {
  items: DesignPromptSelection[];
  onRemove?: (selectionId: string) => void;
}

export function DesignSelectionChips({
  items,
  onRemove,
}: DesignSelectionChipsProps) {
  if (items.length === 0) {
    return null;
  }

  return (
    <div className="flex flex-wrap gap-[6px]">
      {items.map((selection) => (
        <span
          key={selection.id}
          title={
            selection.selector
              ? `${selection.label}\n${selection.selector}`
              : selection.label
          }
          className="inline-flex max-w-full items-center gap-[6px] rounded-[6px] bg-[var(--file-tag-bg)] px-[8px] py-[4px] font-sans text-[12px] font-medium text-[var(--file-tag-text)]"
        >
          <LayoutTemplate
            className="size-[12px] shrink-0 text-[var(--file-tag-icon)]"
            strokeWidth={1.75}
            aria-hidden
          />
          <span className="max-w-[220px] truncate">{selection.label}</span>
          {onRemove ? (
            <button
              type="button"
              onClick={() => onRemove(selection.id)}
              className="rounded-[4px] p-[1px] text-[var(--file-tag-icon)] transition-colors hover:bg-black/10 hover:text-[var(--file-tag-text)]"
              aria-label={`Remove ${selection.label}`}
            >
              <X className="size-[11px]" strokeWidth={2} />
            </button>
          ) : null}
        </span>
      ))}
    </div>
  );
}
