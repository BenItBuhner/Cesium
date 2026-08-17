"use client";

import type { WorkspaceSessionState } from "@cesium/client";
import type { IDECommandRunner } from "@/components/ide/IDECommandContext";
import { dispatchVoiceSessionCommand } from "@/lib/voice-session-events";

export type QuickActionUiContext = {
  /** IDE command runner (null outside the IDE shell). */
  runIdeCommand: IDECommandRunner | null;
  openActionsSettings: () => void;
  updateWorkspaceSession: (
    updater: (current: WorkspaceSessionState) => WorkspaceSessionState
  ) => void;
};

/**
 * Executes a `ui` quick action client-side. Layout commands route through the
 * IDE command runner (same paths as keyboard shortcuts); settings/layout
 * fallbacks mutate the workspace session directly so they also work where the
 * runner is unavailable.
 */
export function executeQuickActionUiCommand(
  uiCommand: string,
  context: QuickActionUiContext
): void {
  switch (uiCommand) {
    case "layout.toggleRightPane":
      context.runIdeCommand?.("quickActions.layout.toggleRightPane");
      return;
    case "layout.toggleLeftRail":
      context.runIdeCommand?.("quickActions.layout.toggleLeftRail");
      return;
    case "layout.focusChat":
      context.runIdeCommand?.("quickActions.layout.focusChat");
      return;
    case "settings.open":
      context.updateWorkspaceSession((current) => ({
        ...current,
        layout: { ...current.layout, shellView: "settings", priorShellView: "agent" },
      }));
      return;
    case "settings.openActions":
      context.openActionsSettings();
      return;
    case "chat.newConversation":
      context.runIdeCommand?.("workbench.action.newAgent");
      return;
    case "voice.startAgent":
      dispatchVoiceSessionCommand("start");
      return;
    default:
      return;
  }
}
