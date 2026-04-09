"use client";

import { useCallback, useDeferredValue, useEffect, useMemo, useRef } from "react";
import { AskQuestionCard } from "@/components/chat/AskQuestionCard";
import { ChatComposer } from "@/components/chat/ChatComposer";
import { ComposerQueueDock } from "@/components/chat/ComposerQueueDock";
import { MessageList } from "@/components/chat/MessageList";
import { useAgentConversations } from "@/components/chat/AgentConversationsContext";
import { useOpenInEditor } from "@/components/editor/OpenInEditorContext";
import { askStepsFromMessage } from "@/lib/ask-question-utils";
import {
  buildDraftModeOptionsForBackend,
  buildDraftModelOptionsForBackend,
  projectAgentEventsToChatMessages,
  resolveDraftModelForBackend,
} from "@/lib/agent-chat";
import { DEFAULT_MODE_OPTIONS, resolveCanonicalModeId } from "@/lib/chat-modes";
import type { AgentBackendId, AgentBackendInfo } from "@/lib/agent-types";
import type { EditorMode, ImageAttachment, QueuedChatPrompt } from "@/lib/types";
import { useWorkspace } from "@/contexts/WorkspaceContext";
import { AGENT_CENTER_CONTENT_CLASS } from "./agent-shell-layout";
import { AgentNewChatLanding } from "./AgentNewChatLanding";
import { useAgentShellState } from "./AgentShellStateContext";

function partitionMessagesForDock(messages: ReturnType<typeof projectAgentEventsToChatMessages>): {
  scrollMessages: ReturnType<typeof projectAgentEventsToChatMessages>;
  dockedAsk: ReturnType<typeof projectAgentEventsToChatMessages>[number] | null;
} {
  const last = messages[messages.length - 1];
  if (last?.type === "ask-question") {
    return {
      scrollMessages: messages.slice(0, -1),
      dockedAsk: last,
    };
  }
  return { scrollMessages: messages, dockedAsk: null };
}

function pickAvailableBackend(
  backends: AgentBackendInfo[],
  preferredBackendId?: AgentBackendId
): AgentBackendInfo | null {
  return (
    backends.find((backend) => backend.id === preferredBackendId && backend.available) ??
    backends.find((backend) => backend.available) ??
    backends[0] ??
    null
  );
}

export function AgentCenterPane() {
  const {
    composerDrafts,
    composerSelections,
    setComposerSelection,
    setExpandedComposerController,
    upsertComposerDraft,
  } = useOpenInEditor();
  const {
    backends,
    conversationsById,
    eventsByConversationId,
    getConversationComposerState,
    getConversationLoadStatus,
    createConversation,
    promptConversation,
    cancelConversation,
    setConversationBackend,
    setConversationConfigOption,
    setConversationMode,
    setConversationModel,
    syncConversationSnapshot,
    answerPermissionForConversation,
    cancelPermissionForConversation,
    getConversationHistoryCursor,
    loadOlderConversationHistory,
  } = useAgentConversations();
  const { workspaceSession, updateWorkspaceSession } = useWorkspace();
  const {
    activeWorkspaceGroup,
    expandedComposerDraftId,
    isDraftConversationSelected,
    refreshConversationGroups,
    selectedConversationId,
    selectedConversationSummary,
    setSelectedConversationId,
  } = useAgentShellState();
  const previousConversationStatusRef = useRef<string | null>(null);

  const conversation = selectedConversationId
    ? conversationsById[selectedConversationId] ?? null
    : null;
  const loadState = selectedConversationId
    ? getConversationLoadStatus(selectedConversationId)
    : "idle";

  const rawThreadEvents = conversation
    ? (eventsByConversationId[conversation.id] ?? [])
    : [];
  const deferredThreadEvents = useDeferredValue(rawThreadEvents);

  const threadMessages = useMemo(
    () =>
      conversation
        ? projectAgentEventsToChatMessages(deferredThreadEvents, {
            backendId: conversation.config.backendId,
          })
        : [],
    [conversation, deferredThreadEvents]
  );
  const { scrollMessages, dockedAsk } = useMemo(
    () => partitionMessagesForDock(threadMessages),
    [threadMessages]
  );
  const historyCursor = useMemo(() => {
    if (!selectedConversationId) {
      return { hasOlder: false, loadingOlder: false };
    }
    return getConversationHistoryCursor(selectedConversationId);
  }, [getConversationHistoryCursor, selectedConversationId]);
  const dockedAskSteps = useMemo(
    () => (dockedAsk ? askStepsFromMessage(dockedAsk) : []),
    [dockedAsk]
  );

  useEffect(() => {
    if (!selectedConversationId || conversation || loadState === "loading") {
      return;
    }
    void syncConversationSnapshot(selectedConversationId).catch(() => undefined);
  }, [conversation, loadState, selectedConversationId, syncConversationSnapshot]);

  useEffect(() => {
    const previous = previousConversationStatusRef.current;
    const next = conversation?.status ?? null;
    if (
      previous &&
      previous !== next &&
      (previous === "running" || previous === "awaiting_permission")
    ) {
      void refreshConversationGroups();
    }
    previousConversationStatusRef.current = next;
  }, [conversation?.status, refreshConversationGroups]);

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
    if (!draftBackend) {
      return workspaceSession.chat.model;
    }
    const currentModelValue =
      workspaceSession.chat.model.modelValue ?? workspaceSession.chat.model.id;
    return (
      draftModels.find((model) => (model.modelValue ?? model.id) === currentModelValue) ??
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

  const composerState = conversation ? getConversationComposerState(conversation.id) : null;
  const composerDraftId =
    selectedConversationId ??
    `agent-draft:${activeWorkspaceGroup?.workspace.id ?? "workspace"}`;
  const composerDraftTitle =
    conversation?.title && conversation.title !== "New chat"
      ? `${conversation.title} prompt`
      : "Agent prompt";
  const composerDraftText = composerDrafts[composerDraftId]?.content ?? "";
  const composerSelection = composerSelections[composerDraftId] ?? {
    start: composerDraftText.length,
    end: composerDraftText.length,
  };
  const composerHiddenForExpanded = expandedComposerDraftId === composerDraftId;
  const queuedPrompts = selectedConversationId
    ? workspaceSession.chat.queuedPromptsByConversationId?.[selectedConversationId] ?? []
    : [];

  const removeQueuedPrompt = useCallback(
    (item: QueuedChatPrompt) => {
      if (!selectedConversationId) {
        return;
      }
      updateWorkspaceSession((current) => {
        const map = { ...(current.chat.queuedPromptsByConversationId ?? {}) };
        const queue = map[selectedConversationId];
        if (!queue) {
          return current;
        }
        const nextQueue = queue.filter((queued) => queued.id !== item.id);
        if (nextQueue.length === 0) {
          delete map[selectedConversationId];
        } else {
          map[selectedConversationId] = nextQueue;
        }
        return {
          ...current,
          chat: {
            ...current.chat,
            queuedPromptsByConversationId: map,
          },
        };
      });
    },
    [selectedConversationId, updateWorkspaceSession]
  );

  const unqueuePromptToComposer = useCallback(
    (item: QueuedChatPrompt) => {
      removeQueuedPrompt(item);
      upsertComposerDraft(composerDraftId, {
        title: composerDraftTitle,
        content: item.text,
      });
    },
    [composerDraftId, composerDraftTitle, removeQueuedPrompt, upsertComposerDraft]
  );

  const setDraftBackend = useCallback(
    (nextBackendId: AgentBackendId) => {
      const nextBackend = pickAvailableBackend(backends, nextBackendId);
      if (!nextBackend) {
        return;
      }
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
      let targetConversationId = selectedConversationId;
      if (!targetConversationId) {
        const backend = draftBackend;
        if (!backend) {
          return false;
        }
        const created = await createConversation({
          backendId: backend.id,
          mode: draftMode,
          modelId: draftModel.modelValue ?? draftModel.id,
          modelName: draftModel.name,
        });
        targetConversationId = created.id;
        setSelectedConversationId(created.id);
      }
      const ok = await promptConversation(targetConversationId, text, attachments);
      if (!ok) {
        return false;
      }
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
      selectedConversationId,
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
      mode: composerState?.mode ?? draftMode,
      onModeChange: (next: EditorMode) => {
        if (selectedConversationId) {
          void setConversationMode(selectedConversationId, next);
          return;
        }
        updateWorkspaceSession((current) => ({
          ...current,
          chat: {
            ...current.chat,
            mode: next,
          },
        }));
      },
      model: composerState?.model ?? draftModel,
      onModelChange: (next: typeof draftModel) => {
        if (selectedConversationId) {
          void setConversationModel(selectedConversationId, next);
          return;
        }
        updateWorkspaceSession((current) => ({
          ...current,
          chat: {
            ...current.chat,
            model: next,
          },
        }));
      },
      backendId:
        composerState?.backendId ?? draftBackend?.id ?? workspaceSession.chat.backendId,
      backends,
      onBackendChange: (next: AgentBackendId) => {
        if (selectedConversationId) {
          void setConversationBackend(selectedConversationId, next);
          return;
        }
        setDraftBackend(next);
      },
      models: composerState?.models ?? draftModels,
      modeOptions: composerState?.modeOptions ?? draftModeOptions,
      sessionConfigOptions: composerState?.sessionConfigOptions ?? [],
      onSessionConfigOptionChange: (configId: string, value: string) => {
        if (!selectedConversationId) {
          return;
        }
        void setConversationConfigOption(selectedConversationId, configId, value);
      },
      onSubmit: handleSubmit,
      onCancel: () =>
        selectedConversationId
          ? cancelConversation(selectedConversationId)
          : undefined,
      busy: composerState?.busy ?? false,
      configLocked: false,
    };
  }, [
    backends,
    cancelConversation,
    composerDraftId,
    composerDraftTitle,
    composerState,
    draftBackend?.id,
    draftMode,
    draftModeOptions,
    draftModel,
    draftModels,
    expandedComposerDraftId,
    handleSubmit,
    selectedConversationId,
    setConversationBackend,
    setConversationConfigOption,
    setConversationMode,
    setConversationModel,
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

  const showLanding = isDraftConversationSelected && !conversation;

  const emptyState = (
    <div className="absolute inset-0 flex items-center justify-center px-[12px] pb-[220px] sm:px-[20px]">
      <div className={`${AGENT_CENTER_CONTENT_CLASS} text-center`}>
        <p className="font-sans text-[14px] font-normal text-[var(--text-primary)]">
          {activeWorkspaceGroup?.conversations.length
            ? "Select a conversation from the rail or start a new one."
            : "Start the first agent conversation for this workspace."}
        </p>
        <p className="pt-[8px] font-sans text-[12px] font-normal text-[var(--text-secondary)]">
          The new agent shell keeps the conversation centered and lets the workbench stay tucked
          away until you need it.
        </p>
      </div>
    </div>
  );

  if (showLanding) {
    return (
      <div className="relative flex h-full min-h-0 w-full flex-col overflow-hidden bg-[var(--bg-main)]">
        <AgentNewChatLanding />
      </div>
    );
  }

  return (
    <div className="relative flex h-full min-h-0 w-full flex-col overflow-hidden bg-[var(--bg-main)]">
      <div className="relative min-h-0 min-w-0 flex-1 overflow-hidden">
        {selectedConversationId && conversation ? (
          <MessageList
            key={selectedConversationId}
            messages={scrollMessages}
            surface="editor"
            contentClassName={AGENT_CENTER_CONTENT_CLASS}
            conversationId={selectedConversationId}
            conversationBusy={
              conversation.status === "running" ||
              conversation.status === "awaiting_permission"
            }
            hasOlderHistory={historyCursor.hasOlder}
            loadingOlderHistory={historyCursor.loadingOlder}
            onRequestOlderHistory={() =>
              loadOlderConversationHistory(selectedConversationId)
            }
            initialScrollTop={workspaceSession.chat.scrollTopByTabId[selectedConversationId] ?? 0}
            onScrollTopSettled={(scrollTop) => {
              updateWorkspaceSession((current) =>
                Math.abs(
                  (current.chat.scrollTopByTabId[selectedConversationId] ?? 0) - scrollTop
                ) < 1
                  ? current
                  : {
                      ...current,
                      chat: {
                        ...current.chat,
                        scrollTopByTabId: {
                          ...current.chat.scrollTopByTabId,
                          [selectedConversationId]: scrollTop,
                        },
                      },
                    }
              );
            }}
            onResolvePermission={(requestId, optionId) => {
              void answerPermissionForConversation(selectedConversationId, requestId, optionId);
            }}
            onCancelPermission={(requestId) => {
              void cancelPermissionForConversation(selectedConversationId, requestId);
            }}
            bottomDockVisible={!composerHiddenForExpanded}
          />
        ) : (
          emptyState
        )}

        {!composerHiddenForExpanded ? (
          <div className="pointer-events-none absolute inset-x-0 bottom-0 z-30">
            <div className="pointer-events-auto chat-bottom-dock">
              {dockedAskSteps.length > 0 ? (
                <div className="px-[10px] pt-[8px]">
                  <div className={AGENT_CENTER_CONTENT_CLASS}>
                    <AskQuestionCard steps={dockedAskSteps} dockAboveComposer />
                  </div>
                </div>
              ) : null}
              {queuedPrompts.length > 0 ? (
                <div className="px-[10px] pt-[8px]">
                  <div className={AGENT_CENTER_CONTENT_CLASS}>
                    <ComposerQueueDock
                      items={queuedPrompts}
                      onDelete={removeQueuedPrompt}
                      onUnqueue={unqueuePromptToComposer}
                    />
                  </div>
                </div>
              ) : null}
              <div className={AGENT_CENTER_CONTENT_CLASS}>
                <ChatComposer
                  key={composerDraftId}
                  mode={composerState?.mode ?? draftMode}
                  onModeChange={(next) => {
                    if (selectedConversationId) {
                      void setConversationMode(selectedConversationId, next as EditorMode);
                      return;
                    }
                    updateWorkspaceSession((current) => ({
                      ...current,
                      chat: {
                        ...current.chat,
                        mode: next,
                      },
                    }));
                  }}
                  model={composerState?.model ?? draftModel}
                  onModelChange={(next) => {
                    if (selectedConversationId) {
                      void setConversationModel(selectedConversationId, next);
                      return;
                    }
                    updateWorkspaceSession((current) => ({
                      ...current,
                      chat: {
                        ...current.chat,
                        model: next,
                      },
                    }));
                  }}
                  backendId={composerState?.backendId ?? draftBackend?.id ?? workspaceSession.chat.backendId}
                  backends={backends}
                  onBackendChange={(next) => {
                    if (selectedConversationId) {
                      void setConversationBackend(selectedConversationId, next);
                      return;
                    }
                    setDraftBackend(next);
                  }}
                  models={composerState?.models ?? draftModels}
                  modeOptions={composerState?.modeOptions ?? draftModeOptions}
                  sessionConfigOptions={composerState?.sessionConfigOptions ?? []}
                  onSessionConfigOptionChange={(configId, value) => {
                    if (!selectedConversationId) {
                      return;
                    }
                    void setConversationConfigOption(selectedConversationId, configId, value);
                  }}
                  value={composerDraftText}
                  onValueChange={(next) => {
                    upsertComposerDraft(composerDraftId, {
                      title: composerDraftTitle,
                      content: next,
                    });
                  }}
                  selection={composerSelection}
                  onSelectionChange={(next) =>
                    setComposerSelection(composerDraftId, next)
                  }
                  agentShellDockHeightExpand
                  busy={composerState?.busy ?? false}
                  configLocked={false}
                  onSubmit={handleSubmit}
                  onCancel={() =>
                    selectedConversationId
                      ? cancelConversation(selectedConversationId)
                      : undefined
                  }
                  layout="docked-bottom"
                />
              </div>
            </div>
          </div>
        ) : null}
      </div>

      {selectedConversationSummary && !conversation && loadState === "loading" ? (
        <div className="pointer-events-none absolute inset-x-0 top-[24px] z-20 flex justify-center">
          <div className="rounded-[var(--radius-pill)] border border-[var(--border-card)] bg-[var(--bg-panel)] px-[12px] py-[6px] font-sans text-[12px] text-[var(--text-secondary)]">
            Loading {selectedConversationSummary.title}...
          </div>
        </div>
      ) : null}
    </div>
  );
}
