"use client";

import { useMemo, useState } from "react";
import { Search } from "lucide-react";
import { ChatComposer } from "@/components/chat/ChatComposer";
import { AskQuestionCard } from "@/components/chat/AskQuestionCard";
import { MessageList } from "@/components/chat/MessageList";
import { PermissionRequestCard } from "@/components/chat/PermissionRequestCard";
import { useOpenInEditor } from "@/components/editor/OpenInEditorContext";
import { RecentChatsModal } from "@/components/ide/RecentChatsModal";
import {
  agentPermissionOptionsToUiChoices,
  projectAgentEventsToChatMessages,
} from "@/lib/agent-chat";
import { askStepsFromMessage } from "@/lib/ask-question-utils";
import { useAgentConversations } from "@/components/chat/AgentConversationsContext";
import type { EditorMode } from "@/lib/types";
import { useWorkspace } from "@/contexts/WorkspaceContext";

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

export function AgentConversationView({
  conversationId,
}: {
  conversationId: string;
}) {
  const [recentChatsModalOpen, setRecentChatsModalOpen] = useState(false);
  const {
    composerDrafts,
    composerSelections,
    openAgentConversation,
    upsertComposerDraft,
    setComposerSelection,
    openComposerDraft,
    expandedComposerDraftId,
    setExpandedComposerDraft,
  } = useOpenInEditor();
  const {
    backends,
    conversations,
    conversationsById,
    eventsByConversationId,
    answerPermissionForConversation,
    cancelPermissionForConversation,
    getConversationComposerState,
    promptConversation,
    cancelConversation,
    setConversationMode,
    setConversationModel,
    setConversationBackend,
    setConversationConfigOption,
  } = useAgentConversations();
  const { workspaceSession, updateWorkspaceSession } = useWorkspace();

  const conversation = conversationsById[conversationId] ?? null;
  const composerState = getConversationComposerState(conversationId);
  const threadMessages = useMemo(
    () => projectAgentEventsToChatMessages(eventsByConversationId[conversationId] ?? []),
    [conversationId, eventsByConversationId]
  );
  const { scrollMessages, dockedAsk } = useMemo(
    () => partitionMessagesForDock(threadMessages),
    [threadMessages]
  );
  const dockedAskSteps = useMemo(
    () => (dockedAsk ? askStepsFromMessage(dockedAsk) : []),
    [dockedAsk]
  );
  const isEmptyThread = threadMessages.length === 0;
  const composerDraftId = conversationId;
  const composerDraftTitle =
    conversation?.title && conversation.title !== "New chat"
      ? `${conversation.title} prompt`
      : "Composer";
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

  const pendingPermissionDock = useMemo(() => {
    const pending = conversation?.pendingPermission;
    if (!pending || !conversation) {
      return null;
    }
    return (
      <div className="border-t border-[var(--border-card)] bg-[var(--bg-main)]/94 px-[clamp(20px,5vw,56px)] pb-[12px] pt-[10px] backdrop-blur-[10px]">
        <div className="mx-auto w-full max-w-[min(980px,calc(100%-8px))]">
          <PermissionRequestCard
            title={pending.title ?? "Permission required"}
            detail={pending.detail}
            options={agentPermissionOptionsToUiChoices(pending.options ?? [])}
            onSelect={(optionId) => {
              void answerPermissionForConversation(
                conversation.id,
                pending.requestId,
                optionId
              );
            }}
          />
          <div className="mt-[8px] flex justify-end">
            <button
              type="button"
              className="font-sans text-[11px] text-[var(--text-secondary)] underline decoration-dotted underline-offset-2 hover:text-[var(--text-primary)]"
              onClick={() =>
                void cancelPermissionForConversation(
                  conversation.id,
                  pending.requestId
                )
              }
            >
              Cancel request
            </button>
          </div>
        </div>
      </div>
    );
  }, [
    answerPermissionForConversation,
    cancelPermissionForConversation,
    conversation,
  ]);

  const recentChatsSection = showRecentChatsSection ? (
    <div className="mx-auto flex w-full max-w-[min(980px,calc(100%-8px))] flex-col gap-[2px]">
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
    return (
      <div className="flex h-full min-h-0 items-center justify-center px-6 text-center font-sans text-[13px] text-[var(--text-secondary)]">
        This chat could not be loaded. Reopen it from the agent panel.
      </div>
    );
  }

  const composer = (
    <div className="mx-auto w-full max-w-[min(980px,calc(100%-8px))]">
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
        onSubmit={async (text) => {
          const ok = await promptConversation(conversationId, text);
          if (ok) {
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
          }
        }}
        onCancel={() => cancelConversation(conversationId)}
        layout={isEmptyThread ? "empty-top" : "docked-bottom"}
      />
    </div>
  );

  return (
    <div className="flex h-full min-h-0 w-full flex-col overflow-hidden bg-[var(--bg-main)]">
      {isEmptyThread ? (
        <div className="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden">
          {!composerHiddenForExpanded ? (
            <div className="shrink-0">
              {pendingPermissionDock}
              {composer}
            </div>
          ) : null}
          <div className="min-h-0 flex-1 bg-[var(--bg-main)] px-[clamp(20px,5vw,56px)] pb-[16px] pt-[12px]">
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
            contentClassName="mx-auto w-full max-w-[min(980px,calc(100%-8px))]"
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
            bottomDockVisible={!composerHiddenForExpanded}
          />
          {!composerHiddenForExpanded ? (
            <div className="pointer-events-none absolute inset-x-0 bottom-0 z-30">
              <div className="pointer-events-auto chat-bottom-dock">
                {pendingPermissionDock ? (
                  <div className="pointer-events-auto">{pendingPermissionDock}</div>
                ) : null}
                {recentChatsSection ? (
                  <div className="px-[clamp(20px,5vw,56px)] pt-[8px]">
                    {recentChatsSection}
                  </div>
                ) : null}
                {dockedAskSteps.length > 0 ? (
                  <div className="px-[clamp(20px,5vw,56px)] pt-[8px]">
                    <div className="mx-auto w-full max-w-[min(980px,calc(100%-8px))]">
                      <AskQuestionCard steps={dockedAskSteps} dockAboveComposer />
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
        conversations={recentConversations}
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
