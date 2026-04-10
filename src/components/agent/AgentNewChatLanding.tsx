"use client";

import { ChevronDown } from "lucide-react";
import { useCallback, useEffect, useMemo, type MouseEvent as ReactMouseEvent } from "react";
import { ChatComposer } from "@/components/chat/ChatComposer";
import { useAgentConversations } from "@/components/chat/AgentConversationsContext";
import { useOpenInEditor } from "@/components/editor/OpenInEditorContext";
import { useGlobalSettings } from "@/components/preferences/GlobalSettingsProvider";
import {
  buildDraftModeOptionsForBackend,
  buildDraftModelOptionsForBackend,
  resolveDraftModelForBackend,
} from "@/lib/agent-chat";
import { DEFAULT_MODE_OPTIONS, resolveCanonicalModeId } from "@/lib/chat-modes";
import type { AgentBackendId, AgentBackendInfo } from "@/lib/agent-types";
import {
  detectShortcutPlatform,
  getShortcutDisplayForCommand,
} from "@/lib/keyboard-shortcuts";
import type { EditorMode, ImageAttachment } from "@/lib/types";
import { useWorkspace } from "@/contexts/WorkspaceContext";
import { useIDECommandRunner } from "@/components/ide/IDECommandContext";
import { useWorkbenchContextMenu } from "@/components/ide/WorkbenchContextMenuProvider";
import type { WorkbenchMenuItem } from "@/components/ide/workbench-context-menu-types";
import { AGENT_CENTER_CONTENT_CLASS } from "./agent-shell-layout";
import { useAgentShellState } from "./AgentShellStateContext";

function pickAvailableBackend(
  backends: AgentBackendInfo[],
  preferredBackendId?: AgentBackendId
): AgentBackendInfo | null {
  return (
    backends.find((b) => b.id === preferredBackendId && b.available) ??
    backends.find((b) => b.available) ??
    backends[0] ??
    null
  );
}

const QUICK_ACTION_BUTTON_CLASSNAME =
  "inline-flex max-w-full items-center gap-[4px] rounded-[var(--radius-pill)] border border-[var(--border-card)] bg-[var(--bg-panel)] px-[14px] py-[7px] text-left font-sans text-[12px] leading-none font-normal text-[var(--text-primary)] whitespace-nowrap transition-colors hover:bg-[var(--bg-card-hover)]";

export function AgentNewChatLanding() {
  const {
    composerDrafts,
    composerSelections,
    setComposerSelection,
    setExpandedComposerController,
    upsertComposerDraft,
  } = useOpenInEditor();
  const {
    backends,
    createConversation,
    promptConversation,
  } = useAgentConversations();
  const { workspaceSession, updateWorkspaceSession, openWorkspaceById } = useWorkspace();
  const {
    activeWorkspaceGroup,
    expandedComposerDraftId,
    groups,
    refreshConversationGroups,
    setSelectedConversationId,
    setRightPaneOpen,
  } = useAgentShellState();
  const { settings } = useGlobalSettings();
  const { openAt } = useWorkbenchContextMenu();
  const runCommand = useIDECommandRunner();

  const draftBackend = useMemo(
    () => pickAvailableBackend(backends, workspaceSession.chat.backendId),
    [backends, workspaceSession.chat.backendId]
  );
  const draftModels = useMemo(
    () =>
      draftBackend ? buildDraftModelOptionsForBackend(draftBackend) : [workspaceSession.chat.model],
    [draftBackend, workspaceSession.chat.model]
  );
  const draftModel = useMemo(() => {
    if (!draftBackend) return workspaceSession.chat.model;
    const currentModelValue =
      workspaceSession.chat.model.modelValue ?? workspaceSession.chat.model.id;
    return (
      draftModels.find((m) => (m.modelValue ?? m.id) === currentModelValue) ??
      resolveDraftModelForBackend(draftBackend)
    );
  }, [draftBackend, draftModels, workspaceSession.chat.model]);
  const draftModeOptions = useMemo(
    () => (draftBackend ? buildDraftModeOptionsForBackend(draftBackend) : DEFAULT_MODE_OPTIONS),
    [draftBackend]
  );
  const draftMode = useMemo(
    () =>
      resolveCanonicalModeId(
        String(workspaceSession.chat.mode ?? draftModeOptions[0]?.id ?? "agent"),
        draftModeOptions
      ) as EditorMode,
    [draftModeOptions, workspaceSession.chat.mode]
  );

  const composerDraftId = `agent-draft:${activeWorkspaceGroup?.workspace.id ?? "workspace"}`;
  const composerDraftTitle = "Agent prompt";
  const composerDraftText = composerDrafts[composerDraftId]?.content ?? "";
  const composerSelection = composerSelections[composerDraftId] ?? {
    start: composerDraftText.length,
    end: composerDraftText.length,
  };
  const composerHiddenForExpanded = expandedComposerDraftId === composerDraftId;

  const setDraftBackend = useCallback(
    (nextBackendId: AgentBackendId) => {
      const nextBackend = pickAvailableBackend(backends, nextBackendId);
      if (!nextBackend) return;
      updateWorkspaceSession((current) => ({
        ...current,
        chat: {
          ...current.chat,
          backendId: nextBackend.id,
          mode: buildDraftModeOptionsForBackend(nextBackend)[0]?.id ?? current.chat.mode,
          model: resolveDraftModelForBackend(nextBackend),
        },
      }));
    },
    [backends, updateWorkspaceSession]
  );

  const handleSubmit = useCallback(
    async (text: string, attachments?: ImageAttachment[]) => {
      const backend = draftBackend;
      if (!backend) return false;
      const created = await createConversation({
        backendId: backend.id,
        mode: draftMode,
        modelId: draftModel.modelValue ?? draftModel.id,
        modelName: draftModel.name,
      });
      setSelectedConversationId(created.id);
      const ok = await promptConversation(created.id, text, attachments);
      if (!ok) return false;
      void refreshConversationGroups();
      return true;
    },
    [
      createConversation,
      draftBackend,
      draftMode,
      draftModel.id,
      draftModel.modelValue,
      draftModel.name,
      promptConversation,
      refreshConversationGroups,
      setSelectedConversationId,
    ]
  );

  const expandedComposerState = useMemo(() => {
    if (expandedComposerDraftId !== composerDraftId) {
      return null;
    }
    return {
      draftId: composerDraftId,
      title: composerDraftTitle,
      mode: draftMode,
      onModeChange: (next: EditorMode) =>
        updateWorkspaceSession((current) => ({
          ...current,
          chat: {
            ...current.chat,
            mode: next,
          },
        })),
      model: draftModel,
      onModelChange: (next: typeof draftModel) =>
        updateWorkspaceSession((current) => ({
          ...current,
          chat: {
            ...current.chat,
            model: next,
          },
        })),
      backendId: draftBackend?.id ?? workspaceSession.chat.backendId,
      backends,
      onBackendChange: setDraftBackend,
      models: draftModels,
      modeOptions: draftModeOptions,
      sessionConfigOptions: [],
      onSessionConfigOptionChange: undefined,
      onSubmit: handleSubmit,
      onCancel: undefined,
      busy: false,
      configLocked: false,
    };
  }, [
    backends,
    composerDraftId,
    composerDraftTitle,
    draftBackend?.id,
    draftMode,
    draftModeOptions,
    draftModel,
    draftModels,
    expandedComposerDraftId,
    handleSubmit,
    setDraftBackend,
    updateWorkspaceSession,
    workspaceSession.chat.backendId,
  ]);

  useEffect(() => {
    setExpandedComposerController(expandedComposerState);
    return () => {
      setExpandedComposerController(null);
    };
  }, [expandedComposerState, setExpandedComposerController]);

  const planShortcutHint = useMemo(() => {
    return (
      getShortcutDisplayForCommand(
        settings.keyboardShortcuts.bindings,
        "workbench.action.focusChatPlanMode",
        detectShortcutPlatform()
      ) || "Mod+I"
    );
  }, [settings.keyboardShortcuts.bindings]);

  const handleWorkspaceSwitch = useCallback(
    (e: ReactMouseEvent) => {
      const items: WorkbenchMenuItem[] = groups.map((group) => ({
        type: "item" as const,
        id: group.workspace.id,
        label: group.workspace.name,
        onSelect: () => void openWorkspaceById(group.workspace.id),
      }));
      if (items.length > 0) {
        items.push({ type: "sep" });
      }
      items.push({
        type: "item",
        id: "new-workspace",
        label: "New workspace",
        onSelect: () => {
          runCommand?.("workbench.action.createWorkspace");
        },
      });
      openAt(e, items);
    },
    [groups, openAt, openWorkspaceById, runCommand]
  );

  return (
    <div className="flex h-full w-full items-center justify-center overflow-hidden">
      <div
        className={`flex w-full flex-col items-stretch gap-[2px] ${AGENT_CENTER_CONTENT_CLASS}`}
      >
        <div className="mx-[10px] flex min-w-0 flex-col gap-[2px]">
          <div className="w-fit max-w-full self-start">
            <button
              type="button"
              onClick={handleWorkspaceSwitch}
              className="inline-flex min-w-0 max-w-full items-center gap-[6px] rounded-[var(--radius-pill)] px-0 py-[4px] text-left font-sans text-[13px] text-[var(--text-secondary)] transition-colors hover:text-[var(--text-primary)]"
            >
              <span className="max-w-[320px] min-w-0 shrink truncate">
                {activeWorkspaceGroup?.workspace.name ?? "Select workspace"}
              </span>
              <ChevronDown className="size-[14px] shrink-0" strokeWidth={1.5} />
            </button>
          </div>

          {!composerHiddenForExpanded ? (
            <>
              <ChatComposer
                key={composerDraftId}
                mode={draftMode}
                onModeChange={(next) => {
                  updateWorkspaceSession((current) => ({
                    ...current,
                    chat: { ...current.chat, mode: next },
                  }));
                }}
                model={draftModel}
                onModelChange={(next) => {
                  updateWorkspaceSession((current) => ({
                    ...current,
                    chat: { ...current.chat, model: next },
                  }));
                }}
                backendId={draftBackend?.id ?? workspaceSession.chat.backendId}
                backends={backends}
                onBackendChange={(next) => setDraftBackend(next)}
                models={draftModels}
                modeOptions={draftModeOptions}
                sessionConfigOptions={[]}
                onSessionConfigOptionChange={() => undefined}
                value={composerDraftText}
                onValueChange={(next) => {
                  upsertComposerDraft(composerDraftId, {
                    title: composerDraftTitle,
                    content: next,
                  });
                }}
                selection={composerSelection}
                onSelectionChange={(next) => setComposerSelection(composerDraftId, next)}
                agentShellDockHeightExpand
                busy={false}
                configLocked={false}
                onSubmit={handleSubmit}
                onCancel={() => undefined}
                layout="empty-top"
                shellMxClass=""
              />
              <div className="mt-[10px] flex w-full min-w-0 flex-wrap items-center gap-[10px]">
                <button
                  type="button"
                  onClick={() => runCommand?.("workbench.action.focusChatPlanMode")}
                  className={QUICK_ACTION_BUTTON_CLASSNAME}
                >
                  Plan new idea{" "}
                  <span className="text-[var(--text-secondary)]">({planShortcutHint})</span>
                </button>
                <button
                  type="button"
                  onClick={() => setRightPaneOpen(true)}
                  className={QUICK_ACTION_BUTTON_CLASSNAME}
                >
                  Open editor window
                </button>
              </div>
            </>
          ) : null}
        </div>
      </div>
    </div>
  );
}
