"use client";

import { AgentCompletionErrorCard } from "./AgentCompletionErrorCard";
import type { AgentCompletionErrorDockState } from "./useAgentCompletionErrorDock";

type AgentCompletionErrorDockProps = {
  dock: AgentCompletionErrorDockState;
  insetClassName?: string;
  contentClassName?: string;
};

export function AgentCompletionErrorDock({
  dock,
  insetClassName = "px-[10px]",
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
      autoRetryActive={dock.autoRetryActive}
      retryBusy={dock.retryBusy}
      onRetry={() => void dock.retry()}
      onDismiss={dock.dismiss}
      onCancelAutoRetry={dock.cancelAutoRetry}
    />
  );

  return (
    <div className={`${insetClassName} pb-[8px] pt-[8px]`} data-agent-completion-error-dock>
      {contentClassName ? <div className={contentClassName}>{card}</div> : card}
    </div>
  );
}
