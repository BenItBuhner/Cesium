"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { Search } from "lucide-react";
import { ChatComposer } from "@/components/chat/ChatComposer";
import { ComposerQueueDock } from "@/components/chat/ComposerQueueDock";
import { AskQuestionCard } from "@/components/chat/AskQuestionCard";
import { MessageList } from "@/components/chat/MessageList";
import { useOpenInEditor } from "@/components/editor/OpenInEditorContext";
import { RecentChatsModal } from "@/components/ide/RecentChatsModal";
import { projectAgentEventsToChatMessages } from "@/lib/agent-chat";
import { askStepsFromMessage } from "@/lib/ask-question-utils";
import { useAgentConversations } from "@/components/chat/AgentConversationsContext";
import type { AgentBackendId } from "@/lib/agent-types";
import type { EditorMode, ImageAttachment, QueuedChatPrompt } from "@/lib/types";
import { useWorkspace } from "@/contexts/WorkspaceContext";
import {
  EDITOR_CHAT_CONTENT_CLASS,
  EDITOR_CHAT_INSET_X_CLASS,
} from "./agent-chat-layout";

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
  return lastEventSeq > 0 || busy;
}

interface AgentConversationViewProps {
  conversationId: string;
  expandedComposerDraftId?: string | null;
  setExpandedComposerDraft?: (draftId: string | null) => void;
}

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
    setExpandedComposerController,
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
    cancelPermissionForConversation,
    getConversationComposerState,
    promptConversation,
    cancelConversation,
    setConversationMode,
    setConversationModel,
    setConversationBackend,
    setConversationConfigOption,
    syncConversationSnapshot,
  } = useAgentConversations();
  const { workspaceSession, updateWorkspaceSession } = useWorkspace();
  const expandedComposerDraftId =
    expandedComposerDraftIdOverride ?? workspaceExpandedComposerDraftId;
  const setExpandedComposerDraft =
    setExpandedComposerDraftOverride ?? setWorkspaceExpandedComposerDraft;
  const shouldProvideExpandedComposerController =
    expandedComposerDraftIdOverride !== undefined ||
    setExpandedComposerDraftOverride !== undefined;

  const conversation = conversationsById[conversationId] ?? null;
  const loadState = getConversationLoadStatus(conversationId);
  const composerState = getConversationComposerState(conversationId);
  const threadMessages = useMemo(
    () =>
      projectAgentEventsToChatMessages(eventsByConversationId[conversationId] ?? [], {
        backendId: conversation?.config.backendId,
      }),
    [conversationId, conversation?.config.backendId, eventsByConversationId]
  );
  const { scrollMessages, dockedAsk } = useMemo(
    () => partitionMessagesForDock(threadMessages),
    [threadMessages]
  );
  const dockedAskSteps = useMemo(
    () => (dockedAsk ? askStepsFromMessage(dockedAsk) : []),
    [dockedAsk]
  );
  const composerDraftId = conversationId;
  const composerDraftTitle =
    conversation?.title && conversation.title !== "New chat"
      ? `${conversation.title} prompt`
      : "Composer";
  const queuedPrompts = useMemo(
    () => workspaceSession.chat.queuedPromptsByConversationId?.[conversationId] ?? [],
    [conversationId, workspaceSession.chat.queuedPromptsByConversationId]
  );
  const removeQueuedPrompt = useCallback(
    (item: QueuedChatPrompt) => {
      updateWorkspaceSession((current) => {
        const map = { ...(current.chat.queuedPromptsByConversationId ?? {}) };
        const list = map[conversationId];
        if (!list) {
          return current;
        }
        const next = list.filter((p) => p.id !== item.id);
        if (next.length === 0) {
          delete map[conversationId];
        } else {
          map[conversationId] = next;
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
    [conversationId, updateWorkspaceSession]
  );
  const unqueuePromptToComposer = useCallback(
    (item: QueuedChatPrompt) => {
      removeQueuedPrompt(item);
      upsertComposerDraft(composerDraftId, {
        title: composerDraftTitle,
        content: item.text,
      });
    },
    [
      composerDraftId,
      composerDraftTitle,
      removeQueuedPrompt,
      upsertComposerDraft,
    ]
  );
  const isEmptyThread = threadMessages.length === 0;
  const composerDraftText = composerDrafts[composerDraftId]?.content ?? "";
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
    conversation?.title === "New chat" && recentConversationPreview.length > 0;

  useEffect(() => {
    if (conversation || loadState === "loading") {
      return;
    }
    void syncConversationSnapshot(conversationId).catch(() => undefined);
  }, [conversation, conversationId, loadState, syncConversationSnapshot]);

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
        onModeChange={(next) => void setConversationMode(conversationId, next as EditorMode)}
        model={composerState.model}
        onModelChange={(next) => void setConversationModel(conversationId, next)}
        backendId={composerState.backendId}
        backends={backends}
        onBackendChange={(next) => void setConversationBackend(conversationId, next)}
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
          });
        }}
        busy={composerState.busy}
        configLocked={false}
        onSubmit={(text, attachments?: ImageAttachment[]) => {
          void promptConversation(conversationId, text, attachments).then((ok) => {
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
        layout={isEmptyThread ? "empty-top" : "docked-bottom"}
      />
    </div>
  );

  const expandedComposerState = useMemo(() => {
    if (
      !shouldProvideExpandedComposerController ||
      expandedComposerDraftId !== composerDraftId ||
      !conversation ||
      !composerState
    ) {
      return null;
    }
    return {
      draftId: composerDraftId,
      title: composerDraftTitle,
      mode: composerState.mode,
      onModeChange: (next: EditorMode) =>
        void setConversationMode(conversationId, next),
      model: composerState.model,
      onModelChange: (next: typeof composerState.model) =>
        void setConversationModel(conversationId, next),
      backendId: composerState.backendId,
      backends,
      onBackendChange: (next: AgentBackendId) =>
        void setConversationBackend(conversationId, next),
      models: composerState.models,
      modeOptions: composerState.modeOptions,
      sessionConfigOptions: composerState.sessionConfigOptions,
      onSessionConfigOptionChange: (configId: string, value: string) =>
        void setConversationConfigOption(conversationId, configId, value),
      onSubmit: (text: string, attachments?: ImageAttachment[]) =>
        promptConversation(conversationId, text, attachments),
      onCancel: () => cancelConversation(conversationId),
      busy: composerState.busy,
      configLocked: false,
    };
  }, [
    backends,
    cancelConversation,
    composerDraftId,
    composerDraftTitle,
    composerState,
    conversation,
    conversationId,
    expandedComposerDraftId,
    promptConversation,
    setConversationBackend,
    setConversationConfigOption,
    setConversationMode,
    setConversationModel,
    shouldProvideExpandedComposerController,
  ]);

  useEffect(() => {
    if (!shouldProvideExpandedComposerController) {
      return;
    }
    setExpandedComposerController(expandedComposerState);
    return () => {
      setExpandedComposerController(null);
    };
  }, [
    expandedComposerState,
    setExpandedComposerController,
    shouldProvideExpandedComposerController,
  ]);

  return (
    <div className="flex h-full min-h-0 w-full flex-col overflow-hidden bg-[var(--bg-main)]">
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
                  />
                </div>
              ) : null}
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
            conversationBusy={
              conversation?.status === "running" ||
              conversation?.status === "awaiting_permission"
            }
            initialScrollTop={workspaceSession.chat.scrollTopByTabId[conversationId] ?? 0}
            onScrollTopSettled={(scrollTop) => {
              updateWorkspaceSession((current) =>
                Math.abs(
                  (current.chat.scrollTopByTabId[conversationId] ?? 0) - scrollTop
                ) < 1
                  ? current
                  : {
                      ...current,
                      chat: {
                        ...current.chat,
                        scrollTopByTabId: {
                          ...current.chat.scrollTopByTabId,
                          [conversationId]: scrollTop,
                        },
                      },
                    }
              );
            }}
            onResolvePermission={(requestId, optionId) => {
              void answerPermissionForConversation(conversationId, requestId, optionId);
            }}
            onCancelPermission={(requestId) => {
              void cancelPermissionForConversation(conversationId, requestId);
            }}
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
                {dockedAskSteps.length > 0 ? (
                  <div className={`${EDITOR_CHAT_INSET_X_CLASS} pt-[8px]`}>
                    <div className={EDITOR_CHAT_CONTENT_CLASS}>
                      <AskQuestionCard steps={dockedAskSteps} dockAboveComposer />
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
                      />
                    </div>
                  </div>
                ) : null}
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
