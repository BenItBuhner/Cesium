"use client";

import { useCallback } from "react";
import { useShellView } from "@/components/layout/ShellViewContext";
import { useWorkspace } from "@/contexts/WorkspaceContext";
import type { AgentBackendId } from "@/lib/agent-types";
import { AgentCompletionErrorCard } from "./AgentCompletionErrorCard";
import type { AgentCompletionErrorDockState } from "./useAgentCompletionErrorDock";

type AgentCompletionErrorDockProps = {
  dock: AgentCompletionErrorDockState;
  dockAboveComposer?: boolean;
  insetClassName?: string;
  contentClassName?: string;
};

const DEFAULT_SETUP_BACKEND: AgentBackendId = "cesium-agent";

export function AgentCompletionErrorDock({
  dock,
  dockAboveComposer = true,
  insetClassName,
  contentClassName,
}: AgentCompletionErrorDockProps) {
  const { openSettingsView } = useShellView();
  const { updateWorkspaceSession } = useWorkspace();
  const targetBackendId = dock.backendId ?? DEFAULT_SETUP_BACKEND;

  // Deep-link straight to Settings → Agents → <harness> so the user lands on
  // the provider key / model controls instead of hunting for them.
  const openHarnessSettings = useCallback(() => {
    updateWorkspaceSession((current) => ({
      ...current,
      settingsView: {
        ...current.settingsView,
        activeNav: "agents",
        agentsHarnessId: targetBackendId,
      },
    }));
    openSettingsView();
    dock.dismiss();
  }, [dock, openSettingsView, targetBackendId, updateWorkspaceSession]);

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
      setupTargetLabel={dock.backendLabel ?? "Cesium Agent"}
      onManualRetry={() => void dock.retry("manual")}
      onDismiss={dock.dismiss}
      onOpenSettings={openHarnessSettings}
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
