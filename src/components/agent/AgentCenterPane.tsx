"use client";

import { useCallback, useDeferredValue, useEffect, useMemo, useRef } from "react";
import { AskQuestionCard } from "@/components/chat/AskQuestionCard";
import { ChatComposer } from "@/components/chat/ChatComposer";
import { ComposerQueueDock } from "@/components/chat/ComposerQueueDock";
import { MessageList } from "@/components/chat/MessageList";
import { useAgentConversations } from "@/components/chat/AgentConversationsContext";
import {
  useOpenInEditor,
  useRegisterDesignCaptureComposer,
} from "@/components/editor/OpenInEditorContext";
import { askStepsFromMessage } from "@/lib/ask-question-utils";
import {
  buildDraftModeOptionsForBackend,
  buildDraftModelOptionsForBackend,
  projectAgentEventsToChatMessages,
  resolveDraftModelForBackend,
} from "@/lib/agent-chat";
import { DEFAULT_MODE_OPTIONS, resolveCanonicalModeId } from "@/lib/chat-modes";
import { markConversationSwitchVisible } from "@/lib/dev-perf";
import { buildQueuedConfigOverride } from "@/lib/queued-prompt-utils";
import { deleteAgentConversationQueueItem } from "@/lib/server-api";
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
    createAndPromptConversation,
    promptConversation,
    cancelConversation,
    pendingConfigByConversationId,
    setPendingConfigForConversation,
    setConversationBackend,
    setConversationConfigOption,
    setConversationMode,
    setConversationModel,
    syncConversationSnapshot,
    upsertConversation,
    answerPermissionForConversation,
    cancelPermissionForConversation,
    getConversationHistoryCursor,
    loadOlderConversationHistory,
  } = useAgentConversations();
  const { workspaceSession, updateWorkspaceSession, workspaceInfo } = useWorkspace();
  const {
    activeWorkspaceGroup,
    conversationSelectionPending,
    expandedComposerDraftId,
    isDraftConversationSelected,
    refreshConversationGroups,
    selectedConversationId,
    setStableConversationView,
    setSelectedConversationId,
    stableConversationView,
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
            workspaceRoot: workspaceInfo?.root ?? null,
          })
        : [],
    [conversation, deferredThreadEvents, workspaceInfo?.root]
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
  const hasConversationHistoryLoaded =
    !!conversation && (conversation.lastEventSeq === 0 || rawThreadEvents.length > 0);

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

  useEffect(() => {
    if (!selectedConversationId) {
      if (!conversationSelectionPending && !isDraftConversationSelected) {
        setStableConversationView(null);
      }
      return;
    }
    if (!conversation || !hasConversationHistoryLoaded) {
      return;
    }
    setStableConversationView({
      conversationId: selectedConversationId,
      messages: scrollMessages,
      conversationBusy:
        conversation.status === "running" || conversation.status === "awaiting_permission",
      hasOlderHistory: historyCursor.hasOlder,
      loadingOlderHistory: historyCursor.loadingOlder,
      initialScrollTop: workspaceSession.chat.scrollTopByTabId[selectedConversationId] ?? 0,
    });
    requestAnimationFrame(() => {
      markConversationSwitchVisible(selectedConversationId, "thread_visible");
    });
  }, [
    conversation,
    hasConversationHistoryLoaded,
    historyCursor.hasOlder,
    historyCursor.loadingOlder,
    conversationSelectionPending,
    isDraftConversationSelected,
    scrollMessages,
    selectedConversationId,
    setStableConversationView,
    workspaceSession.chat.scrollTopByTabId,
  ]);

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
  useRegisterDesignCaptureComposer(composerDraftId, 10);

  const composerDraftText = composerDrafts[composerDraftId]?.content ?? "";
  const composerDraftAttachments = composerDrafts[composerDraftId]?.attachments;
  const composerDraftCaptures = composerDrafts[composerDraftId]?.captures;
  const composerSelection = composerSelections[composerDraftId] ?? {
    start: composerDraftText.length,
    end: composerDraftText.length,
  };
  const composerHiddenForExpanded = expandedComposerDraftId === composerDraftId;
  const queuedPrompts = conversation?.queuedPrompts ?? [];
  const backendLabels = useMemo(
    () => Object.fromEntries(backends.map((backend) => [backend.id, backend.label ?? backend.id])),
    [backends]
  );

  const removeQueuedPrompt = useCallback(
    (item: QueuedChatPrompt) => {
      if (!selectedConversationId) {
        return;
      }
      void (async () => {
        try {
          const { conversation: nextConversation } = await deleteAgentConversationQueueItem(
            selectedConversationId,
            item.id
          );
          upsertConversation(nextConversation);
        } catch {
          void syncConversationSnapshot(selectedConversationId).catch(() => undefined);
        }
      })();
    },
    [selectedConversationId, syncConversationSnapshot, upsertConversation]
  );

  const unqueuePromptToComposer = useCallback(
    (item: QueuedChatPrompt) => {
      if (!selectedConversationId) {
        return;
      }
      void (async () => {
        try {
          const { conversation: nextConversation } = await deleteAgentConversationQueueItem(
            selectedConversationId,
            item.id
          );
          upsertConversation(nextConversation);
        } catch {
          void syncConversationSnapshot(selectedConversationId).catch(() => undefined);
          return;
        }
        upsertComposerDraft(composerDraftId, {
          title: composerDraftTitle,
          content: item.text,
          attachments: item.attachments,
        });
      })();
    },
    [
      composerDraftId,
      composerDraftTitle,
      selectedConversationId,
      syncConversationSnapshot,
      upsertComposerDraft,
      upsertConversation,
    ]
  );

  const editQueuedPrompt = useCallback(
    (item: QueuedChatPrompt) => {
      if (!selectedConversationId) {
        return;
      }
      void (async () => {
        try {
          const { conversation: nextConversation } = await deleteAgentConversationQueueItem(
            selectedConversationId,
            item.id
          );
          upsertConversation(nextConversation);
        } catch {
          void syncConversationSnapshot(selectedConversationId).catch(() => undefined);
          return;
        }
        upsertComposerDraft(composerDraftId, {
          title: composerDraftTitle,
          content: item.text,
          attachments: item.attachments,
        });
        if (item.configOverride) {
          setPendingConfigForConversation(selectedConversationId, item.configOverride);
        }
        updateWorkspaceSession((current) => ({
          ...current,
          chat: {
            ...current.chat,
            editingQueuedPromptIdByConversationId: {
              ...(current.chat.editingQueuedPromptIdByConversationId ?? {}),
              [selectedConversationId]: item.id,
            },
          },
        }));
      })();
    },
    [
      composerDraftId,
      composerDraftTitle,
      selectedConversationId,
      setPendingConfigForConversation,
      syncConversationSnapshot,
      updateWorkspaceSession,
      upsertComposerDraft,
      upsertConversation,
    ]
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
        const created = await createAndPromptConversation({
          backendId: backend.id,
          mode: draftMode,
          modelId: draftModel.modelValue ?? draftModel.id,
          modelName: draftModel.name,
        }, text, attachments);
        if (!created) {
          return false;
        }
        targetConversationId = created.id;
        setSelectedConversationId(created.id);
        void refreshConversationGroups();
        return true;
      }
      const targetConversation =
        targetConversationId === conversation?.id
          ? conversation
          : conversationsById[targetConversationId];
      const targetBusy =
        targetConversation?.status === "running" ||
        targetConversation?.status === "awaiting_permission";
      const pendingConfig = pendingConfigByConversationId[targetConversationId];
      const derivedOverride =
        targetBusy && targetConversation && composerState
          ? buildQueuedConfigOverride(
              targetConversation.config,
              composerState.backendId,
              composerState.mode,
              composerState.model
            )
          : undefined;
      const mergedOverride = { ...derivedOverride, ...pendingConfig };
      const configOverride =
        targetBusy && Object.keys(mergedOverride).length > 0 ? mergedOverride : undefined;
      const ok = await promptConversation(targetConversationId, text, attachments, configOverride);
      if (!ok) {
        return false;
      }
      void refreshConversationGroups();
      return true;
    },
    [
      createAndPromptConversation,
      composerState,
      conversation,
      conversationsById,
      draftBackend,
      draftMode,
      draftModel.id,
      draftModel.modelValue,
      draftModel.name,
      pendingConfigByConversationId,
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
          if (composerState?.busy) {
            setPendingConfigForConversation(selectedConversationId, { mode: next });
          } else {
            void setConversationMode(selectedConversationId, next);
          }
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
          if (composerState?.busy) {
            setPendingConfigForConversation(selectedConversationId, {
              modelId: next.modelValue ?? next.id,
              modelName: next.name,
            });
          } else {
            void setConversationModel(selectedConversationId, next);
          }
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
          if (composerState?.busy) {
            setPendingConfigForConversation(selectedConversationId, { backendId: next });
          } else {
            void setConversationBackend(selectedConversationId, next);
          }
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
    setPendingConfigForConversation,
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
  const showConversationTransitionState =
    conversationSelectionPending ||
    (!!selectedConversationId && loadState !== "error" && (!conversation || !hasConversationHistoryLoaded));
  const visibleConversationView =
    selectedConversationId && conversation && hasConversationHistoryLoaded
      ? {
          conversationId: selectedConversationId,
          messages: scrollMessages,
          conversationBusy:
            conversation.status === "running" || conversation.status === "awaiting_permission",
          hasOlderHistory: historyCursor.hasOlder,
          loadingOlderHistory: historyCursor.loadingOlder,
          initialScrollTop: workspaceSession.chat.scrollTopByTabId[selectedConversationId] ?? 0,
        }
      : showConversationTransitionState
        ? stableConversationView
        : null;

  const emptyState = (
    <div className="absolute inset-0 flex items-center justify-center px-[14px] pb-[220px] sm:px-[20px] max-[480px]:px-0 max-[480px]:pl-[max(0px,env(safe-area-inset-left,0px))] max-[480px]:pr-[max(0px,env(safe-area-inset-right,0px))]">
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
      <div className="relative flex h-full min-h-0 w-full flex-col overflow-hidden bg-[var(--bg-main)] @container">
        <AgentNewChatLanding />
      </div>
    );
  }

  return (
    <div className="relative flex h-full min-h-0 w-full flex-col overflow-hidden bg-[var(--bg-main)] @container">
      <div className="relative min-h-0 min-w-0 flex-1 overflow-hidden">
        {visibleConversationView ? (
          <div className={showConversationTransitionState ? "pointer-events-none h-full" : "h-full"}>
            <MessageList
              key={visibleConversationView.conversationId}
              messages={visibleConversationView.messages}
              surface="editor"
              contentClassName={AGENT_CENTER_CONTENT_CLASS}
              conversationId={visibleConversationView.conversationId}
              conversationBusy={visibleConversationView.conversationBusy}
              hasOlderHistory={visibleConversationView.hasOlderHistory}
              loadingOlderHistory={visibleConversationView.loadingOlderHistory}
              onRequestOlderHistory={() =>
                loadOlderConversationHistory(visibleConversationView.conversationId)
              }
              initialScrollTop={visibleConversationView.initialScrollTop}
              onScrollTopSettled={(scrollTop) => {
                updateWorkspaceSession((current) =>
                  Math.abs(
                    (current.chat.scrollTopByTabId[visibleConversationView.conversationId] ?? 0) -
                      scrollTop
                  ) < 1
                    ? current
                    : {
                        ...current,
                        chat: {
                          ...current.chat,
                          scrollTopByTabId: {
                            ...current.chat.scrollTopByTabId,
                            [visibleConversationView.conversationId]: scrollTop,
                          },
                        },
                      }
                );
              }}
              onResolvePermission={(requestId, optionId) => {
                void answerPermissionForConversation(
                  visibleConversationView.conversationId,
                  requestId,
                  optionId
                );
              }}
              onCancelPermission={(requestId) => {
                void cancelPermissionForConversation(visibleConversationView.conversationId, requestId);
              }}
              bottomDockVisible={!composerHiddenForExpanded && !showConversationTransitionState}
            />
          </div>
        ) : (
          emptyState
        )}

        {!composerHiddenForExpanded && !showConversationTransitionState ? (
          <div className="pointer-events-none absolute inset-x-0 bottom-0 z-30">
            <div className="pointer-events-auto chat-bottom-dock">
              {dockedAskSteps.length > 0 ? (
                <div className="pt-[8px] px-0 @min-[481px]:px-[10px]">
                  <div className={AGENT_CENTER_CONTENT_CLASS}>
                    <AskQuestionCard steps={dockedAskSteps} dockAboveComposer />
                  </div>
                </div>
              ) : null}
              {queuedPrompts.length > 0 ? (
                <div className="pt-[8px] px-0 @min-[481px]:px-[10px]">
                  <div className={AGENT_CENTER_CONTENT_CLASS}>
                    <ComposerQueueDock
                      items={queuedPrompts}
                      onDelete={removeQueuedPrompt}
                      onUnqueue={unqueuePromptToComposer}
                      onEdit={editQueuedPrompt}
                      conversationConfig={conversation?.config}
                      backendLabels={backendLabels}
                      collapsed={
                        selectedConversationId
                          ? Boolean(
                              workspaceSession.chat.composerQueueDockCollapsedByConversationId?.[
                                selectedConversationId
                              ]
                            )
                          : false
                      }
                      onCollapsedChange={(collapsed) => {
                        if (!selectedConversationId) return;
                        updateWorkspaceSession((current) => {
                          const prev =
                            current.chat.composerQueueDockCollapsedByConversationId ?? {};
                          const m = { ...prev };
                          if (collapsed) {
                            m[selectedConversationId] = true;
                          } else {
                            delete m[selectedConversationId];
                          }
                          return {
                            ...current,
                            chat: {
                              ...current.chat,
                              composerQueueDockCollapsedByConversationId: m,
                            },
                          };
                        });
                      }}
                    />
                  </div>
                </div>
              ) : null}
              <div className="px-0 @min-[481px]:px-[10px]">
                <div className={AGENT_CENTER_CONTENT_CLASS}>
                  <ChatComposer
                    key={composerDraftId}
                    mode={composerState?.mode ?? draftMode}
                    onModeChange={(next) => {
                      if (selectedConversationId) {
                        if (composerState?.busy) {
                          setPendingConfigForConversation(selectedConversationId, {
                            mode: next as EditorMode,
                          });
                        } else {
                          void setConversationMode(selectedConversationId, next as EditorMode);
                        }
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
                        if (composerState?.busy) {
                          setPendingConfigForConversation(selectedConversationId, {
                            modelId: next.modelValue ?? next.id,
                            modelName: next.name,
                          });
                        } else {
                          void setConversationModel(selectedConversationId, next);
                        }
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
                        if (composerState?.busy) {
                          setPendingConfigForConversation(selectedConversationId, {
                            backendId: next,
                          });
                        } else {
                          void setConversationBackend(selectedConversationId, next);
                        }
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
                    shellMxClass=""
                    draftAttachments={composerDraftAttachments}
                    onDraftAttachmentsChange={(next) =>
                      upsertComposerDraft(composerDraftId, {
                        title: composerDraftTitle,
                        content: composerDraftText,
                        attachments: next,
                      })
                    }
                    draftCaptures={composerDraftCaptures}
                    onDraftCapturesChange={(next) =>
                      upsertComposerDraft(composerDraftId, {
                        title: composerDraftTitle,
                        content: composerDraftText,
                        captures: next,
                      })
                    }
                  />
                </div>
              </div>
            </div>
          </div>
        ) : null}
      </div>

    </div>
  );
}
