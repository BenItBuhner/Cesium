"use client";

import { AgentCompletionErrorCard } from "./AgentCompletionErrorCard";
import type { AgentCompletionErrorDockState } from "./useAgentCompletionErrorDock";

type AgentCompletionErrorDockProps = {
  dock: AgentCompletionErrorDockState;
  dockAboveComposer?: boolean;
  insetClassName?: string;
  contentClassName?: string;
};

export function AgentCompletionErrorDock({
  dock,
  dockAboveComposer = true,
  insetClassName,
  contentClassName,
}: AgentCompletionErrorDockProps) {
  if (!dock.visible) {
    return null;
  }

  const card = (
    <AgentCompletionErrorCard
      error={dock.error}
      supportsRetry={dock.supportsRetry}
      retryDelayMs={dock.retryDelayMs}
      retriesRemaining={dock.retriesRemaining}
      autoRetryActive={dock.autoRetryActive}
      retryBusy={dock.retryBusy}
      dockAboveComposer={dockAboveComposer}
      onManualRetry={() => void dock.retry("manual")}
      onDismiss={dock.dismiss}
    />
  );

  const wrapperClass =
    insetClassName ??
    (dockAboveComposer ? "pt-[8px]" : "px-[10px] pb-[8px] pt-[8px]");

  return (
    <div
      className={wrapperClass}
      data-agent-completion-error-dock
    >
      {contentClassName ? <div className={contentClassName}>{card}</div> : card}
    </div>
  );
}
