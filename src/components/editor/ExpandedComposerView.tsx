"use client";

import { useCallback } from "react";
import { ChatComposer } from "@/components/chat/ChatComposer";
import { useOpenInEditor } from "./OpenInEditorContext";

interface ExpandedComposerViewProps {
  draftId: string;
  title: string;
  onMinimize: () => void;
}

export function ExpandedComposerView({
  draftId,
  title,
  onMinimize,
}: ExpandedComposerViewProps) {
  const {
    composerDrafts,
    composerSelections,
    upsertComposerDraft,
    setComposerSelection,
    setExpandedComposerDraft,
    expandedComposerController,
  } = useOpenInEditor();

  const content = composerDrafts[draftId]?.content ?? "";
  const selection = composerSelections[draftId] ?? {
    start: content.length,
    end: content.length,
  };

  const minimizeComposer = useCallback(() => {
    setExpandedComposerDraft(null);
    if (typeof window !== "undefined") {
      window.requestAnimationFrame(() => {
        onMinimize();
      });
      return;
    }
    onMinimize();
  }, [onMinimize, setExpandedComposerDraft]);

  if (!expandedComposerController || expandedComposerController.draftId !== draftId) {
    return (
      <div className="flex h-full min-h-0 flex-col bg-[var(--bg-main)]">
        <div className="flex min-h-0 flex-1 items-center justify-center px-6 text-center">
          <p className="max-w-[420px] font-sans text-[13px] leading-relaxed text-[var(--text-secondary)]">
            The live composer controls for {title} are active in the chat pane right now.
          </p>
        </div>
      </div>
    );
  }

  const controller = expandedComposerController;

  return (
    <div className="flex h-full min-h-0 flex-col overflow-hidden bg-[var(--bg-main)]">
      <div className="min-h-0 flex-1">
        <ChatComposer
          mode={controller.mode}
          onModeChange={controller.onModeChange}
          model={controller.model}
          onModelChange={controller.onModelChange}
          backendId={controller.backendId}
          backends={controller.backends}
          onBackendChange={controller.onBackendChange}
          models={controller.models}
          modeOptions={controller.modeOptions}
          sessionConfigOptions={controller.sessionConfigOptions}
          onSessionConfigOptionChange={controller.onSessionConfigOptionChange}
          value={content}
          onValueChange={(next) => {
            upsertComposerDraft(draftId, {
              title: controller.title,
              content: next,
            });
          }}
          selection={selection}
          onSelectionChange={(next) => setComposerSelection(draftId, next)}
          onCollapseComposer={minimizeComposer}
          onSubmit={async (text) => {
            const submitted = await controller.onSubmit(text);
            if (submitted === false) {
              return;
            }
            minimizeComposer();
          }}
          onCancel={controller.onCancel}
          busy={controller.busy}
          configLocked={controller.configLocked}
          layout="empty-top"
          variant="expanded"
        />
      </div>
    </div>
  );
}
