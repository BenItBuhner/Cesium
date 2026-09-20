"use client";

import { Check, Copy, GitFork, TriangleAlert } from "lucide-react";
import { useCallback } from "react";
import { useCopyToClipboard } from "@/hooks/useCopyToClipboard";
import { formatAgentRunDuration } from "@/lib/format-agent-run-duration";

const actionButtonClass =
  "inline-flex size-[26px] shrink-0 items-center justify-center rounded-[var(--radius-tab)] text-[var(--text-secondary)] transition-colors hover:bg-[var(--accent-bg)] hover:text-[var(--text-primary)] focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-[var(--accent)]";

interface TurnCompletionFooterProps {
  durationMs: number;
  onFork?: () => void;
  copyText?: string | null;
}

export function TurnCompletionFooter({ durationMs, onFork, copyText }: TurnCompletionFooterProps) {
  const { copy, feedback: copyFeedback } = useCopyToClipboard({ copiedResetMs: 1500 });
  const trimmedCopyText = copyText?.trim() ?? "";

  // Synchronous from the click so the clipboard write runs inside the gesture.
  const handleCopy = useCallback(() => {
    if (!trimmedCopyText) {
      return;
    }
    void copy(trimmedCopyText);
  }, [copy, trimmedCopyText]);

  const showCopy = trimmedCopyText.length > 0;

  return (
    <div className="flex min-w-0 w-full justify-end pt-[6px]">
      <div className="flex items-center gap-[10px]">
        <span className="font-sans text-[12px] font-normal leading-none text-[var(--text-secondary)]">
          {formatAgentRunDuration(durationMs)}
        </span>
        {onFork || showCopy ? (
          <div className="flex items-center gap-[2px]">
            {onFork ? (
              <button
                type="button"
                onClick={onFork}
                aria-label="Fork chat"
                className={actionButtonClass}
              >
                <GitFork className="size-[13px] shrink-0" strokeWidth={1.75} aria-hidden />
              </button>
            ) : null}
            {showCopy ? (
              <button
                type="button"
                onClick={handleCopy}
                aria-label={
                  copyFeedback === "copied"
                    ? "Copied response"
                    : copyFeedback === "failed"
                      ? "Could not copy response"
                      : "Copy response"
                }
                title={copyFeedback === "failed" ? "Could not copy response" : undefined}
                className={actionButtonClass}
              >
                {copyFeedback === "copied" ? (
                  <Check className="size-[13px] shrink-0" strokeWidth={1.75} aria-hidden />
                ) : copyFeedback === "failed" ? (
                  <TriangleAlert className="size-[13px] shrink-0" strokeWidth={1.75} aria-hidden />
                ) : (
                  <Copy className="size-[13px] shrink-0" strokeWidth={1.75} aria-hidden />
                )}
              </button>
            ) : null}
          </div>
        ) : null}
      </div>
    </div>
  );
}
