"use client";

import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type MouseEvent,
} from "react";
import { ChatTabs } from "./ChatTabs";
import { MessageList } from "./MessageList";
import { ChatComposer } from "./ChatComposer";
import { AskQuestionCard } from "./AskQuestionCard";
import { askStepsFromMessage } from "@/lib/ask-question-utils";
import {
  buildConversationModeOptions,
  buildConversationModelOptions,
  getConversationLatestSeq,
  projectAgentEventsToChatMessages,
  resolveConversationModel,
} from "@/lib/agent-chat";
import { DEFAULT_MODE_OPTIONS } from "@/lib/chat-modes";
import { listSupplementaryAgentConfigOptions } from "@/lib/agent-config-option-utils";
import { useWorkbenchContextMenu } from "@/components/ide/WorkbenchContextMenuProvider";
import type { WorkbenchMenuItem } from "@/components/ide/workbench-context-menu-types";
import type {
  AgentBackendId,
  AgentBackendInfo,
  AgentConversationRecord,
  AgentConversationSnapshot,
  AgentSocketServerMessage,
  AgentStoredEvent,
} from "@/lib/agent-types";
import type { ChatMessage, ChatTab, EditorMode, ModelInfo } from "@/lib/types";
import { useWorkspace } from "@/contexts/WorkspaceContext";
import { JsonWebSocket } from "@/lib/ws-client";
import {
  answerAgentPermission,
  buildAgentWebSocketUrl,
  cancelAgentConversation,
  createAgentConversation,
  fetchAgentConversationSnapshot,
  listAgentConversations,
  promptAgentConversation,
  updateAgentConversationConfig,
} from "@/lib/server-api";

function partitionMessagesForDock(messages: ChatMessage[]): {
  scrollMessages: ChatMessage[];
  dockedAsk: ChatMessage | null;
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

function tabsEqual(a: ChatTab[], b: ChatTab[]): boolean {
  if (a.length !== b.length) {
    return false;
  }
  return a.every(
    (tab, index) =>
      tab.id === b[index]?.id &&
      tab.title === b[index]?.title &&
      Boolean(tab.active) === Boolean(b[index]?.active)
  );
}

function toConversationMap(
  conversations: AgentConversationRecord[]
): Record<string, AgentConversationRecord> {
  return Object.fromEntries(
    conversations.map((conversation) => [conversation.id, conversation])
  );
}

export function ChatPanel() {
  const { openAt } = useWorkbenchContextMenu();
  const {
    activeWorkspaceId,
    workspaceSession,
    updateWorkspaceSession,
  } = useWorkspace();
  const [backends, setBackends] = useState<AgentBackendInfo[]>([]);
  const [conversationsById, setConversationsById] = useState<
    Record<string, AgentConversationRecord>
  >({});
  const [eventsByConversationId, setEventsByConversationId] = useState<
    Record<string, AgentStoredEvent[]>
  >({});
  const socketRef = useRef<JsonWebSocket<AgentSocketServerMessage> | null>(null);
  const chatDraftRef = useRef(workspaceSession.chat);
  const tabsRef = useRef<ChatTab[]>(workspaceSession.chat.tabs);
  const eventsRef = useRef(eventsByConversationId);

  const tabs = workspaceSession.chat.tabs;

  useEffect(() => {
    chatDraftRef.current = workspaceSession.chat;
  }, [workspaceSession.chat]);

  useEffect(() => {
    tabsRef.current = tabs;
  }, [tabs]);

  useEffect(() => {
    eventsRef.current = eventsByConversationId;
  }, [eventsByConversationId]);

  const setTabs = useCallback(
    (updater: (current: ChatTab[]) => ChatTab[]) => {
      updateWorkspaceSession((current) => ({
        ...current,
        chat: {
          ...current.chat,
          tabs: updater(current.chat.tabs),
        },
      }));
    },
    [updateWorkspaceSession]
  );

  const hideConversationIds = useCallback(
    (conversationIds: string[]) => {
      if (conversationIds.length === 0) {
        return;
      }
      updateWorkspaceSession((current) => {
        const nextHidden = new Set(current.chat.hiddenConversationIds);
        for (const conversationId of conversationIds) {
          if (conversationId) {
            nextHidden.add(conversationId);
          }
        }
        const normalized = Array.from(nextHidden);
        return normalized.length === current.chat.hiddenConversationIds.length &&
          normalized.every((value, index) => value === current.chat.hiddenConversationIds[index])
          ? current
          : {
              ...current,
              chat: {
                ...current.chat,
                hiddenConversationIds: normalized,
              },
            };
      });
    },
    [updateWorkspaceSession]
  );

  const unhideConversationIds = useCallback(
    (conversationIds: string[]) => {
      if (conversationIds.length === 0) {
        return;
      }
      updateWorkspaceSession((current) => {
        const remove = new Set(conversationIds);
        const nextHidden = current.chat.hiddenConversationIds.filter(
          (conversationId) => !remove.has(conversationId)
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
    [updateWorkspaceSession]
  );

  const setMode = useCallback(
    async (next: EditorMode) => {
      updateWorkspaceSession((current) => ({
        ...current,
        chat: {
          ...current.chat,
          mode: next,
        },
      }));
      const activeId = tabsRef.current.find((tab) => tab.active)?.id;
      if (!activeId) {
        return;
      }
      try {
        const updated = await updateAgentConversationConfig(activeId, { mode: next });
        setConversationsById((current) => ({
          ...current,
          [updated.conversation.id]: updated.conversation,
        }));
      } catch {
        void fetchAgentConversationSnapshot(activeId)
          .then((result) => {
            setConversationsById((current) => ({
              ...current,
              [result.snapshot.conversation.id]: result.snapshot.conversation,
            }));
            setEventsByConversationId((current) => ({
              ...current,
              [result.snapshot.conversation.id]: result.snapshot.events,
            }));
          })
          .catch(() => undefined);
      }
    },
    [updateWorkspaceSession]
  );

  const setModel = useCallback(
    async (next: ModelInfo) => {
      updateWorkspaceSession((current) => ({
        ...current,
        chat: {
          ...current.chat,
          model: next,
        },
      }));
      const activeId = tabsRef.current.find((tab) => tab.active)?.id;
      if (!activeId) {
        return;
      }
      try {
        const updated = await updateAgentConversationConfig(activeId, {
          modelId: next.id,
          modelName: next.name,
        });
        setConversationsById((current) => ({
          ...current,
          [updated.conversation.id]: updated.conversation,
        }));
      } catch {
        void fetchAgentConversationSnapshot(activeId)
          .then((result) => {
            setConversationsById((current) => ({
              ...current,
              [result.snapshot.conversation.id]: result.snapshot.conversation,
            }));
            setEventsByConversationId((current) => ({
              ...current,
              [result.snapshot.conversation.id]: result.snapshot.events,
            }));
          })
          .catch(() => undefined);
      }
    },
    [updateWorkspaceSession]
  );

  const setSessionConfigOption = useCallback(async (configId: string, value: string) => {
    const activeId = tabsRef.current.find((tab) => tab.active)?.id;
    if (!activeId) {
      return;
    }
    try {
      const updated = await updateAgentConversationConfig(activeId, {
        setConfigOption: { configId, value },
      });
      setConversationsById((current) => ({
        ...current,
        [updated.conversation.id]: updated.conversation,
      }));
    } catch {
      void fetchAgentConversationSnapshot(activeId)
        .then((result) => {
          setConversationsById((current) => ({
            ...current,
            [result.snapshot.conversation.id]: result.snapshot.conversation,
          }));
          setEventsByConversationId((current) => ({
            ...current,
            [result.snapshot.conversation.id]: result.snapshot.events,
          }));
        })
        .catch(() => undefined);
    }
  }, []);

  const setBackend = useCallback(
    async (backendId: AgentBackendId) => {
      updateWorkspaceSession((current) => ({
        ...current,
        chat: {
          ...current.chat,
          backendId,
        },
      }));
      const activeId = tabsRef.current.find((tab) => tab.active)?.id;
      if (!activeId) {
        return;
      }
      try {
        const updated = await updateAgentConversationConfig(activeId, { backendId });
        setConversationsById((current) => ({
          ...current,
          [updated.conversation.id]: updated.conversation,
        }));
      } catch {
        void fetchAgentConversationSnapshot(activeId)
          .then((result) => {
            setConversationsById((current) => ({
              ...current,
              [result.snapshot.conversation.id]: result.snapshot.conversation,
            }));
            setEventsByConversationId((current) => ({
              ...current,
              [result.snapshot.conversation.id]: result.snapshot.events,
            }));
          })
          .catch(() => undefined);
      }
    },
    [updateWorkspaceSession]
  );

  const mergeSnapshot = useCallback((snapshot: AgentConversationSnapshot) => {
    setConversationsById((current) => ({
      ...current,
      [snapshot.conversation.id]: snapshot.conversation,
    }));
    setEventsByConversationId((current) => {
      const existing = current[snapshot.conversation.id] ?? [];
      const existingSeq = existing.at(-1)?.seq ?? 0;
      const incomingSeq = snapshot.events.at(-1)?.seq ?? 0;
      return {
        ...current,
        [snapshot.conversation.id]:
          incomingSeq >= existingSeq ? snapshot.events : existing,
      };
    });
    updateWorkspaceSession((current) => {
      const nextTabs = current.chat.tabs.map((tab) =>
        tab.id === snapshot.conversation.id
          ? { ...tab, title: snapshot.conversation.title }
          : tab
      );
      return tabsEqual(current.chat.tabs, nextTabs)
        ? current
        : {
            ...current,
            chat: {
              ...current.chat,
              tabs: nextTabs,
            },
          };
    });
  }, [updateWorkspaceSession]);

  const appendConversationEvent = useCallback(
    (conversationId: string, event: AgentStoredEvent) => {
      setEventsByConversationId((current) => {
        const existing = current[conversationId] ?? [];
        if (existing.some((item) => item.seq === event.seq)) {
          return current;
        }
        return {
          ...current,
          [conversationId]: [...existing, event].sort((a, b) => a.seq - b.seq),
        };
      });
    },
    []
  );

  const upsertConversation = useCallback(
    (conversation: AgentConversationRecord) => {
      setConversationsById((current) => ({
        ...current,
        [conversation.id]: conversation,
      }));
      updateWorkspaceSession((current) => {
        const nextTabs = current.chat.tabs.map((tab) =>
          tab.id === conversation.id ? { ...tab, title: conversation.title } : tab
        );
        return tabsEqual(current.chat.tabs, nextTabs)
          ? current
          : {
              ...current,
              chat: {
                ...current.chat,
                tabs: nextTabs,
              },
            };
      });
    },
    [updateWorkspaceSession]
  );

  const createConversationAndOpen = useCallback(async () => {
    const created = await createAgentConversation({
      backendId: workspaceSession.chat.backendId,
      mode: workspaceSession.chat.mode,
      modelId: workspaceSession.chat.model.id,
      modelName: workspaceSession.chat.model.name,
    });
    const { conversation } = created;
    setConversationsById((current) => ({
      ...current,
      [conversation.id]: conversation,
    }));
    setEventsByConversationId((current) => ({
      ...current,
      [conversation.id]: current[conversation.id] ?? [],
    }));
    setTabs((current) => [
      ...current.map((tab) => ({ ...tab, active: false })),
      { id: conversation.id, title: conversation.title, active: true },
    ]);
    unhideConversationIds([conversation.id]);
    return conversation;
  }, [
    setTabs,
    unhideConversationIds,
    workspaceSession.chat.backendId,
    workspaceSession.chat.mode,
    workspaceSession.chat.model.id,
    workspaceSession.chat.model.name,
  ]);

  const activeTabId = useMemo(
    () => tabs.find((tab) => tab.active)?.id ?? tabs[0]?.id ?? "__empty__",
    [tabs]
  );
  const activeConversation = activeTabId ? conversationsById[activeTabId] ?? null : null;
  const threadMessages = useMemo(
    () =>
      projectAgentEventsToChatMessages(
        activeTabId ? eventsByConversationId[activeTabId] ?? [] : []
      ),
    [activeTabId, eventsByConversationId]
  );
  const isEmptyThread = threadMessages.length === 0;
  const mode = (activeConversation?.config.mode ??
    workspaceSession.chat.mode) as EditorMode;
  const model = activeConversation
    ? resolveConversationModel(activeConversation, backends)
    : workspaceSession.chat.model;
  const backendId =
    activeConversation?.config.backendId ?? workspaceSession.chat.backendId;
  const models = activeConversation
    ? buildConversationModelOptions(activeConversation, backends)
    : [workspaceSession.chat.model];
  const modeOptions = useMemo(
    () =>
      activeConversation
        ? buildConversationModeOptions(activeConversation)
        : DEFAULT_MODE_OPTIONS,
    [activeConversation]
  );
  const sessionConfigOptions = useMemo(
    () =>
      activeConversation ? listSupplementaryAgentConfigOptions(activeConversation) : [],
    [activeConversation]
  );
  const busy =
    activeConversation?.status === "running" ||
    activeConversation?.status === "awaiting_permission";
  const configLocked = (activeConversation?.lastEventSeq ?? 0) > 0;

  const { scrollMessages, dockedAsk } =
    partitionMessagesForDock(threadMessages);

  const dockedAskSteps = useMemo(
    () => (dockedAsk ? askStepsFromMessage(dockedAsk) : []),
    [dockedAsk]
  );

  useEffect(() => {
    if (!activeWorkspaceId) {
      setBackends([]);
      setConversationsById({});
      setEventsByConversationId({});
      return;
    }
    let cancelled = false;
    setConversationsById({});
    setEventsByConversationId({});

    void (async () => {
      const result = await listAgentConversations();
      if (cancelled) {
        return;
      }

      let conversations = result.conversations;
      setBackends(result.backends);

      if (conversations.length === 0) {
        const draft = chatDraftRef.current;
        const created = await createAgentConversation({
          backendId: draft.backendId,
          mode: draft.mode,
          modelId: draft.model.id,
          modelName: draft.model.name,
        });
        if (cancelled) {
          return;
        }
        conversations = [created.conversation];
      }

      setConversationsById(toConversationMap(conversations));
      updateWorkspaceSession((current) => {
        const validIds = new Set(conversations.map((conversation) => conversation.id));
        const hiddenConversationIds = new Set(current.chat.hiddenConversationIds);
        const existing = current.chat.tabs
          .filter((tab) => validIds.has(tab.id))
          .map((tab) => ({
            ...tab,
            title: conversations.find((conversation) => conversation.id === tab.id)?.title ?? tab.title,
          }));
        const knownIds = new Set(existing.map((tab) => tab.id));
        const missing = conversations
          .filter(
            (conversation) =>
              !knownIds.has(conversation.id) &&
              (conversation.lastEventSeq > 0 || conversation.status !== "idle") &&
              (!hiddenConversationIds.has(conversation.id) ||
                conversation.status !== "idle")
          )
          .map((conversation) => ({
            id: conversation.id,
            title: conversation.title,
            active: false,
          }));
        const fallbackVisible = conversations
          .filter(
            (conversation) =>
              !hiddenConversationIds.has(conversation.id) ||
              conversation.status !== "idle"
          )
          .map((conversation, index) => ({
            id: conversation.id,
            title: conversation.title,
            active: index === 0,
          }));
        const nextTabs =
          existing.length > 0 || missing.length > 0
            ? [...existing, ...missing]
            : fallbackVisible;
        const normalizedTabs =
          nextTabs.length === 0 || nextTabs.some((tab) => tab.active)
            ? nextTabs
            : nextTabs.map((tab, index) => ({ ...tab, active: index === 0 }));
        return tabsEqual(current.chat.tabs, normalizedTabs)
          ? current
          : {
              ...current,
              chat: {
                ...current.chat,
                tabs: normalizedTabs,
              },
            };
      });
    })().catch(() => undefined);

    return () => {
      cancelled = true;
    };
  }, [
    activeWorkspaceId,
    updateWorkspaceSession,
  ]);

  useEffect(() => {
    if (!activeWorkspaceId) {
      return;
    }
    const openConversationIds = tabs.map((tab) => tab.id).filter(Boolean);
    for (const conversationId of openConversationIds) {
      if (eventsRef.current[conversationId]) {
        continue;
      }
      void fetchAgentConversationSnapshot(conversationId)
        .then((result) => mergeSnapshot(result.snapshot))
        .catch(() => undefined);
    }
  }, [activeWorkspaceId, mergeSnapshot, tabs]);

  const sendSubscription = useCallback(() => {
    const socket = socketRef.current;
    if (!socket?.connected) {
      return;
    }
    const conversationIds = tabsRef.current.map((tab) => tab.id).filter(Boolean);
    const sinceByConversationId = Object.fromEntries(
      conversationIds.map((conversationId) => [
        conversationId,
        getConversationLatestSeq(eventsRef.current[conversationId] ?? []),
      ])
    );
    socket.send({
      type: "subscribe",
      conversationIds,
      sinceByConversationId,
    });
  }, []);

  useEffect(() => {
    if (!activeWorkspaceId) {
      socketRef.current?.disconnect();
      socketRef.current = null;
      return;
    }

    const socket = new JsonWebSocket<AgentSocketServerMessage>(() =>
      buildAgentWebSocketUrl(activeWorkspaceId)
    );
    socketRef.current = socket;

    const disposeOpen = socket.onOpen(() => {
      sendSubscription();
    });
    const disposeMessage = socket.onMessage((message) => {
      switch (message.type) {
        case "conversation":
          upsertConversation(message.conversation);
          return;
        case "snapshot":
          mergeSnapshot(message.snapshot);
          return;
        case "event":
          appendConversationEvent(message.conversationId, message.event);
          return;
        default:
          return;
      }
    });

    socket.connect();
    return () => {
      disposeOpen();
      disposeMessage();
      socket.disconnect();
      if (socketRef.current === socket) {
        socketRef.current = null;
      }
    };
  }, [activeWorkspaceId, appendConversationEvent, mergeSnapshot, sendSubscription, upsertConversation]);

  useEffect(() => {
    sendSubscription();
  }, [sendSubscription, tabs]);

  const handleSelectTab = useCallback(
    (id: string) => {
      setTabs((current) => current.map((tab) => ({ ...tab, active: tab.id === id })));
    },
    [setTabs]
  );

  const handleNewChat = useCallback(() => {
    void createConversationAndOpen();
  }, [createConversationAndOpen]);

  const closeChatTab = useCallback((tabId: string) => {
    const currentTabs = tabsRef.current;
    const remaining = currentTabs.filter((tab) => tab.id !== tabId);
    hideConversationIds([tabId]);
    if (remaining.length === 0) {
      setTabs(() => []);
      void createConversationAndOpen();
      return;
    }
    const closingActive = currentTabs.find((tab) => tab.id === tabId)?.active;
    setTabs(() => {
      if (!closingActive) {
        return remaining;
      }
      return remaining.map((tab, index) => ({ ...tab, active: index === 0 }));
    });
  }, [createConversationAndOpen, hideConversationIds, setTabs]);

  const closeOtherChatTabs = useCallback(
    (tabId: string) => {
      const keep = tabsRef.current.find((tab) => tab.id === tabId);
      if (!keep) {
        return;
      }
      hideConversationIds(
        tabsRef.current.filter((tab) => tab.id !== tabId).map((tab) => tab.id)
      );
      setTabs(() => [{ ...keep, active: true }]);
    },
    [hideConversationIds, setTabs]
  );

  const closeAllChatTabs = useCallback(() => {
    hideConversationIds(tabsRef.current.map((tab) => tab.id));
    setTabs(() => []);
    void createConversationAndOpen();
  }, [createConversationAndOpen, hideConversationIds, setTabs]);

  const handleChatTabContextMenu = useCallback(
    (e: MouseEvent, tabId: string) => {
      const othersOpen = tabs.length > 1;
      const items: WorkbenchMenuItem[] = [
        {
          type: "item",
          id: "close",
          label: "Close",
          onSelect: () => closeChatTab(tabId),
        },
        {
          type: "item",
          id: "close-others",
          label: "Close Others",
          disabled: !othersOpen,
          onSelect: () => closeOtherChatTabs(tabId),
        },
      ];
      openAt(e, items);
    },
    [tabs, openAt, closeChatTab, closeOtherChatTabs]
  );

  const handleChatStripContextMenu = useCallback(
    (e: MouseEvent) => {
      openAt(e, [
        {
          type: "item",
          id: "close-all",
          label: "Close All",
          onSelect: () => closeAllChatTabs(),
        },
        { type: "sep" },
        {
          type: "item",
          id: "new-chat",
          label: "New Chat",
          onSelect: () => handleNewChat(),
        },
      ]);
    },
    [openAt, closeAllChatTabs, handleNewChat]
  );

  const composer = (
    <ChatComposer
      key={activeTabId}
      mode={mode}
      onModeChange={(next) => void setMode(next)}
      model={model}
      onModelChange={(next) => void setModel(next)}
      backendId={backendId}
      backends={backends}
      onBackendChange={(next) => void setBackend(next)}
      models={models.length > 0 ? models : [model]}
      modeOptions={modeOptions}
      sessionConfigOptions={sessionConfigOptions}
      onSessionConfigOptionChange={(configId, value) =>
        void setSessionConfigOption(configId, value)
      }
      busy={busy}
      configLocked={configLocked}
      onSubmit={async (text) => {
        const conversation = activeConversation ?? (await createConversationAndOpen());
        try {
          const snapshot = await promptAgentConversation(conversation.id, text);
          mergeSnapshot(snapshot.snapshot);
        } catch (error) {
          const message =
            error instanceof Error ? error.message : "Failed to start the agent turn.";
          setEventsByConversationId((current) => {
            const existing = current[conversation.id] ?? [];
            const nextSeq = getConversationLatestSeq(existing) + 1;
            return {
              ...current,
              [conversation.id]: [
                ...existing,
                {
                  seq: nextSeq,
                  eventId:
                    globalThis.crypto?.randomUUID?.() ??
                    `local-error-${Date.now()}`,
                  conversationId: conversation.id,
                  createdAt: Date.now(),
                  kind: "system",
                  level: "error",
                  text: message,
                },
              ],
            };
          });
        }
      }}
      onCancel={() => {
        if (!activeConversation) {
          return;
        }
        void cancelAgentConversation(activeConversation.id)
          .then((result) => upsertConversation(result.conversation))
          .catch(() => undefined);
      }}
      layout={isEmptyThread ? "empty-top" : "docked-bottom"}
    />
  );

  return (
    <div className="flex h-full min-h-0 w-full flex-col overflow-hidden bg-[var(--bg-panel)]">
      <div className="shrink-0">
        <ChatTabs
          tabs={tabs}
          onSelectTab={handleSelectTab}
          onNewChat={handleNewChat}
          onTabContextMenu={handleChatTabContextMenu}
          onStripContextMenu={handleChatStripContextMenu}
        />
      </div>

      {isEmptyThread ? (
        <div className="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden">
          <div className="shrink-0">{composer}</div>
          <div
            className="min-h-0 flex-1 bg-[var(--bg-panel)]"
            aria-hidden
          />
        </div>
      ) : (
        <div className="relative min-h-0 min-w-0 flex-1 overflow-hidden">
          <MessageList
            messages={scrollMessages}
            onResolvePermission={(requestId, optionId) => {
              if (!activeConversation) {
                return;
              }
              void answerAgentPermission(activeConversation.id, {
                requestId,
                optionId,
              })
                .then((result) => upsertConversation(result.conversation))
                .catch(() => undefined);
            }}
            scrollTop={workspaceSession.chat.scrollTopByTabId[activeTabId] ?? 0}
            onScrollTopChange={(scrollTop) => {
              updateWorkspaceSession((current) => ({
                ...current,
                chat: {
                  ...current.chat,
                  scrollTopByTabId: {
                    ...current.chat.scrollTopByTabId,
                    [activeTabId]: scrollTop,
                  },
                },
              }));
            }}
          />
          <div className="pointer-events-none absolute inset-x-0 bottom-0 z-30">
            <div className="pointer-events-auto chat-bottom-dock">
              {dockedAskSteps.length > 0 ? (
                <div className="px-[10px] pt-[8px]">
                  <AskQuestionCard steps={dockedAskSteps} dockAboveComposer />
                </div>
              ) : null}
              {composer}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
