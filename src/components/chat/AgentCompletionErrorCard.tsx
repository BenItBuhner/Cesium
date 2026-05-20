"use client";

import { X } from "lucide-react";
import type { AgentCompletionErrorViewModel } from "@/lib/agent-completion-error";
import { HorizontalFadedScroll } from "./HorizontalFadedScroll";
import { RetryCountdownButton } from "./RetryCountdownButton";

const btnSecondary =
  "inline-flex min-h-[32px] shrink-0 items-center justify-center rounded-[var(--radius-tab)] border border-[var(--border-card)] bg-transparent px-[12px] py-[5px] font-sans text-[12px] font-normal leading-none text-[var(--text-primary)] transition-colors hover:bg-[var(--accent-bg)]";

const iconBtn =
  "inline-flex size-[28px] shrink-0 items-center justify-center rounded-[var(--radius-tab)] text-[var(--text-secondary)] transition-colors hover:bg-[var(--accent-bg)] hover:text-[var(--text-primary)]";

export type AgentCompletionErrorCardProps = {
  error: AgentCompletionErrorViewModel;
  supportsRetry: boolean;
  retryDelayMs: number;
  autoRetryActive: boolean;
  retryBusy: boolean;
  onRetry: () => void;
  onDismiss: () => void;
  onCancelAutoRetry?: () => void;
};

export function AgentCompletionErrorCard({
  error,
  supportsRetry,
  retryDelayMs,
  autoRetryActive,
  retryBusy,
  onRetry,
  onDismiss,
  onCancelAutoRetry,
}: AgentCompletionErrorCardProps) {
  return (
    <div className="rounded-[var(--radius-card)] border border-[var(--border-card)] bg-[var(--bg-card)] px-[12px] py-[10px] shadow-[0_8px_28px_rgba(0,0,0,0.22)]">
      <div className="flex items-start gap-[8px]">
        <div className="min-w-0 flex-1">
          <div className="flex items-start justify-between gap-[8px]">
            <div className="min-w-0">
              <p className="font-sans text-[13px] font-medium text-[var(--text-primary)]">
                {error.title}
                {error.httpStatus ? (
                  <span className="ml-[6px] font-mono text-[11px] font-normal text-[var(--text-secondary)]">
                    {error.httpStatus}
                  </span>
                ) : null}
              </p>
              <p className="mt-[4px] font-sans text-[12px] leading-snug text-[var(--text-secondary)]">
                {error.summary}
              </p>
            </div>
            <button
              type="button"
              className={iconBtn}
              aria-label="Dismiss error"
              onClick={onDismiss}
            >
              <X className="size-[14px]" strokeWidth={1.8} />
            </button>
          </div>
          {error.detail ? (
            <div className="mt-[8px]">
              <HorizontalFadedScroll
                scrollClassName="hide-scrollbar-x max-h-[72px] overflow-x-auto overflow-y-auto py-[2px] font-mono text-[11px] leading-tight text-[var(--text-secondary)] whitespace-pre"
                edgeColorVar="var(--bg-card)"
                measureKey={error.detail}
              >
                {error.detail}
              </HorizontalFadedScroll>
            </div>
          ) : null}
        </div>
      </div>
      <div className="mt-[10px] flex flex-wrap items-center justify-end gap-[6px]">
        {supportsRetry ? (
          <RetryCountdownButton
            delayMs={retryDelayMs}
            active={autoRetryActive}
            busy={retryBusy}
            onFire={onRetry}
            onCancelCountdown={onCancelAutoRetry}
          />
        ) : null}
        <button type="button" className={btnSecondary} onClick={onDismiss}>
          Okay
        </button>
      </div>
    </div>
  );
}
