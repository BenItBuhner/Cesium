"use client";

import { CircleAlert } from "lucide-react";
import type { AgentCompletionErrorViewModel } from "@/lib/agent-completion-error";
import { HorizontalFadedScroll } from "./HorizontalFadedScroll";
import { RetryCountdownButton } from "./RetryCountdownButton";

const transitionSnappy =
  "duration-200 ease-[cubic-bezier(0.16,1,0.3,1)] motion-reduce:transition-none motion-reduce:duration-0";

const btnSecondary =
  "inline-flex min-h-[32px] shrink-0 items-center justify-center rounded-[var(--radius-tab)] border border-[var(--border-card)] bg-transparent px-[14px] py-[6px] font-sans text-[11px] font-medium leading-none text-[var(--text-primary)] outline-none ring-0 transition-opacity duration-150 ease-out hover:bg-[var(--accent-bg)] focus-visible:outline-none focus-visible:ring-0 motion-reduce:transition-none";

export type AgentCompletionErrorCardProps = {
  error: AgentCompletionErrorViewModel;
  supportsRetry: boolean;
  retryDelayMs: number;
  retriesRemaining: number;
  autoRetryActive: boolean;
  retryBusy: boolean;
  dockAboveComposer?: boolean;
  onManualRetry: () => void;
  onDismiss: () => void;
};

export function AgentCompletionErrorCard({
  error,
  supportsRetry,
  retryDelayMs,
  retriesRemaining,
  autoRetryActive,
  retryBusy,
  dockAboveComposer = false,
  onManualRetry,
  onDismiss,
}: AgentCompletionErrorCardProps) {
  const frame = dockAboveComposer
    ? "mx-[12px] flex flex-col overflow-hidden rounded-t-[var(--radius-card)] rounded-b-none border-x border-t border-[var(--border-card)] bg-[var(--bg-card)] p-[10px]"
    : "flex flex-col overflow-hidden rounded-[var(--radius-card)] border border-[var(--border-card)] bg-[var(--bg-card)] p-[10px]";

  return (
    <div className={frame} data-agent-completion-error-card>
      <div className={`flex min-w-0 items-start gap-[6px] pb-[6px] ${transitionSnappy}`}>
        <CircleAlert
          className="mt-[2px] size-[14px] shrink-0 text-[var(--plan-accent)]"
          strokeWidth={1.5}
          aria-hidden
        />
        <div className="min-w-0 flex-1">
          <p className="font-sans text-[13px] font-normal text-[var(--plan-accent-label-strong)]">
            {error.title}
            {error.httpStatus ? (
              <span className="ml-[6px] font-mono text-[10px] font-normal text-[var(--text-secondary)]">
                {error.httpStatus}
              </span>
            ) : null}
          </p>
          <p className="mt-[4px] font-sans text-[11.5px] font-normal leading-snug text-[var(--text-secondary)]">
            {error.summary}
          </p>
        </div>
      </div>

      {error.detail ? (
        <div className="mb-[8px] min-w-0">
          <HorizontalFadedScroll
            scrollClassName="hide-scrollbar-x max-h-[72px] overflow-x-auto overflow-y-auto py-[2px] font-mono text-[10.5px] leading-tight text-[var(--text-secondary)] whitespace-pre"
            edgeColorVar="var(--bg-card)"
            measureKey={error.detail}
          >
            {error.detail}
          </HorizontalFadedScroll>
        </div>
      ) : null}

      <div className="flex flex-wrap items-center justify-end gap-[6px] border-t border-[var(--border-card)] pt-[8px]">
        {supportsRetry ? (
          <RetryCountdownButton
            delayMs={retryDelayMs}
            retriesRemaining={retriesRemaining}
            active={autoRetryActive}
            busy={retryBusy}
            onManualFire={onManualRetry}
          />
        ) : null}
        <button type="button" className={btnSecondary} onClick={onDismiss}>
          Okay
        </button>
      </div>
    </div>
  );
}
