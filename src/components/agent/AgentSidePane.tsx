"use client";

import { PanelRightClose } from "lucide-react";
import { EditorPanel } from "@/components/editor/EditorPanel";
import { useAgentShellState } from "./AgentShellStateContext";

export function AgentSidePane() {
  const {
    rightPaneOpen,
    toggleRightPaneOpen,
    sidePaneEditorSession,
    updateSidePaneEditorSession,
    expandedComposerDraftId,
    setExpandedComposerDraft,
    sidePaneScopeId,
  } = useAgentShellState();

  return (
    <div className="agent-side-pane relative h-full w-full overflow-hidden bg-[var(--agent-panel-bg)]">
      {rightPaneOpen ? (
        <button
          type="button"
          onClick={toggleRightPaneOpen}
          className="absolute right-[16px] top-[11px] z-40 flex size-[18px] items-center justify-center rounded-[var(--agent-control-radius)] text-[var(--text-secondary)] transition-colors hover:bg-[var(--agent-card-bg)] hover:text-[var(--text-primary)]"
          aria-label="Hide workbench pane"
          title="Hide workbench pane"
        >
          <PanelRightClose className="size-[16px]" strokeWidth={1.5} />
        </button>
      ) : null}
      <EditorPanel
        key={sidePaneScopeId}
        session={sidePaneEditorSession}
        onSessionChange={updateSidePaneEditorSession}
        expandedComposerDraftId={expandedComposerDraftId}
        setExpandedComposerDraft={setExpandedComposerDraft}
        reserveTrailingPaneCloseSlot
      />
      <style jsx global>{`
        .agent-side-pane button[aria-label="Split editor to the right"],
        .agent-side-pane button[aria-label="Join editor groups"] {
          display: none;
        }
      `}</style>
    </div>
  );
}
