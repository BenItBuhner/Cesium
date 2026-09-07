"use client";

import { useCallback } from "react";
import { useAgentShellStateMaybe } from "@/components/agent/AgentShellStateContext";
import { useEditorBridgeRefMaybe } from "@/components/ide/EditorBridgeContext";

/**
 * Open the Advanced context inspector for a conversation in the workbench
 * editor pane (revealing the pane when it is collapsed). Returns false when
 * no editor panel is mounted to receive the tab.
 */
export function useOpenContextInspector(): (input: {
  conversationId: string;
  title: string;
}) => boolean {
  const bridgeRef = useEditorBridgeRefMaybe();
  const agentShell = useAgentShellStateMaybe();
  return useCallback(
    (input: { conversationId: string; title: string }) => {
      const bridge = bridgeRef?.current;
      if (!bridge) {
        return false;
      }
      bridge.openContextInspectorTab({
        conversationId: input.conversationId,
        title: input.title,
      });
      agentShell?.setRightPaneOpen(true);
      return true;
    },
    [agentShell, bridgeRef]
  );
}
