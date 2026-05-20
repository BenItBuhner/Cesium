"use client";

import { Archive, Pin, PinOff, X } from "lucide-react";

export function AgentRailBulkSelectBar({
  selectedCount,
  showPin,
  showUnpin,
  topBarPadClass,
  onArchive,
  onPin,
  onUnpin,
  onCancel,
}: {
  selectedCount: number;
  showPin: boolean;
  showUnpin: boolean;
  topBarPadClass: string;
  onArchive: () => void;
  onPin: () => void;
  onUnpin: () => void;
  onCancel: () => void;
}) {
  const countLabel =
    selectedCount === 1 ? "1 selected" : `${selectedCount} selected`;

  return (
    <div
      className={`flex shrink-0 items-center justify-between gap-[8px] border-b border-[var(--border-subtle)] pt-[11px] pb-[8px] ${topBarPadClass}`}
      role="toolbar"
      aria-label={`Bulk conversation actions, ${countLabel}`}
    >
      <div className="flex min-w-0 items-center gap-[2px]">
        <span className="mr-[4px] shrink-0 font-sans text-[11px] tabular-nums text-[var(--text-disabled)]">
          {countLabel}
        </span>
        <button
          type="button"
          disabled={selectedCount === 0}
          onClick={onArchive}
          className="flex items-center gap-[4px] rounded-[var(--agent-control-radius)] px-[6px] py-[3px] font-sans text-[12px] text-[var(--text-primary)] transition-colors hover:bg-[var(--agent-card-bg)] disabled:cursor-not-allowed disabled:opacity-40"
        >
          <Archive className="size-[13px]" strokeWidth={1.6} aria-hidden />
          Archive
        </button>
        {showPin ? (
          <button
            type="button"
            disabled={selectedCount === 0}
            onClick={onPin}
            className="flex items-center gap-[4px] rounded-[var(--agent-control-radius)] px-[6px] py-[3px] font-sans text-[12px] text-[var(--text-primary)] transition-colors hover:bg-[var(--agent-card-bg)] disabled:cursor-not-allowed disabled:opacity-40"
          >
            <Pin className="size-[13px]" strokeWidth={1.6} aria-hidden />
            Pin
          </button>
        ) : null}
        {showUnpin ? (
          <button
            type="button"
            disabled={selectedCount === 0}
            onClick={onUnpin}
            className="flex items-center gap-[4px] rounded-[var(--agent-control-radius)] px-[6px] py-[3px] font-sans text-[12px] text-[var(--text-primary)] transition-colors hover:bg-[var(--agent-card-bg)] disabled:cursor-not-allowed disabled:opacity-40"
          >
            <PinOff className="size-[13px]" strokeWidth={1.6} aria-hidden />
            Unpin
          </button>
        ) : null}
      </div>
      <button
        type="button"
        onClick={onCancel}
        className="flex size-[18px] shrink-0 items-center justify-center rounded-[var(--agent-control-radius)] text-[var(--text-secondary)] transition-colors hover:bg-[var(--agent-card-bg)] hover:text-[var(--text-primary)]"
        aria-label="Cancel bulk select"
        title="Cancel"
      >
        <X className="size-[16px]" strokeWidth={1.5} aria-hidden />
      </button>
    </div>
  );
}
