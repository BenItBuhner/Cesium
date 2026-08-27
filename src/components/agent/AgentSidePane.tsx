"use client";

import { PanelLeftClose, PanelRightClose } from "lucide-react";
import { EditorPanel } from "@/components/editor/EditorPanel";
import { useGlobalSettings } from "@/components/preferences/GlobalSettingsProvider";
import { useAgentShellState } from "./AgentShellStateContext";
import { useIsCesiumDesktopApp } from "@/lib/desktop-environment";

export function AgentSidePane() {
  const {
    isMobile,
    rightPaneOpen,
    toggleRightPaneOpen,
    sidePaneEditorSession,
    updateSidePaneEditorSession,
    expandedComposerDraftId,
    setExpandedComposerDraft,
    sidePaneScopeId,
  } = useAgentShellState();
  const { settings } = useGlobalSettings();
  const sideColumnsSwapped = settings.general.sideColumnsSwapped && !isMobile;
  const isDesktopApp = useIsCesiumDesktopApp();
  const electronTrailingChrome = isDesktopApp && !isMobile;

  return (
    <div className="agent-side-pane aurora-shell-panel relative h-full w-full overflow-hidden bg-[var(--agent-panel-bg)]">
      {rightPaneOpen ? (
        <button
          type="button"
          onClick={toggleRightPaneOpen}
          data-workbench-pane-toggle
          data-electron-trailing-chrome={
            electronTrailingChrome ? "true" : undefined
          }
          className="mobile-safe-top-offset absolute top-[11px] right-[16px] z-40 flex size-[18px] items-center justify-center rounded-[var(--agent-control-radius)] text-[var(--text-secondary)] transition-colors hover:bg-[var(--agent-card-bg)] hover:text-[var(--text-primary)]"
          aria-label="Hide workbench pane"
          title="Hide workbench pane"
        >
          {sideColumnsSwapped ? (
            <PanelLeftClose className="size-[16px]" strokeWidth={1.5} />
          ) : (
            <PanelRightClose className="size-[16px]" strokeWidth={1.5} />
          )}
        </button>
      ) : null}
      <div className="mobile-safe-top-content h-full min-h-0 w-full overflow-hidden">
        <EditorPanel
          key={sidePaneScopeId}
          session={sidePaneEditorSession}
          onSessionChange={updateSidePaneEditorSession}
          expandedComposerDraftId={expandedComposerDraftId}
          setExpandedComposerDraft={setExpandedComposerDraft}
          reserveTrailingPaneCloseSlot
        />
      </div>
      <style jsx global>{`
        .agent-side-pane button[aria-label="Split editor to the right"],
        .agent-side-pane button[aria-label="Join editor groups"] {
          display: none;
        }
      `}</style>
    </div>
  );
}
