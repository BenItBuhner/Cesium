"use client";

import { Copy, GitFork } from "lucide-react";
import { useCallback, useState } from "react";
import { formatAgentRunDuration } from "@/lib/format-agent-run-duration";

const actionButtonClass =
  "inline-flex size-[26px] shrink-0 items-center justify-center rounded-[var(--radius-tab)] text-[var(--text-secondary)] transition-colors hover:bg-[var(--accent-bg)] hover:text-[var(--text-primary)] focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-[var(--border-focus)]";

interface TurnCompletionFooterProps {
  durationMs: number;
  onFork?: () => void;
  copyText?: string | null;
}

export function TurnCompletionFooter({ durationMs, onFork, copyText }: TurnCompletionFooterProps) {
  const [copied, setCopied] = useState(false);
  const trimmedCopyText = copyText?.trim() ?? "";

  const handleCopy = useCallback(async () => {
    if (!trimmedCopyText) {
      return;
    }
    try {
      await navigator.clipboard.writeText(trimmedCopyText);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1500);
    } catch {
      // Clipboard access can fail outside secure contexts; keep the control silent.
    }
  }, [trimmedCopyText]);

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
                onClick={() => void handleCopy()}
                aria-label={copied ? "Copied response" : "Copy response"}
                className={actionButtonClass}
              >
                <Copy className="size-[13px] shrink-0" strokeWidth={1.75} aria-hidden />
              </button>
            ) : null}
          </div>
        ) : null}
      </div>
    </div>
  );
}
