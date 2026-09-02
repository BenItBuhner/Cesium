"use client";

import { CircleAlert, Settings2 } from "lucide-react";
import type { AgentCompletionErrorViewModel } from "@/lib/agent-completion-error";
import { HorizontalFadedScroll } from "./HorizontalFadedScroll";
import { dockedComposerCardMx } from "./docked-card";
import { RetryCountdownButton } from "./RetryCountdownButton";

const transitionSnappy =
  "duration-200 ease-[cubic-bezier(0.16,1,0.3,1)] motion-reduce:transition-none motion-reduce:duration-0";

const btnSecondary =
  "inline-flex min-h-[32px] shrink-0 items-center justify-center rounded-[var(--radius-tab)] border border-[var(--border-card)] bg-transparent px-[14px] py-[6px] font-sans text-[11px] font-medium leading-none text-[var(--text-primary)] outline-none ring-0 transition-opacity duration-150 ease-out hover:bg-[var(--accent-bg)] focus-visible:outline-none focus-visible:ring-0 motion-reduce:transition-none";

const btnPrimary =
  "inline-flex min-h-[32px] shrink-0 items-center justify-center gap-[6px] rounded-[var(--radius-tab)] border border-[var(--plan-accent)] bg-[var(--plan-accent)] px-[14px] py-[6px] font-sans text-[11px] font-medium leading-none text-[var(--bg-card)] outline-none ring-0 transition-opacity duration-150 ease-out hover:opacity-90 focus-visible:outline-none focus-visible:ring-0 motion-reduce:transition-none";

export type AgentCompletionErrorCardProps = {
  error: AgentCompletionErrorViewModel;
  supportsRetry: boolean;
  retryDelayMs: number;
  retriesRemaining: number;
  autoRetryActive: boolean;
  retryBusy: boolean;
  dockAboveComposer?: boolean;
  /** Label for the harness whose settings fix a `setupRequired` failure. */
  setupTargetLabel?: string;
  onManualRetry: () => void;
  onDismiss: () => void;
  /** Jump to Settings → Agents → <harness>; shown only for `setupRequired` failures. */
  onOpenSettings?: () => void;
};

function setupHint(error: AgentCompletionErrorViewModel, targetLabel: string): string | null {
  switch (error.setupRequired) {
    case "provider-auth":
      return `Add a provider API key or connect an account under Settings → Agents → ${targetLabel}, then send your message again.`;
    case "model":
      return `Pick an available model under Settings → Agents → ${targetLabel}, then send your message again.`;
    default:
      return null;
  }
}

export function AgentCompletionErrorCard({
  error,
  supportsRetry,
  retryDelayMs,
  retriesRemaining,
  autoRetryActive,
  retryBusy,
  dockAboveComposer = false,
  setupTargetLabel = "Cesium Agent",
  onManualRetry,
  onDismiss,
  onOpenSettings,
}: AgentCompletionErrorCardProps) {
  const hint = setupHint(error, setupTargetLabel);
  const showOpenSettings = Boolean(error.setupRequired && onOpenSettings);
  // A retry cannot fix a missing key / model; hide the countdown for setup failures.
  const showRetry = supportsRetry && !error.setupRequired;
  const frame = dockAboveComposer
    ? `aurora-glass ${dockedComposerCardMx} flex flex-col overflow-hidden rounded-t-[var(--agent-composer-radius)] rounded-b-none border-x border-t border-[var(--border-card)] bg-[var(--bg-card)] p-[10px]`
    : "aurora-glass flex flex-col overflow-hidden rounded-[var(--agent-composer-radius)] border border-[var(--border-card)] bg-[var(--bg-card)] p-[10px]";

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
          {hint ? (
            <p
              className="mt-[4px] font-sans text-[11px] font-normal leading-snug text-[var(--text-secondary)]"
              data-agent-completion-error-hint
            >
              {hint}
            </p>
          ) : null}
        </div>
      </div>

      {error.detail ? (
        <div className="mb-[8px] min-w-0">
          <HorizontalFadedScroll
            scrollClassName="hide-scrollbar-x max-h-[72px] overflow-x-auto overflow-y-auto py-[2px] font-mono text-[10.5px] leading-tight text-[var(--text-secondary)] whitespace-pre"
            measureKey={error.detail}
          >
            {error.detail}
          </HorizontalFadedScroll>
        </div>
      ) : null}

      <div className="flex flex-wrap items-center justify-end gap-[6px] border-t border-[var(--border-card)] pt-[8px]">
        {showRetry ? (
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
        {showOpenSettings ? (
          <button
            type="button"
            className={btnPrimary}
            onClick={onOpenSettings}
            data-agent-completion-error-open-settings
          >
            <Settings2 className="size-[12px]" strokeWidth={1.75} aria-hidden />
            Open {setupTargetLabel} settings
          </button>
        ) : null}
      </div>
    </div>
  );
}
