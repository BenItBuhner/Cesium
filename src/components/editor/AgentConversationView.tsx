"use client";

import { useCallback, useDeferredValue, useEffect, useMemo, useState } from "react";
import { Search } from "lucide-react";
import { ChatComposer } from "@/components/chat/ChatComposer";
import { ComposerQueueDock } from "@/components/chat/ComposerQueueDock";
import { AgentCompletionErrorDock } from "@/components/chat/AgentCompletionErrorDock";
import { useAgentCompletionErrorDock } from "@/components/chat/useAgentCompletionErrorDock";
import { AskQuestionCard } from "@/components/chat/AskQuestionCard";
import { MessageList, type MessageListScrollPersistMeta } from "@/components/chat/MessageList";
import {
  useOpenInEditor,
  useRegisterDesignCaptureComposer,
} from "@/components/editor/OpenInEditorContext";
import { RecentChatsModal } from "@/components/ide/RecentChatsModal";
import { useRedoInlineUserMessage } from "@/components/chat/useRedoInlineUserMessage";
import { useGlobalSettings } from "@/components/preferences/GlobalSettingsProvider";
import {
  extractComposerUserMessageHistory,
  latestBurnProgressStatus,
  projectAgentEventsToChatMessages,
} from "@/lib/agent-chat";
import {
  findDockedAskQuestion,
  hideDockedAskFromScroll,
} from "@/lib/ask-question-dock";
import { isAgentComposerBusy } from "@/lib/agent-completion-error";
import { computeContextUsageRefreshGeneration } from "@/lib/context-usage-refresh";
import { buildQueuedConfigOverride } from "@/lib/queued-prompt-utils";
import { markConversationSwitchVisible } from "@/lib/dev-perf";
import { useAgentConversations } from "@/components/chat/AgentConversationsContext";
import { deleteAgentConversationQueueItem } from "@/lib/server-api";
import { isOrchestrationModeLocked } from "@/lib/chat-modes";
import type { EditorMode, ImageAttachment, QueuedChatPrompt } from "@/lib/types";
import { useWorkspace } from "@/contexts/WorkspaceContext";
import { resolvePersistedChatScroll } from "@/lib/workspace-session";
import { getActiveServerStorageKey } from "@/lib/server-connections";
import { getConfiguredServerBaseUrl } from "@/lib/resolve-server-base-url";
import {
  EDITOR_CHAT_CONTENT_CLASS,
  EDITOR_CHAT_INSET_X_CLASS,
} from "./agent-chat-layout";

function formatRecentConversationTime(timestamp: number): string {
  const diff = Date.now() - timestamp;
  const minutes = Math.floor(diff / 60_000);
  const hours = Math.floor(minutes / 60);
  const days = Math.floor(hours / 24);

  if (days > 0) {
    return `${days}d ago`;
  }
  if (hours > 0) {
    return `${hours}h ago`;
  }
  if (minutes > 0) {
    return `${minutes}m ago`;
  }
  return "just now";
}

function isRecentConversationCandidate(title: string, lastEventSeq: number, busy: boolean): boolean {
  if (title === "New chat" && !busy) {
    return false;
  }
  if (title.startsWith("Draft: ")) {
    return true;
  }
  return lastEventSeq > 0 || busy;
}

interface AgentConversationViewProps {
  conversationId: string;
  expandedComposerDraftId?: string | null;
  setExpandedComposerDraft?: (draftId: string | null) => void;
}

/** Stable identity for the no-events case so memos/effects keyed on it don't re-fire every render. */
const EMPTY_THREAD_EVENTS: never[] = [];

export function AgentConversationView({
  conversationId,
  expandedComposerDraftId: expandedComposerDraftIdOverride,
  setExpandedComposerDraft: setExpandedComposerDraftOverride,
}: AgentConversationViewProps) {
  const [recentChatsModalOpen, setRecentChatsModalOpen] = useState(false);
  const {
    composerDrafts,
    composerSelections,
    openAgentConversation,
    upsertComposerDraft,
    setComposerSelection,
    openComposerDraft,
    expandedComposerDraftId: workspaceExpandedComposerDraftId,
    setExpandedComposerDraft: setWorkspaceExpandedComposerDraft,
  } = useOpenInEditor();
  const {
    backends,
conversations,
conversationsById,
eventsByConversationId,
bootstrapped,
getConversationLoadStatus,
answerPermissionForConversation,
answerQuestionForConversation,
getConversationComposerState,
promptConversation,
mergeConversationSnapshot,
refreshConversations,
cancelConversation,
pauseConversation,
resumeConversation,
setConversationMode,
setConversationModel,
setConversationBackend,
setConversationConfigOption,
syncConversationSnapshot,
getConversationHistoryCursor,
loadOlderConversationHistory,
  pendingConfigByConversationId,
  setPendingConfigForConversation,
  upsertConversation,
  retryConversation,
  } = useAgentConversations();
  const { settings: globalSettings } = useGlobalSettings();
  const goalModeBetaEnabled = globalSettings.features.goalModeBeta;
  const {
    activeWorkspaceId,
    activeWindowId,
    workspaceSession,
    updateWorkspaceSession,
    workspaceInfo,
  } = useWorkspace();
  const expandedComposerDraftId =
    expandedComposerDraftIdOverride ?? workspaceExpandedComposerDraftId;
  const setExpandedComposerDraft =
    setExpandedComposerDraftOverride ?? setWorkspaceExpandedComposerDraft;

  const conversation = conversationsById[conversationId] ?? null;
  const loadState = getConversationLoadStatus(conversationId);
  const composerState = getConversationComposerState(conversationId);
  const rawThreadEvents = eventsByConversationId[conversationId] ?? EMPTY_THREAD_EVENTS;
  const contextUsageRefreshGeneration = useMemo(
    () => computeContextUsageRefreshGeneration(rawThreadEvents),
    [rawThreadEvents]
  );
  const burnProgress = useMemo(
    () => latestBurnProgressStatus(rawThreadEvents, conversation?.status),
    [conversation?.status, rawThreadEvents]
  );
  const deferredThreadEvents = useDeferredValue(rawThreadEvents);
  const composerUserMessageHistory = useMemo(
    () => extractComposerUserMessageHistory(rawThreadEvents),
    [rawThreadEvents]
  );
  const threadMessages = useMemo(
    () =>
      projectAgentEventsToChatMessages(deferredThreadEvents, {
        backendId: conversation?.config.backendId,
        workspaceRoot: workspaceInfo?.root ?? null,
      }),
    [conversationId, conversation?.config.backendId, deferredThreadEvents, workspaceInfo?.root]
  );
  const dockedAsk = useMemo(
    () =>
      findDockedAskQuestion({
        events: rawThreadEvents,
        conversation,
      }),
    [conversation, rawThreadEvents]
  );
  const scrollMessages = useMemo(
    () => hideDockedAskFromScroll(threadMessages, dockedAsk),
    [dockedAsk, threadMessages]
  );
  const [submittingQuestion, setSubmittingQuestion] = useState(false);
  const historyCursor = useMemo(
    () => getConversationHistoryCursor(conversationId),
    [conversationId, getConversationHistoryCursor]
  );
  const activeBackend = useMemo(
    () => backends.find((backend) => backend.id === conversation?.config.backendId) ?? null,
    [backends, conversation?.config.backendId]
  );
  const dismissedCompletionErrorKey =
    workspaceSession.chat.dismissedCompletionErrorKeyByConversationId?.[conversationId];
  const completionErrorDock = useAgentCompletionErrorDock({
    conversation,
    events: rawThreadEvents,
    backend: activeBackend,
    dismissedKey: dismissedCompletionErrorKey,
    onDismiss: (dismissKey) => {
      updateWorkspaceSession((current) => ({
        ...current,
        chat: {
          ...current.chat,
          dismissedCompletionErrorKeyByConversationId: {
            ...current.chat.dismissedCompletionErrorKeyByConversationId,
            [conversationId]: dismissKey,
          },
        },
      }));
    },
    onRetry: async (targetConversationId) => {
      await retryConversation(targetConversationId);
    },
  });
  const restoredEditorChatScroll = useMemo(
    () =>
      resolvePersistedChatScroll(
        workspaceSession.chat.scrollTopByTabId,
        workspaceSession.chat.scrollAnchorByTabId ?? {},
        conversationId,
        activeWorkspaceId,
        activeWindowId,
        getActiveServerStorageKey(getConfiguredServerBaseUrl())
      ),
    [
      activeWindowId,
      activeWorkspaceId,
      conversationId,
      workspaceSession.chat.scrollAnchorByTabId,
      workspaceSession.chat.scrollTopByTabId,
    ]
  );

  const getRedoComposerSeed = useCallback(() => {
    const state = getConversationComposerState(conversationId);
    if (!state || !conversation) {
      throw new Error("Composer state unavailable for redo.");
    }
    return {
      backendId: state.backendId,
      mode: state.mode,
      model: state.model,
    };
  }, [conversation, conversationId, getConversationComposerState]);

  const exposeForkedConversationForRedo = useCallback(
    (forkedId: string, title: string) => {
      openAgentConversation({ conversationId: forkedId, title });
      updateWorkspaceSession((current) => {
        const removeIds = new Set([forkedId]);
        const nextHidden = current.chat.hiddenConversationIds.filter(
          (id) => !removeIds.has(id)
        );
        return nextHidden.length === current.chat.hiddenConversationIds.length
          ? current
          : {
              ...current,
              chat: {
                ...current.chat,
                hiddenConversationIds: nextHidden,
              },
            };
      });
    },
    [openAgentConversation, updateWorkspaceSession]
  );

  const promptRedoSubmit = useCallback(
    async (targetId: string, text: string, attachments?: ImageAttachment[]) =>
      promptConversation(targetId, text, attachments),
    [promptConversation]
  );

  const redoFlow = useRedoInlineUserMessage({
    conversation,
    getRedoComposerSeed,
    backends,
    modelVisibility: globalSettings.models.byBackend,
    goalModeBetaEnabled,
    composerUserMessageHistory,
    hasOlderHistory: historyCursor.hasOlder,
    onRequestOlderHistory: () => loadOlderConversationHistory(conversationId),
    mergeConversationSnapshot,
    refreshConversations,
    upsertConversation,
    promptConversationForActive: promptRedoSubmit,
    exposeForkedConversation: exposeForkedConversationForRedo,
  });
  useEffect(() => {
    if (loadState !== "ready" || !conversation) {
      return;
    }
    requestAnimationFrame(() => {
      markConversationSwitchVisible(conversationId, "editor_thread_visible");
    });
  }, [conversation, conversationId, loadState]);
  const composerDraftId = conversationId;
  useRegisterDesignCaptureComposer(composerDraftId, 8);
  const composerDraftTitle =
    conversation?.title && conversation.title !== "New chat" && !conversation.title.startsWith("Draft: ")
      ? `${conversation.title} prompt`
      : "Composer";
  const queuedPrompts = conversation?.queuedPrompts ?? [];
  const backendLabels = useMemo(
    () => Object.fromEntries(backends.map((backend) => [backend.id, backend.label ?? backend.id])),
    [backends]
  );
  const queueDockCollapsed = Boolean(
    workspaceSession.chat.composerQueueDockCollapsedByConversationId?.[conversationId]
  );
  const onQueueDockCollapsedChange = useCallback(
    (nextCollapsed: boolean) => {
      updateWorkspaceSession((current) => {
        const prev = current.chat.composerQueueDockCollapsedByConversationId ?? {};
        const m = { ...prev };
        if (nextCollapsed) {
          m[conversationId] = true;
        } else {
          delete m[conversationId];
        }
        return {
          ...current,
          chat: {
            ...current.chat,
            composerQueueDockCollapsedByConversationId: m,
          },
        };
      });
    },
    [conversationId, updateWorkspaceSession]
  );

  const removeQueuedPrompt = useCallback(
    (item: QueuedChatPrompt) => {
      void (async () => {
        try {
          const { conversation: nextConv } = await deleteAgentConversationQueueItem(
            conversationId,
            item.id
          );
          upsertConversation(nextConv);
        } catch {
          void syncConversationSnapshot(conversationId).catch(() => undefined);
        }
      })();
    },
    [conversationId, syncConversationSnapshot, upsertConversation]
  );
  const unqueuePromptToComposer = useCallback(
    (item: QueuedChatPrompt) => {
      void (async () => {
        try {
          const { conversation: nextConv } = await deleteAgentConversationQueueItem(
            conversationId,
            item.id
          );
          upsertConversation(nextConv);
        } catch {
          void syncConversationSnapshot(conversationId).catch(() => undefined);
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
      conversationId,
      syncConversationSnapshot,
      upsertComposerDraft,
      upsertConversation,
    ]
  );

  const editQueuedPrompt = useCallback(
    (item: QueuedChatPrompt) => {
      void (async () => {
        try {
          const { conversation: nextConv } = await deleteAgentConversationQueueItem(
            conversationId,
            item.id
          );
          upsertConversation(nextConv);
        } catch {
          void syncConversationSnapshot(conversationId).catch(() => undefined);
          return;
        }
        upsertComposerDraft(composerDraftId, {
          title: composerDraftTitle,
          content: item.text,
          attachments: item.attachments,
        });
        if (item.configOverride) {
          setPendingConfigForConversation(conversationId, item.configOverride);
        }
        updateWorkspaceSession((current) => ({
          ...current,
          chat: {
            ...current.chat,
            editingQueuedPromptIdByConversationId: {
              ...(current.chat.editingQueuedPromptIdByConversationId ?? {}),
              [conversationId]: item.id,
            },
          },
        }));
      })();
    },
    [
      composerDraftId,
      composerDraftTitle,
      conversationId,
      setPendingConfigForConversation,
      syncConversationSnapshot,
      updateWorkspaceSession,
      upsertComposerDraft,
      upsertConversation,
    ]
  );
  const isEmptyThread = threadMessages.length === 0;
  const composerDraftText = composerDrafts[composerDraftId]?.content ?? "";
  const composerDraftAttachments = composerDrafts[composerDraftId]?.attachments;
  const composerDraftCaptures = composerDrafts[composerDraftId]?.captures;
  const composerDraftTextReferences = composerDrafts[composerDraftId]?.textReferences;
  const composerSelection = composerSelections[composerDraftId] ?? {
    start: composerDraftText.length,
    end: composerDraftText.length,
  };
  const composerHiddenForExpanded = expandedComposerDraftId === composerDraftId;

  const recentConversations = useMemo(
    () =>
      conversations
        .filter(
          (candidate) =>
            candidate.id !== conversationId &&
            isRecentConversationCandidate(
              candidate.title,
              candidate.lastEventSeq,
              candidate.status === "running" || candidate.status === "awaiting_permission"
            )
        )
        .sort((a, b) => b.updatedAt - a.updatedAt),
    [conversationId, conversations]
  );
  const recentConversationPreview = useMemo(
    () => recentConversations.slice(0, 5),
    [recentConversations]
  );
const showRecentChatsSection =
  (conversation?.title === "New chat" || conversation?.title?.startsWith("Draft: ")) && recentConversationPreview.length > 0;

  useEffect(() => {
    if (loadState === "error") {
      return;
    }
    if (loadState === "ready") {
      return;
    }
    void syncConversationSnapshot(conversationId).catch(() => undefined);
  }, [conversationId, loadState, syncConversationSnapshot]);

  const recentChatsSection = showRecentChatsSection ? (
    <div className={`${EDITOR_CHAT_CONTENT_CLASS} flex flex-col gap-[2px]`}>
      <div className="flex items-center justify-end">
        <button
          type="button"
          onClick={() => setRecentChatsModalOpen(true)}
          className="rounded-[6px] p-[6px] text-[var(--text-secondary)] transition-colors hover:bg-[var(--bg-card-hover)] hover:text-[var(--text-primary)]"
          aria-label="Search recent chats"
        >
          <Search className="size-[14px]" strokeWidth={1.75} />
        </button>
      </div>
      {recentConversationPreview.map((candidate) => (
        <button
          key={candidate.id}
          type="button"
          onClick={() =>
            openAgentConversation({
              conversationId: candidate.id,
              title: candidate.title,
            })
          }
          className="flex items-center gap-[10px] rounded-[8px] px-[8px] py-[7px] text-left transition-colors hover:bg-[color-mix(in_srgb,var(--bg-card-hover)_75%,transparent)]"
        >
          <span className="min-w-0 flex-1 truncate font-sans text-[13px] font-normal text-[var(--text-primary)]">
            {candidate.title}
          </span>
          <span className="shrink-0 font-sans text-[11px] font-normal text-[var(--text-secondary)]">
            {formatRecentConversationTime(candidate.updatedAt)}
          </span>
        </button>
      ))}
    </div>
  ) : null;

  if (!conversation || !composerState) {
    if (!bootstrapped || loadState === "loading" || loadState === "idle") {
      return (
        <div className="flex h-full min-h-0 items-center justify-center px-6 text-center font-sans text-[13px] text-[var(--text-secondary)]">
          Loading chat...
        </div>
      );
    }
    return (
      <div className="flex h-full min-h-0 items-center justify-center px-6 text-center font-sans text-[13px] text-[var(--text-secondary)]">
        This chat could not be loaded. Reopen it from the agent panel.
      </div>
    );
  }

  const composer = (
    <div className={EDITOR_CHAT_CONTENT_CLASS}>
      <ChatComposer
        key={composerDraftId}
        mode={composerState.mode}
        onModeChange={(next) => {
          if (isOrchestrationModeLocked()) {
            return;
          }
          if (composerState.busy) {
            setPendingConfigForConversation(conversationId, { mode: next as EditorMode });
          } else {
            void setConversationMode(conversationId, next as EditorMode);
          }
        }}
        model={composerState.model}
        onModelChange={(next) => {
          if (composerState.busy) {
            const modelId = next.modelValue ?? next.id;
            setPendingConfigForConversation(conversationId, {
              modelId,
              modelName: next.name,
              setConfigOptions: next.configSelections,
            });
          } else {
            void setConversationModel(conversationId, next);
          }
        }}
        backendId={composerState.backendId}
        backends={backends}
        onBackendChange={(next) => {
          if (composerState.busy) {
            setPendingConfigForConversation(conversationId, { backendId: next });
          } else {
            void setConversationBackend(conversationId, next);
          }
        }}
        models={composerState.models}
        modeOptions={composerState.modeOptions}
        sessionConfigOptions={composerState.sessionConfigOptions}
        onSessionConfigOptionChange={(configId, value) =>
          void setConversationConfigOption(conversationId, configId, value)
        }
        value={composerDraftText}
        onValueChange={(next) => {
          upsertComposerDraft(composerDraftId, {
            title: composerDraftTitle,
            content: next,
          });
        }}
        selection={composerSelection}
        onSelectionChange={(next) => setComposerSelection(composerDraftId, next)}
        onExpandComposer={() => {
          setExpandedComposerDraft(composerDraftId);
          openComposerDraft({
            draftId: composerDraftId,
            title: composerDraftTitle,
            content: composerDraftText,
            attachments: composerDraftAttachments,
            captures: composerDraftCaptures,
            textReferences: composerDraftTextReferences,
          });
        }}
        busy={composerState.busy}
        configLocked={false}
        modeLocked={isOrchestrationModeLocked()}
        draftAttachments={composerDraftAttachments}
        onDraftAttachmentsChange={(next) =>
          upsertComposerDraft(composerDraftId, {
            title: composerDraftTitle,
            attachments: next,
          })
        }
        draftCaptures={composerDraftCaptures}
        onDraftCapturesChange={(next) =>
          upsertComposerDraft(composerDraftId, {
            title: composerDraftTitle,
            captures: next,
          })
        }
        draftTextReferences={composerDraftTextReferences}
        onDraftTextReferencesChange={(next) =>
          upsertComposerDraft(composerDraftId, {
            title: composerDraftTitle,
            textReferences: next,
          })
        }
        onSubmit={(text, attachments?: ImageAttachment[], options?: { delivery?: "normal" | "steer" }) => {
          const pendingConfig = pendingConfigByConversationId[conversationId];
          const derivedOverride =
            composerState.busy && conversation
              ? buildQueuedConfigOverride(
                  conversation.config,
                  composerState.backendId,
                  composerState.mode,
                  composerState.model
                )
              : undefined;
          const mergedOverride = { ...derivedOverride, ...pendingConfig };
          const configOverride =
            composerState.busy && Object.keys(mergedOverride).length > 0
              ? mergedOverride
              : undefined;
          void promptConversation(
            conversationId,
            text,
            attachments,
            configOverride,
            options?.delivery
          ).then((ok) => {
            if (!ok) {
              return;
            }
            updateWorkspaceSession((current) => ({
              ...current,
              chat: {
                ...current.chat,
                tabs: current.chat.tabs.some((tab) => tab.id === conversationId)
                  ? current.chat.tabs
                  : [
                      ...current.chat.tabs.map((tab) => ({ ...tab, active: false })),
                      {
                        id: conversationId,
                        title: conversation.title,
                        active: true,
                      },
                    ],
                hiddenConversationIds: current.chat.hiddenConversationIds.filter(
                  (id) => id !== conversationId
                ),
              },
            }));
          });
        }}
        onCancel={() => cancelConversation(conversationId)}
        onPause={() => pauseConversation(conversationId)}
        onResume={() => resumeConversation(conversationId)}
        conversationStatus={conversation.status}
        burnProgress={burnProgress}
        conversationId={conversationId}
        contextUsageRefreshGeneration={contextUsageRefreshGeneration}
        layout={isEmptyThread ? "empty-top" : "docked-bottom"}
        userMessageHistory={composerUserMessageHistory}
        hasMoreOlderUserMessageHistory={historyCursor.hasOlder}
        onRequestOlderUserMessageHistory={() =>
          loadOlderConversationHistory(conversationId)
        }
      />
    </div>
  );

  return (
    <div className="flex h-full min-h-0 w-full flex-col overflow-hidden bg-[var(--bg-main)] @container">
      {isEmptyThread ? (
        <div className="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden">
          {!composerHiddenForExpanded ? (
            <div className="shrink-0">
              {queuedPrompts.length > 0 ? (
                <div className={EDITOR_CHAT_CONTENT_CLASS}>
                  <ComposerQueueDock
                    items={queuedPrompts}
                    onDelete={removeQueuedPrompt}
                    onUnqueue={unqueuePromptToComposer}
                    onEdit={editQueuedPrompt}
                    conversationConfig={conversation?.config}
                    backendLabels={backendLabels}
                    collapsed={queueDockCollapsed}
                    onCollapsedChange={onQueueDockCollapsedChange}
                  />
                </div>
              ) : null}
              <AgentCompletionErrorDock
                dock={completionErrorDock}
                insetClassName={EDITOR_CHAT_INSET_X_CLASS}
                contentClassName={EDITOR_CHAT_CONTENT_CLASS}
              />
              {composer}
            </div>
          ) : null}
          <div
            className={`min-h-0 flex-1 bg-[var(--bg-main)] ${EDITOR_CHAT_INSET_X_CLASS} pb-[16px] pt-[12px]`}
          >
            {recentChatsSection ? (
              <div className="flex h-full flex-col justify-end">
                {recentChatsSection}
              </div>
            ) : null}
          </div>
        </div>
      ) : (
        <div className="relative min-h-0 min-w-0 flex-1 overflow-hidden">
          <MessageList
            key={conversationId}
            messages={scrollMessages}
            surface="editor"
            contentClassName={EDITOR_CHAT_CONTENT_CLASS}
            conversationId={conversationId}
            composerDraftId={composerDraftId}
            conversationBusy={
              conversation
                ? isAgentComposerBusy(conversation, eventsByConversationId[conversationId]) ||
                  conversation.status === "awaiting_permission"
                : false
            }
            hasOlderHistory={historyCursor.hasOlder}
            loadingOlderHistory={historyCursor.loadingOlder}
            onRequestOlderHistory={() => loadOlderConversationHistory(conversationId)}
            initialScrollTop={
              restoredEditorChatScroll.mode === "restore" &&
              restoredEditorChatScroll.scrollTop !== undefined
                ? restoredEditorChatScroll.scrollTop
                : undefined
            }
            onScrollTopSettled={(scrollTop, meta: MessageListScrollPersistMeta) => {
              updateWorkspaceSession((current) => {
                const map = current.chat.scrollTopByTabId;
                const anchorMap = { ...(current.chat.scrollAnchorByTabId ?? {}) };
                const hadTop = Object.hasOwn(map, conversationId);
                if (meta.pinnedToBottom) {
                  if (!hadTop && !Object.hasOwn(anchorMap, conversationId)) {
                    return current;
                  }
                  const nextMap = { ...map };
                  delete nextMap[conversationId];
                  delete anchorMap[conversationId];
                  return {
                    ...current,
                    chat: {
                      ...current.chat,
                      scrollTopByTabId: nextMap,
                      scrollAnchorByTabId: anchorMap,
                    },
                  };
                }
                if (meta.anchor) {
                  anchorMap[conversationId] = meta.anchor;
                } else {
                  delete anchorMap[conversationId];
                }
                const prevTop = map[conversationId];
                const prevAnchor = current.chat.scrollAnchorByTabId?.[conversationId];
                const topClose = hadTop && Math.abs((prevTop ?? 0) - scrollTop) < 0.5;
                const anchorClose =
                  meta.anchor && prevAnchor
                    ? meta.anchor.messageId === prevAnchor.messageId &&
                      Math.abs(meta.anchor.delta - prevAnchor.delta) < 0.35
                    : meta.anchor == null && prevAnchor == null;
                if (topClose && anchorClose) {
                  return current;
                }
                return {
                  ...current,
                  chat: {
                    ...current.chat,
                    scrollTopByTabId: {
                      ...map,
                      [conversationId]: scrollTop,
                    },
                    scrollAnchorByTabId: anchorMap,
                  },
                };
              });
            }}
            onResolvePermission={(requestId, optionId) => {
              void answerPermissionForConversation(conversationId, requestId, optionId);
            }}
            onForkMessage={redoFlow.handleForkMessage}
            onRedoMessage={redoFlow.handleStartRedoMessage}
            renderUserMessageEditor={redoFlow.renderRedoMessageEditor}
            editingUserMessageId={redoFlow.editingUserMessageId}
            bottomDockVisible={!composerHiddenForExpanded}
          />
          {!composerHiddenForExpanded ? (
            <div className="pointer-events-none absolute inset-x-0 bottom-0 z-30">
              <div className="pointer-events-auto chat-bottom-dock">
                {recentChatsSection ? (
                  <div className={`${EDITOR_CHAT_INSET_X_CLASS} pt-[8px]`}>
                    {recentChatsSection}
                  </div>
                ) : null}
                {dockedAsk ? (
                  <div className={`${EDITOR_CHAT_INSET_X_CLASS} pt-[8px]`}>
                    <div className={EDITOR_CHAT_CONTENT_CLASS}>
                      <AskQuestionCard
                        steps={dockedAsk.steps}
                        dockAboveComposer
                        submitting={submittingQuestion}
                        onSubmit={async (answer) => {
                          setSubmittingQuestion(true);
                          try {
                            await answerQuestionForConversation(
                              conversationId,
                              dockedAsk.questionId,
                              answer
                            );
                          } finally {
                            setSubmittingQuestion(false);
                          }
                        }}
                      />
                    </div>
                  </div>
                ) : null}
                {queuedPrompts.length > 0 ? (
                  <div className={`${EDITOR_CHAT_INSET_X_CLASS} pt-[8px]`}>
                    <div className={EDITOR_CHAT_CONTENT_CLASS}>
                      <ComposerQueueDock
                        items={queuedPrompts}
                        onDelete={removeQueuedPrompt}
                        onUnqueue={unqueuePromptToComposer}
                        onEdit={editQueuedPrompt}
                        conversationConfig={conversation?.config}
                        backendLabels={backendLabels}
                        collapsed={queueDockCollapsed}
                        onCollapsedChange={onQueueDockCollapsedChange}
                      />
                    </div>
                  </div>
                ) : null}
                <AgentCompletionErrorDock
                  dock={completionErrorDock}
                  insetClassName={EDITOR_CHAT_INSET_X_CLASS}
                  contentClassName={EDITOR_CHAT_CONTENT_CLASS}
                />
                {composer}
              </div>
            </div>
          ) : null}
        </div>
      )}
      <RecentChatsModal
        open={recentChatsModalOpen}
        onClose={() => setRecentChatsModalOpen(false)}
        items={recentConversations.map((conversation) => ({
          id: conversation.id,
          title: conversation.title,
          updatedAt: conversation.updatedAt,
        }))}
        onSelectConversation={(selectedConversationId) => {
          const selectedConversation = recentConversations.find(
            (candidate) => candidate.id === selectedConversationId
          );
          if (!selectedConversation) {
            return;
          }
          openAgentConversation({
            conversationId: selectedConversationId,
            title: selectedConversation.title,
          });
        }}
      />
    </div>
  );
}
