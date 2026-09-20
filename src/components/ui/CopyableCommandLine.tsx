"use client";

import { Check, Copy, TriangleAlert } from "lucide-react";
import { useRef, useState } from "react";
import { useCopyToClipboard } from "@/hooks/useCopyToClipboard";
import { describeCopyFailure, type CopyTextResult } from "@/lib/copy-to-clipboard";

/**
 * One-line shell command with a Copy button, built for phones as much as
 * desktops: the command stays selectable (a tap selects all of it, so a
 * long-press copy always works), scrolls horizontally instead of wrapping,
 * and the button reports "Copied" or "Failed" plus a spoken/visible hint
 * instead of silently doing nothing.
 */
export function CopyableCommandLine({
  command,
  placeholder = "Preparing command...",
  copyAriaLabel,
  className = "",
  testId,
}: {
  command: string;
  /** Shown (and Copy disabled) while `command` is still empty. */
  placeholder?: string;
  copyAriaLabel: string;
  className?: string;
  /** Prefix for `data-testid` hooks on the code box, button and status line. */
  testId?: string;
}) {
  const codeRef = useRef<HTMLElement>(null);
  const { copy, feedback } = useCopyToClipboard();
  const [failure, setFailure] = useState<Extract<CopyTextResult, { ok: false }> | null>(
    null
  );

  // Called straight from the click so the clipboard write starts inside the
  // user gesture; mobile browsers reject writes that begin after an await.
  const copyCommand = () => {
    if (!command) return;
    void copy(command, { selectionFallback: codeRef.current }).then((result) => {
      setFailure(result.ok ? null : result);
    });
  };

  const failed = feedback === "failed" && failure !== null;

  return (
    <div className={className}>
      <div className="flex min-w-0 items-center gap-[7px]">
        <code
          ref={codeRef}
          data-testid={testId ? `${testId}-command` : undefined}
          className="block min-w-0 flex-1 cursor-text select-all overflow-x-auto overscroll-x-contain whitespace-nowrap rounded-[var(--radius-tab)] border border-[var(--border-card)] bg-[var(--bg-panel)] px-[9px] py-[7px] font-mono text-[10.5px] leading-none text-[var(--text-primary)] [scrollbar-width:thin]"
        >
          {command || placeholder}
        </code>
        <button
          type="button"
          disabled={!command}
          onClick={copyCommand}
          data-testid={testId ? `${testId}-copy` : undefined}
          data-copy-state={feedback}
          aria-label={copyAriaLabel}
          className="inline-flex h-[30px] min-w-[72px] shrink-0 items-center justify-center gap-[5px] rounded-[var(--radius-tab)] border border-[var(--border-card)] bg-[var(--bg-panel)] px-[8px] font-sans text-[11px] text-[var(--text-primary)] transition-colors hover:bg-[var(--accent-bg)] disabled:opacity-50"
        >
          {feedback === "copied" ? (
            <Check className="size-[13px]" strokeWidth={1.8} aria-hidden />
          ) : failed ? (
            <TriangleAlert className="size-[13px]" strokeWidth={1.8} aria-hidden />
          ) : (
            <Copy className="size-[13px]" strokeWidth={1.6} aria-hidden />
          )}
          {feedback === "copied" ? "Copied" : failed ? "Failed" : "Copy"}
        </button>
      </div>
      <p
        role="status"
        aria-live="polite"
        data-testid={testId ? `${testId}-status` : undefined}
        className={
          failed
            ? "mt-[6px] font-sans text-[10.5px] leading-relaxed text-[var(--goal-accent)]"
            : "sr-only"
        }
      >
        {failed
          ? describeCopyFailure(failure, "command")
          : feedback === "copied"
            ? "Command copied to the clipboard."
            : ""}
      </p>
    </div>
  );
}
