"use client";

import {
  useCallback,
  useDeferredValue,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
  type MouseEvent,
} from "react";
import { Search } from "lucide-react";
import { ChatTabs } from "./ChatTabs";
import { MessageList } from "./MessageList";
import { ChatComposer } from "./ChatComposer";
import { ComposerQueueDock } from "./ComposerQueueDock";
import { AskQuestionCard } from "./AskQuestionCard";
import { RecentChatsModal } from "@/components/ide/RecentChatsModal";
import { askStepsFromMessage } from "@/lib/ask-question-utils";
import {
  buildDraftModeOptionsForBackend,
  buildDraftModelOptionsForBackend,
  buildConversationModeOptions,
  buildConversationModelOptions,
  getConversationLatestSeq,
  projectAgentEventsToChatMessages,
  resolveDraftModelForBackend,
  resolveConversationModel,
} from "@/lib/agent-chat";
import { DEFAULT_MODE_OPTIONS, resolveCanonicalModeId } from "@/lib/chat-modes";
import { listSupplementaryAgentConfigOptions } from "@/lib/agent-config-option-utils";
import { useWorkbenchContextMenu } from "@/components/ide/WorkbenchContextMenuProvider";
import { useOpenInEditor } from "@/components/editor/OpenInEditorContext";
import type { WorkbenchMenuItem } from "@/components/ide/workbench-context-menu-types";
import type {
  AgentBackendId,
  AgentBackendInfo,
  AgentConversationRecord,
  AgentConversationEventWindow,
  AgentConversationSnapshot,
  AgentConversationSnapshotHead,
  AgentSocketServerMessage,
  AgentStoredEvent,
} from "@/lib/agent-types";
import {
  endQueuedPromptFlush,
  tryBeginQueuedPromptFlush,
} from "@/lib/queued-prompt-flush-guard";
import type {
  AgentTabIndicatorByConversationId,
  ChatMessage,
  ChatTab,
  EditorMode,
  ImageAttachment,
  ModelInfo,
  QueuedChatPrompt,
} from "@/lib/types";
import { useWorkspace } from "@/contexts/WorkspaceContext";
import { JsonWebSocket } from "@/lib/ws-client";
import { useWorkbenchNotifications } from "@/components/notifications/WorkbenchNotificationProvider";
import { WORKBENCH_NOTIFICATION_KIND } from "@/components/notifications/workbench-notification-types";
import {
  answerAgentPermission,
  buildAgentWebSocketUrl,
  cancelAgentConversation,
  createAgentConversation,
  createWorkspaceWindow,
  fetchAgentConversationSnapshot,
  listAgentConversations,
  promptAgentConversation,
  saveWorkspaceWindowSession,
  updateAgentConversationConfig,
} from "@/lib/server-api";
import { createPersistableWorkspaceSession } from "@/lib/workspace-session";
import {
  buildWorkspaceWindowUrl,
  FRESH_WORKSPACE_WINDOW_HIDDEN_CONVERSATIONS_SENTINEL,
  normalizeWorkspaceWindowSession,
} from "@/lib/workspace-windows";
import { nextUnreadCompletionMap } from "@/lib/chat-unread-completion";
import {
  getGlobalPinnedAgentConversationIdsSnapshot,
  migrateGlobalPinnedAgentConversationIdsIfNeeded,
  subscribeGlobalPinnedAgentConversationIds,
  writeGlobalPinnedAgentConversationIds,
} from "@/lib/agent-rail-pins";

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

function conversationRequiresVisibleTab(conversation: AgentConversationRecord): boolean {
  return (
    conversation.status === "running" ||
    conversation.status === "awaiting_permission"
  );
}

function isRecentConversationCandidate(conversation: AgentConversationRecord): boolean {
  if (conversation.title === "New chat" && !conversationRequiresVisibleTab(conversation)) {
    return false;
  }
  return conversation.lastEventSeq > 0 || conversationRequiresVisibleTab(conversation);
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

function toConversationMap(
  conversations: AgentConversationRecord[]
): Record<string, AgentConversationRecord> {
  return Object.fromEntries(
    conversations.map((conversation) => [conversation.id, conversation])
  );
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

/** Composer `draftId` for a server-backed tab (PATCH by id even if the map row hydrates late). */
function isPersistedConversationTabId(tabId: string): boolean {
  if (!tabId || tabId === "__empty__") {
    return false;
  }
  if (tabId.startsWith("draft-")) {
    return false;
  }
  return true;
}

function mergeConversationByRecency(
  existing: AgentConversationRecord | undefined,
  incoming: AgentConversationRecord
): AgentConversationRecord {
  if (!existing || incoming.updatedAt > existing.updatedAt) {
    return incoming;
  }
  return existing;
}

export function ChatPanel() {
  const { openAt } = useWorkbenchContextMenu();
  const {
    composerDrafts,
    composerSelections,
    openComposerDraft,
    openAgentConversation,
    upsertComposerDraft,
    setComposerSelection,
    expandedComposerDraftId,
    setExpandedComposerDraft,
    setExpandedComposerController,
  } = useOpenInEditor();
  const { pushNotification } = useWorkbenchNotifications();
  const {
    activeWindowId,
    activeWorkspaceId,
    workspaceSession,
    workspaceWindows,
    updateWorkspaceSession,
    updateWorkspaceSessionNow,
  } = useWorkspace();
  const [backends, setBackends] = useState<AgentBackendInfo[]>([]);
  const [conversationsById, setConversationsById] = useState<
    Record<string, AgentConversationRecord>
  >({});
  const [conversations, setConversations] = useState<AgentConversationRecord[]>([]);
  const [eventsByConversationId, setEventsByConversationId] = useState<
    Record<string, AgentStoredEvent[]>
  >({});
  const [historyMetaById, setHistoryMetaById] = useState<
    Record<string, { hasOlder: boolean }>
  >({});
  const [loadingOlderById, setLoadingOlderById] = useState<Record<string, boolean>>({});
  const historyMetaRef = useRef(historyMetaById);
  const loadingOlderRef = useRef<Record<string, boolean>>({});
  const [recentChatsModalOpen, setRecentChatsModalOpen] = useState(false);
  const [chatTabRenameTargetId, setChatTabRenameTargetId] = useState<string | null>(
    null
  );
  const socketRef = useRef<JsonWebSocket<AgentSocketServerMessage> | null>(null);
  const chatDraftRef = useRef(workspaceSession.chat);
  const tabsRef = useRef<ChatTab[]>(workspaceSession.chat.tabs);
  const eventsRef = useRef(eventsByConversationId);
  const hydratingConversationIdsRef = useRef(new Set<string>());
  const conversationsByIdRef = useRef(conversationsById);
  const tabs = workspaceSession.chat.tabs;

  const globalPinnedAgentConversationIds = useSyncExternalStore(
    subscribeGlobalPinnedAgentConversationIds,
    getGlobalPinnedAgentConversationIdsSnapshot,
    () => []
  );

  useLayoutEffect(() => {
    if (typeof window === "undefined") {
      return;
    }
    migrateGlobalPinnedAgentConversationIdsIfNeeded(
      workspaceSession.agentView.pinnedAgentConversationIds
    );
  }, [workspaceSession.agentView.pinnedAgentConversationIds]);

  conversationsByIdRef.current = conversationsById;

  useEffect(() => {
    chatDraftRef.current = workspaceSession.chat;
  }, [workspaceSession.chat]);

  useEffect(() => {
    tabsRef.current = tabs;
  }, [tabs]);

  useEffect(() => {
    eventsRef.current = eventsByConversationId;
  }, [eventsByConversationId]);

  useEffect(() => {
    historyMetaRef.current = historyMetaById;
  }, [historyMetaById]);

  useEffect(() => {
    const handler = () => setRecentChatsModalOpen(true);
    window.addEventListener("opencursor:openRecentChats", handler);
    return () => window.removeEventListener("opencursor:openRecentChats", handler);
  }, []);

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

  const persistClosedTabsNow = useCallback(
    async (nextTabs: ChatTab[], conversationIds: string[]) => {
      tabsRef.current = nextTabs;
      await updateWorkspaceSessionNow((current) => {
        const nextHidden = new Set(current.chat.hiddenConversationIds);
        for (const conversationId of conversationIds) {
          if (conversationId) {
            nextHidden.add(conversationId);
          }
        }
        for (const tab of nextTabs) {
          nextHidden.delete(tab.id);
        }
        const normalized = Array.from(nextHidden);
        const hiddenUnchanged =
          normalized.length === current.chat.hiddenConversationIds.length &&
          normalized.every((value, index) => value === current.chat.hiddenConversationIds[index]);
        return hiddenUnchanged && tabsEqual(current.chat.tabs, nextTabs)
          ? current
          : {
              ...current,
              chat: {
                ...current.chat,
                tabs: nextTabs,
                hiddenConversationIds: normalized,
              },
            };
      });
    },
    [updateWorkspaceSessionNow]
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

  const mergeSnapshot = useCallback(
    (snapshot: AgentConversationSnapshot | AgentConversationSnapshotHead) => {
      const incoming = snapshot.conversation;
      const prev = conversationsByIdRef.current[incoming.id];
      const merged = mergeConversationByRecency(prev, incoming);
      setConversationsById((current) => ({
        ...current,
        [incoming.id]: mergeConversationByRecency(current[incoming.id], incoming),
      }));

      const isHead =
        "window" in snapshot &&
        snapshot.window != null &&
        typeof snapshot.window.oldestSeq === "number";
      if (isHead) {
        const head = snapshot;
        setEventsByConversationId((current) => {
          const existing = current[incoming.id] ?? [];
          const kept = existing.filter((e) => e.seq < head.window.oldestSeq);
          const bySeq = new Map<number, AgentStoredEvent>();
          for (const e of kept) {
            bySeq.set(e.seq, e);
          }
          for (const e of head.events) {
            bySeq.set(e.seq, e);
          }
          const mergedEvents = [...bySeq.values()].sort((a, b) => a.seq - b.seq);
          return { ...current, [incoming.id]: mergedEvents };
        });
        setHistoryMetaById((c) => ({
          ...c,
          [incoming.id]: { hasOlder: head.window.hasOlder },
        }));
      } else {
        const full = snapshot as AgentConversationSnapshot;
        setEventsByConversationId((current) => {
          const existing = current[full.conversation.id] ?? [];
          const existingSeq = existing.at(-1)?.seq ?? 0;
          const incomingSeq = full.events.at(-1)?.seq ?? 0;
          return {
            ...current,
            [full.conversation.id]:
              incomingSeq >= existingSeq ? full.events : existing,
          };
        });
        setHistoryMetaById((c) => ({
          ...c,
          [incoming.id]: { hasOlder: false },
        }));
      }

      updateWorkspaceSession((current) => {
        const unreadMap = nextUnreadCompletionMap(current, prev, merged);
        const nextTabs = current.chat.tabs.map((tab) =>
          tab.id === incoming.id ? { ...tab, title: incoming.title } : tab
        );
        const tabChanged = !tabsEqual(current.chat.tabs, nextTabs);
        if (unreadMap === null && !tabChanged) {
          return current;
        }
        return {
          ...current,
          chat: {
            ...current.chat,
            ...(unreadMap === null
              ? {}
              : { unreadChatCompletionByConversationId: unreadMap }),
            ...(tabChanged ? { tabs: nextTabs } : {}),
          },
        };
      });
    },
    [updateWorkspaceSession]
  );

  const prependHistoryPage = useCallback(
    (
      conversationId: string,
      pageEvents: AgentStoredEvent[],
      window: AgentConversationEventWindow
    ) => {
      loadingOlderRef.current[conversationId] = false;
      setLoadingOlderById((c) => ({ ...c, [conversationId]: false }));
      setEventsByConversationId((current) => {
        const existing = current[conversationId] ?? [];
        const bySeq = new Map<number, AgentStoredEvent>();
        for (const e of existing) {
          bySeq.set(e.seq, e);
        }
        for (const e of pageEvents) {
          bySeq.set(e.seq, e);
        }
        const merged = [...bySeq.values()].sort((a, b) => a.seq - b.seq);
        return { ...current, [conversationId]: merged };
      });
      setHistoryMetaById((c) => ({
        ...c,
        [conversationId]: { hasOlder: window.hasOlder },
      }));
    },
    []
  );

  const loadOlderConversationHistory = useCallback((conversationId: string) => {
    const socket = socketRef.current;
    if (!socket?.connected) {
      return;
    }
    if (!historyMetaRef.current[conversationId]?.hasOlder) {
      return;
    }
    if (loadingOlderRef.current[conversationId]) {
      return;
    }
    const events = eventsRef.current[conversationId] ?? [];
    const oldest = events[0]?.seq;
    if (!oldest) {
      return;
    }
    loadingOlderRef.current[conversationId] = true;
    setLoadingOlderById((c) => ({ ...c, [conversationId]: true }));
    socket.send({
      type: "request_history",
      conversationId,
      beforeSeq: oldest,
    });
    window.setTimeout(() => {
      if (loadingOlderRef.current[conversationId]) {
        loadingOlderRef.current[conversationId] = false;
        setLoadingOlderById((c) => ({ ...c, [conversationId]: false }));
      }
    }, 18_000);
  }, []);

  const syncConversationSnapshot = useCallback(
    (conversationId: string) => {
      void fetchAgentConversationSnapshot(conversationId)
        .then((result) => mergeSnapshot(result.snapshot))
        .catch(() => undefined);
    },
    [mergeSnapshot]
  );

  const setModeForDraft = useCallback(
    async (draftId: string, next: EditorMode) => {
      if (!isPersistedConversationTabId(draftId)) {
        updateWorkspaceSession((current) => ({
          ...current,
          chat: {
            ...current.chat,
            mode: next,
          },
        }));
        return;
      }

      setConversationsById((current) => {
        const conv = current[draftId];
        if (!conv) {
          return current;
        }
        return {
          ...current,
          [draftId]: {
            ...conv,
            config: { ...conv.config, mode: next },
          },
        };
      });

      try {
        const updated = await updateAgentConversationConfig(draftId, { mode: next });
        setConversationsById((current) => ({
          ...current,
          [updated.conversation.id]: updated.conversation,
        }));
      } catch {
        syncConversationSnapshot(draftId);
      }
    },
    [syncConversationSnapshot, updateWorkspaceSession]
  );

  const setModelForDraft = useCallback(
    async (draftId: string, next: ModelInfo) => {
      if (!isPersistedConversationTabId(draftId)) {
        updateWorkspaceSession((current) => ({
          ...current,
          chat: {
            ...current.chat,
            model: next,
          },
        }));
        return;
      }

      const modelId = next.modelValue ?? next.id;

      setConversationsById((current) => {
        const conv = current[draftId];
        if (!conv) {
          return current;
        }
        return {
          ...current,
          [draftId]: {
            ...conv,
            config: {
              ...conv.config,
              modelId,
              modelName: next.name,
            },
          },
        };
      });

      try {
        const updated = await updateAgentConversationConfig(draftId, {
          modelId,
          modelName: next.name,
          setConfigOptions: next.configSelections,
        });
        setConversationsById((current) => ({
          ...current,
          [updated.conversation.id]: updated.conversation,
        }));
      } catch {
        syncConversationSnapshot(draftId);
      }
    },
    [syncConversationSnapshot, updateWorkspaceSession]
  );

  const setSessionConfigOptionForDraft = useCallback(
    async (draftId: string, configId: string, value: string) => {
      if (!isPersistedConversationTabId(draftId)) {
        return;
      }
      try {
        const updated = await updateAgentConversationConfig(draftId, {
          setConfigOption: { configId, value },
        });
        setConversationsById((current) => ({
          ...current,
          [updated.conversation.id]: updated.conversation,
        }));
      } catch {
        syncConversationSnapshot(draftId);
      }
    },
    [syncConversationSnapshot]
  );

  const setBackendForDraft = useCallback(
    async (draftId: string, nextBackendId: AgentBackendId) => {
      if (!isPersistedConversationTabId(draftId)) {
        const targetBackend = pickAvailableBackend(backends, nextBackendId);
        const targetModel = targetBackend ? resolveDraftModelForBackend(targetBackend) : null;
        const targetMode = targetBackend
          ? buildDraftModeOptionsForBackend(targetBackend)[0]?.id ?? workspaceSession.chat.mode
          : workspaceSession.chat.mode;
        updateWorkspaceSession((current) => ({
          ...current,
          chat: {
            ...current.chat,
            backendId: targetBackend?.id ?? nextBackendId,
            mode: targetMode,
            model: targetModel ?? current.chat.model,
          },
        }));
        return;
      }
      try {
        const updated = await updateAgentConversationConfig(draftId, {
          backendId: nextBackendId,
        });
        setConversationsById((current) => ({
          ...current,
          [updated.conversation.id]: updated.conversation,
        }));
      } catch {
        syncConversationSnapshot(draftId);
      }
    },
    [backends, syncConversationSnapshot, updateWorkspaceSession, workspaceSession.chat.mode]
  );

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
      const prev = conversationsByIdRef.current[conversation.id];
      const merged = mergeConversationByRecency(prev, conversation);
      setConversationsById((current) => ({
        ...current,
        [conversation.id]: merged,
      }));
      updateWorkspaceSession((current) => {
        const unreadMap = nextUnreadCompletionMap(current, prev, merged);
        const nextTabs = current.chat.tabs.map((tab) =>
          tab.id === conversation.id ? { ...tab, title: conversation.title } : tab
        );
        const tabChanged = !tabsEqual(current.chat.tabs, nextTabs);
        if (unreadMap === null && !tabChanged) {
          return current;
        }
        return {
          ...current,
          chat: {
            ...current.chat,
            ...(unreadMap === null
              ? {}
              : { unreadChatCompletionByConversationId: unreadMap }),
            ...(tabChanged ? { tabs: nextTabs } : {}),
          },
        };
      });
    },
    [updateWorkspaceSession]
  );

  const answerPermissionForConversation = useCallback(
    async (conversationId: string, requestId: string, optionId: string) => {
      try {
        await answerAgentPermission(conversationId, {
          requestId,
          optionId,
        });
        const snapshot = await fetchAgentConversationSnapshot(conversationId);
        mergeSnapshot(snapshot.snapshot);
      } catch {
        void fetchAgentConversationSnapshot(conversationId)
          .then((result) => mergeSnapshot(result.snapshot))
          .catch(() => undefined);
      }
    },
    [mergeSnapshot]
  );

  const cancelPermissionForConversation = useCallback(
    async (conversationId: string, requestId: string) => {
      try {
        await answerAgentPermission(conversationId, {
          requestId,
          cancelled: true,
        });
        const snapshot = await fetchAgentConversationSnapshot(conversationId);
        mergeSnapshot(snapshot.snapshot);
      } catch {
        void fetchAgentConversationSnapshot(conversationId)
          .then((r) => mergeSnapshot(r.snapshot))
          .catch(() => undefined);
      }
    },
    [mergeSnapshot]
  );

  const createConversationAndOpen = useCallback(async () => {
    const draft = chatDraftRef.current;
    const created = await createAgentConversation({
      backendId: draft.backendId,
      mode: draft.mode,
      modelId: draft.model.modelValue ?? draft.model.id,
      modelName: draft.model.name,
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
  ]);

  const openConversationById = useCallback(
    (conversationId: string) => {
      const conversation = conversationsById[conversationId];
      if (!conversation) return;
      const existingTab = tabs.find((tab) => tab.id === conversationId);
      if (existingTab) {
        setTabs((current) =>
          current.map((tab) => ({ ...tab, active: tab.id === conversationId }))
        );
      } else {
        setTabs((current) => [
          ...current.map((tab) => ({ ...tab, active: false })),
          { id: conversation.id, title: conversation.title, active: true },
        ]);
      }
      unhideConversationIds([conversationId]);
    },
    [conversationsById, tabs, setTabs, unhideConversationIds]
  );

  const activeTabId = useMemo(
    () => tabs.find((tab) => tab.active)?.id ?? tabs[0]?.id ?? "__empty__",
    [tabs]
  );
  const panelHistoryCursor = useMemo(() => {
    if (!activeTabId || activeTabId === "__empty__") {
      return { hasOlder: false, loadingOlder: false };
    }
    return {
      hasOlder: historyMetaById[activeTabId]?.hasOlder ?? false,
      loadingOlder: loadingOlderById[activeTabId] ?? false,
    };
  }, [activeTabId, historyMetaById, loadingOlderById]);
  const agentTabIndicators = useMemo(() => {
    const unread = workspaceSession.chat.unreadChatCompletionByConversationId ?? {};
    const m: AgentTabIndicatorByConversationId = {};
    for (const tab of tabs) {
      const c = conversationsById[tab.id];
      if (!c) continue;
      m[tab.id] = {
        needsAttention: c.status === "awaiting_permission",
        running: c.status === "running",
        unreadCompletion:
          Boolean(unread[tab.id]) && c.status === "idle",
      };
    }
    return m;
  }, [
    tabs,
    conversationsById,
    workspaceSession.chat.unreadChatCompletionByConversationId,
  ]);
  const activeConversation = activeTabId ? conversationsById[activeTabId] ?? null : null;
  const recentConversations = useMemo(
    () =>
      conversations
        .filter(
          (conversation) =>
            conversation.id !== activeConversation?.id &&
            isRecentConversationCandidate(conversation)
        )
        .sort((a, b) => b.updatedAt - a.updatedAt),
    [activeConversation?.id, conversations]
  );
  const recentConversationPreview = useMemo(
    () => recentConversations.slice(0, 5),
    [recentConversations]
  );
  const showRecentChatsSection =
    activeConversation?.title === "New chat" && recentConversationPreview.length > 0;
  const composerDraftId = activeConversation?.id ?? activeTabId;
  const composerDraftTitle =
    activeConversation?.title && activeConversation.title !== "New chat"
      ? `${activeConversation.title} prompt`
      : "Composer";
  const composerDraftText = composerDrafts[composerDraftId]?.content ?? "";
  const composerSelection = composerSelections[composerDraftId] ?? {
    start: composerDraftText.length,
    end: composerDraftText.length,
  };
  const draftBackend = useMemo(() => {
    if (backends.length === 0) {
      return null;
    }
    return (
      backends.find((backend) => backend.id === workspaceSession.chat.backendId && backend.available) ??
      backends.find((backend) => backend.available) ??
      backends[0] ??
      null
    );
  }, [backends, workspaceSession.chat.backendId]);
  const draftModels = useMemo(
    () => (draftBackend ? buildDraftModelOptionsForBackend(draftBackend) : [workspaceSession.chat.model]),
    [draftBackend, workspaceSession.chat.model]
  );
  const draftModel = useMemo(() => {
    if (!draftBackend) {
      return workspaceSession.chat.model;
    }
    const currentModelValue = workspaceSession.chat.model.modelValue ?? workspaceSession.chat.model.id;
    return (
      draftModels.find((model) => (model.modelValue ?? model.id) === currentModelValue) ??
      resolveDraftModelForBackend(draftBackend)
    );
  }, [draftBackend, draftModels, workspaceSession.chat.model]);
  const rawPanelThreadEvents = activeTabId
    ? (eventsByConversationId[activeTabId] ?? [])
    : [];
  const deferredPanelThreadEvents = useDeferredValue(rawPanelThreadEvents);
  const threadMessages = useMemo(
    () =>
      projectAgentEventsToChatMessages(deferredPanelThreadEvents, {
        backendId: activeConversation?.config.backendId,
      }),
    [activeConversation?.config.backendId, deferredPanelThreadEvents]
  );
  const isEmptyThread = threadMessages.length === 0;
  const resolveComposerStateForDraft = useCallback(
    (draftId: string) => {
      const conversation = conversationsById[draftId] ?? null;
      const backend =
        conversation
          ? pickAvailableBackend(backends, conversation.config.backendId)
          : draftBackend;
      const models = conversation
        ? buildConversationModelOptions(conversation, backends)
        : backend
          ? buildDraftModelOptionsForBackend(backend)
          : [workspaceSession.chat.model];
      const model = conversation
        ? resolveConversationModel(conversation, backends)
        : backend
          ? (() => {
              const currentModelValue =
                workspaceSession.chat.model.modelValue ?? workspaceSession.chat.model.id;
              return (
                models.find(
                  (candidate) => (candidate.modelValue ?? candidate.id) === currentModelValue
                ) ?? resolveDraftModelForBackend(backend)
              );
            })()
          : workspaceSession.chat.model;
      const modeOptions = conversation
        ? buildConversationModeOptions(conversation, backends)
        : backend
          ? buildDraftModeOptionsForBackend(backend)
          : DEFAULT_MODE_OPTIONS;
      const mode = resolveCanonicalModeId(
        String(conversation?.config.mode ?? workspaceSession.chat.mode ?? ""),
        modeOptions
      ) as EditorMode;
      return {
        conversation,
        backendId:
          conversation?.config.backendId ??
          backend?.id ??
          workspaceSession.chat.backendId,
        models,
        model,
        modeOptions,
        mode,
        sessionConfigOptions: conversation
          ? listSupplementaryAgentConfigOptions(conversation)
          : [],
        busy:
          conversation?.status === "running" ||
          conversation?.status === "awaiting_permission",
      };
    },
    [
      backends,
      conversationsById,
      draftBackend,
      workspaceSession.chat.backendId,
      workspaceSession.chat.mode,
      workspaceSession.chat.model,
    ]
  );
  const activeComposerState = useMemo(
    () => resolveComposerStateForDraft(composerDraftId),
    [composerDraftId, resolveComposerStateForDraft]
  );
  const model = activeComposerState.model;
  const backendId = activeComposerState.backendId;
  const models = activeComposerState.models;
  const modeOptions = activeComposerState.modeOptions;
  const mode = activeComposerState.mode;
  const sessionConfigOptions = activeComposerState.sessionConfigOptions;
  const busy = activeComposerState.busy;
  const configLocked = false;

  const flashError = useCallback(
    (message: string) => {
      pushNotification({
        kind: WORKBENCH_NOTIFICATION_KIND.editorNotice,
        severity: "error",
        title: "Chat",
        message,
        autoDismissMs: 8000,
      });
    },
    [pushNotification]
  );

  useEffect(() => {
    upsertComposerDraft(composerDraftId, {
      title: composerDraftTitle,
      content: composerDraftText,
    });
  }, [composerDraftId, composerDraftText, composerDraftTitle, upsertComposerDraft]);

  const { scrollMessages, dockedAsk } =
    partitionMessagesForDock(threadMessages);

  const dockedAskSteps = useMemo(
    () => (dockedAsk ? askStepsFromMessage(dockedAsk) : []),
    [dockedAsk]
  );

  const activeQueuedPrompts = useMemo(() => {
    const id = activeConversation?.id;
    if (!id) {
      return [];
    }
    return workspaceSession.chat.queuedPromptsByConversationId?.[id] ?? [];
  }, [activeConversation?.id, workspaceSession.chat.queuedPromptsByConversationId]);

  const removeQueuedPromptForActiveChat = useCallback(
    (item: QueuedChatPrompt) => {
      const cid = activeConversation?.id;
      if (!cid) {
        return;
      }
      updateWorkspaceSession((current) => {
        const map = { ...(current.chat.queuedPromptsByConversationId ?? {}) };
        const list = map[cid];
        if (!list) {
          return current;
        }
        const next = list.filter((p) => p.id !== item.id);
        if (next.length === 0) {
          delete map[cid];
        } else {
          map[cid] = next;
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
    [activeConversation?.id, updateWorkspaceSession]
  );

  const unqueuePromptToComposer = useCallback(
    (item: QueuedChatPrompt) => {
      removeQueuedPromptForActiveChat(item);
      upsertComposerDraft(composerDraftId, {
        title: composerDraftTitle,
        content: item.text,
      });
    },
    [
      composerDraftId,
      composerDraftTitle,
      removeQueuedPromptForActiveChat,
      upsertComposerDraft,
    ]
  );

  useEffect(() => {
    if (activeConversation) {
      const nextModel = resolveConversationModel(activeConversation, backends);
      const nextMode = resolveCanonicalModeId(
        String(activeConversation.config.mode),
        modeOptions
      ) as EditorMode;
      const nextBackendId = activeConversation.config.backendId;
      updateWorkspaceSession((current) => {
        const currentModelValue = current.chat.model.modelValue ?? current.chat.model.id;
        const nextModelValue = nextModel.modelValue ?? nextModel.id;
        if (
          current.chat.backendId === nextBackendId &&
          current.chat.mode === nextMode &&
          currentModelValue === nextModelValue &&
          current.chat.model.name === nextModel.name
        ) {
          return current;
        }
        return {
          ...current,
          chat: {
            ...current.chat,
            backendId: nextBackendId,
            mode: nextMode,
            model: nextModel,
          },
        };
      });
      return;
    }

    if (!draftBackend) {
      return;
    }

    updateWorkspaceSession((current) => {
      const currentModelValue = current.chat.model.modelValue ?? current.chat.model.id;
      const nextModelValue = draftModel.modelValue ?? draftModel.id;
      let nextMode = resolveCanonicalModeId(String(current.chat.mode), modeOptions);
      if (!modeOptions.some((o) => o.id === nextMode)) {
        nextMode = modeOptions[0]?.id ?? nextMode;
      }
      if (
        current.chat.backendId === draftBackend.id &&
        current.chat.mode === nextMode &&
        currentModelValue === nextModelValue &&
        current.chat.model.name === draftModel.name
      ) {
        return current;
      }
      return {
        ...current,
        chat: {
          ...current.chat,
          backendId: draftBackend.id,
          mode: nextMode,
          model: draftModel,
        },
      };
    });
  }, [activeConversation, backends, draftBackend, draftModel, modeOptions, updateWorkspaceSession]);

  useEffect(() => {
    if (!activeWorkspaceId) {
      setBackends([]);
      setConversationsById({});
      setEventsByConversationId({});
      setHistoryMetaById({});
      setLoadingOlderById({});
      loadingOlderRef.current = {};
      return;
    }
    let cancelled = false;
    setConversationsById({});
    setEventsByConversationId({});
    setHistoryMetaById({});
    setLoadingOlderById({});
    loadingOlderRef.current = {};

    void (async () => {
      const result = await listAgentConversations();
      if (cancelled) {
        return;
      }

      let conversations = result.conversations;
      setBackends(result.backends);

      if (conversations.length === 0) {
        const draft = chatDraftRef.current;
        const preferredBackend = pickAvailableBackend(result.backends, draft.backendId);
        const preferredModel = preferredBackend
          ? resolveDraftModelForBackend(preferredBackend)
          : draft.model;
        const preferredMode = preferredBackend
          ? buildDraftModeOptionsForBackend(preferredBackend)[0]?.id ?? draft.mode
          : draft.mode;
        const created = await createAgentConversation({
          backendId: preferredBackend?.id ?? draft.backendId,
          mode: preferredMode,
          modelId: preferredModel.modelValue ?? preferredModel.id,
          modelName: preferredModel.name,
        });
        if (cancelled) {
          return;
        }
        conversations = [created.conversation];
      }

      setConversationsById(toConversationMap(conversations));
      setConversations(conversations);
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
              (conversation.lastEventSeq > 0 ||
                conversationRequiresVisibleTab(conversation)) &&
              (!hiddenConversationIds.has(conversation.id) ||
                conversationRequiresVisibleTab(conversation))
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
              conversationRequiresVisibleTab(conversation)
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
    if (Object.keys(conversationsById).length === 0) {
      return;
    }
    const openConversationIds = tabs.map((tab) => tab.id).filter(Boolean);
    for (const conversationId of openConversationIds) {
      if (!conversationsById[conversationId]) {
        continue;
      }
      if (eventsRef.current[conversationId]) {
        continue;
      }
      void fetchAgentConversationSnapshot(conversationId)
        .then((result) => mergeSnapshot(result.snapshot))
        .catch(() => undefined);
    }
  }, [activeWorkspaceId, conversationsById, mergeSnapshot, tabs]);

  useEffect(() => {
    if (!activeConversation) {
      return;
    }
    const needsRuntimeHydration =
      activeConversation.configOptions.length === 0 ||
      activeConversation.providerSessionId == null ||
      !activeConversation.capabilities.supportsLoadSession ||
      (activeConversation.config.backendId === "cursor-acp" &&
        (!activeConversation.capabilities.supportsPermissions ||
          !activeConversation.capabilities.supportsSessionResume)) ||
      ((activeConversation.status === "running" ||
        activeConversation.status === "awaiting_permission") &&
        activeConversation.providerSessionId == null);
    if (!needsRuntimeHydration) {
      return;
    }
    if (hydratingConversationIdsRef.current.has(activeConversation.id)) {
      return;
    }
    hydratingConversationIdsRef.current.add(activeConversation.id);
    void fetchAgentConversationSnapshot(activeConversation.id, { hydrateRuntime: true })
      .then((result) => {
        mergeSnapshot(result.snapshot);
      })
      .catch(() => undefined)
      .finally(() => {
        hydratingConversationIdsRef.current.delete(activeConversation.id);
      });
  }, [activeConversation, mergeSnapshot]);

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
        case "snapshot_head":
          mergeSnapshot(message.snapshot);
          return;
        case "history_page":
          prependHistoryPage(
            message.conversationId,
            message.events,
            message.window
          );
          return;
        case "event":
          appendConversationEvent(message.conversationId, message.event);
          return;
        case "error":
          loadingOlderRef.current = {};
          setLoadingOlderById({});
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
  }, [
    activeWorkspaceId,
    appendConversationEvent,
    mergeSnapshot,
    prependHistoryPage,
    sendSubscription,
    upsertConversation,
  ]);

  useEffect(() => {
    sendSubscription();
  }, [sendSubscription, tabs]);

  const handleSelectTab = useCallback(
    (id: string) => {
      setTabs((current) => current.map((tab) => ({ ...tab, active: tab.id === id })));
      updateWorkspaceSession((current) => {
        const u = { ...(current.chat.unreadChatCompletionByConversationId ?? {}) };
        if (!u[id]) {
          return current;
        }
        delete u[id];
        return {
          ...current,
          chat: {
            ...current.chat,
            unreadChatCompletionByConversationId: u,
          },
        };
      });
    },
    [setTabs, updateWorkspaceSession]
  );

  const handleReorderChatTabs = useCallback(
    (tabId: string, toIndex: number) => {
      setTabs((current) => {
        const fromIndex = current.findIndex((t) => t.id === tabId);
        if (
          fromIndex < 0 ||
          toIndex < 0 ||
          toIndex > current.length ||
          fromIndex === toIndex
        ) {
          return current;
        }
        const next = [...current];
        const [item] = next.splice(fromIndex, 1);
        const insertAt = fromIndex < toIndex ? toIndex - 1 : toIndex;
        next.splice(insertAt, 0, item);
        return next;
      });
    },
    [setTabs]
  );

  const handleRenameChatTab = useCallback(
    (tabId: string, title: string) => {
      const trimmed = title.trim();
      if (!trimmed) {
        return;
      }
      void updateAgentConversationConfig(tabId, { title: trimmed })
        .then((result) => upsertConversation(result.conversation))
        .catch(() => undefined);
    },
    [upsertConversation]
  );

  const handleNewChat = useCallback(() => {
    if (expandedComposerDraftId) {
      setExpandedComposerDraft(null);
    }
    void createConversationAndOpen();
  }, [createConversationAndOpen, expandedComposerDraftId, setExpandedComposerDraft]);

  const closeChatTab = useCallback((tabId: string) => {
    const currentTabs = tabsRef.current;
    const remaining = currentTabs.filter((tab) => tab.id !== tabId);
    if (expandedComposerDraftId === tabId) {
      setExpandedComposerDraft(null);
    }
    if (remaining.length === 0) {
      void persistClosedTabsNow([], [tabId]);
      void createConversationAndOpen();
      return;
    }
    const closingActive = currentTabs.find((tab) => tab.id === tabId)?.active;
    const nextTabs = !closingActive
      ? remaining
      : remaining.map((tab, index) => ({ ...tab, active: index === 0 }));
    void persistClosedTabsNow(nextTabs, [tabId]);
  }, [createConversationAndOpen, expandedComposerDraftId, persistClosedTabsNow, setExpandedComposerDraft]);

  const closeOtherChatTabs = useCallback(
    (tabId: string) => {
      const keep = tabsRef.current.find((tab) => tab.id === tabId);
      if (!keep) {
        return;
      }
      if (expandedComposerDraftId && expandedComposerDraftId !== tabId) {
        setExpandedComposerDraft(null);
      }
      const closedIds = tabsRef.current
        .filter((tab) => tab.id !== tabId)
        .map((tab) => tab.id);
      void persistClosedTabsNow([{ ...keep, active: true }], closedIds);
    },
    [expandedComposerDraftId, persistClosedTabsNow, setExpandedComposerDraft]
  );

  const closeAllChatTabs = useCallback(() => {
    if (expandedComposerDraftId) {
      setExpandedComposerDraft(null);
    }
    void persistClosedTabsNow([], tabsRef.current.map((tab) => tab.id));
    void createConversationAndOpen();
  }, [createConversationAndOpen, expandedComposerDraftId, persistClosedTabsNow, setExpandedComposerDraft]);

  const handleResolveActivePermission = useCallback(
    (requestId: string, optionId: string) => {
      if (!activeConversation) {
        return;
      }
      void answerPermissionForConversation(activeConversation.id, requestId, optionId);
    },
    [activeConversation, answerPermissionForConversation]
  );

  const handleCancelActivePermission = useCallback(
    (requestId: string) => {
      if (!activeConversation) {
        return;
      }
      void cancelPermissionForConversation(activeConversation.id, requestId);
    },
    [activeConversation, cancelPermissionForConversation]
  );

  const handleScrollTopSettled = useCallback(
    (scrollTop: number) => {
      updateWorkspaceSession((current) =>
        Math.abs((current.chat.scrollTopByTabId[activeTabId] ?? 0) - scrollTop) < 1
          ? current
          : {
              ...current,
              chat: {
                ...current.chat,
                scrollTopByTabId: {
                  ...current.chat.scrollTopByTabId,
                  [activeTabId]: scrollTop,
                },
              },
            }
      );
    },
    [activeTabId, updateWorkspaceSession]
  );

  const moveConversationToWorkspaceWindow = useCallback(
    async (
      conversationId: string,
      target: "new-window" | { windowId: string }
    ) => {
      if (!activeWorkspaceId) {
        flashError("No active workspace.");
        return;
      }
      const nextWindow =
        target === "new-window"
          ? await createWorkspaceWindow({ workspaceId: activeWorkspaceId })
          : { window: { id: target.windowId } };
      const nextSession = normalizeWorkspaceWindowSession({
        ...createPersistableWorkspaceSession(workspaceSession),
        chat: {
          ...workspaceSession.chat,
          tabs: [
            {
              id: conversationId,
              title: conversationsById[conversationId]?.title ?? "Chat",
              active: true,
            },
          ],
          hiddenConversationIds: [
            FRESH_WORKSPACE_WINDOW_HIDDEN_CONVERSATIONS_SENTINEL,
          ],
          scrollTopByTabId: {
            [conversationId]:
              workspaceSession.chat.scrollTopByTabId[conversationId] ?? 0,
          },
        },
      });
      await saveWorkspaceWindowSession(
        activeWorkspaceId,
        nextWindow.window.id,
        nextSession
      );
      const remainingTabs = tabsRef.current.filter((tab) => tab.id !== conversationId);
      const nextTabs = remainingTabs.map((tab, index) => ({
        ...tab,
        active:
          remainingTabs.length > 0
            ? tab.active && tab.id !== conversationId
              ? true
              : !remainingTabs.some((candidate) => candidate.active) && index === 0
            : false,
      }));
      await persistClosedTabsNow(nextTabs, [conversationId]);
      const openedWindow = window.open(
        buildWorkspaceWindowUrl(
          window.location.origin,
          activeWorkspaceId,
          nextWindow.window.id
        ),
        "_blank",
        "noopener,noreferrer"
      );
      if (!openedWindow) {
        flashError("Popup blocked while opening the workspace window.");
      }
    },
    [
      activeWorkspaceId,
      conversationsById,
      flashError,
      persistClosedTabsNow,
      workspaceSession,
    ]
  );

  const handleChatTabContextMenu = useCallback(
    (e: MouseEvent, tabId: string) => {
      const othersOpen = tabs.length > 1;
      const targetConversation = conversationsById[tabId];
      const pinnedIds = globalPinnedAgentConversationIds;
      const tabIsPinned = pinnedIds.includes(tabId);
      const items: WorkbenchMenuItem[] = [
        {
          type: "item",
          id: "rename",
          label: "Rename",
          onSelect: () => setChatTabRenameTargetId(tabId),
        },
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
        { type: "sep" },
        {
          type: "item",
          id: "open-editor",
          label: "Open in Editor",
          disabled: !targetConversation,
          onSelect: () => {
            if (!targetConversation) {
              return;
            }
            openAgentConversation({
              conversationId: tabId,
              title: targetConversation.title,
            });
          },
        },
        {
          type: "item",
          id: tabIsPinned ? "unpin" : "pin",
          label: tabIsPinned ? "Unpin" : "Pin",
          disabled: !isPersistedConversationTabId(tabId),
          onSelect: () => {
            if (!isPersistedConversationTabId(tabId)) {
              return;
            }
            const prev = getGlobalPinnedAgentConversationIdsSnapshot();
            if (tabIsPinned) {
              if (!prev.includes(tabId)) {
                return;
              }
              const next = prev.filter((id) => id !== tabId);
              writeGlobalPinnedAgentConversationIds(next);
              updateWorkspaceSession((current) => ({
                ...current,
                agentView: {
                  ...current.agentView,
                  pinnedAgentConversationIds: next,
                },
              }));
              return;
            }
            const next = [tabId, ...prev.filter((id) => id !== tabId)];
            writeGlobalPinnedAgentConversationIds(next);
            updateWorkspaceSession((current) => ({
              ...current,
              agentView: {
                ...current.agentView,
                pinnedAgentConversationIds: next,
              },
            }));
          },
        },
        {
          type: "item",
          id: "archive",
          label: "Archive",
          onSelect: () => {
            updateWorkspaceSession((current) => {
              const archived = current.agentView.archivedConversationIds ?? [];
              if (archived.includes(tabId)) return current;
              return {
                ...current,
                agentView: {
                  ...current.agentView,
                  archivedConversationIds: [...archived, tabId],
                },
              };
            });
            closeChatTab(tabId);
          },
        },
        { type: "sep" },
        {
          type: "item",
          id: "move-new-window",
          label: "Move to New Workspace Window",
          onSelect: () =>
            void moveConversationToWorkspaceWindow(tabId, "new-window"),
        },
        ...workspaceWindows
          .filter(
            (windowRecord) =>
              !windowRecord.closedAt && windowRecord.id !== activeWindowId
          )
          .map<WorkbenchMenuItem>((windowRecord) => ({
            type: "item",
            id: `move-window:${windowRecord.id}`,
            label: `Move to Workspace Window: ${windowRecord.label}`,
            onSelect: () =>
              void moveConversationToWorkspaceWindow(tabId, {
                windowId: windowRecord.id,
              }),
          })),
        {
          type: "item",
          id: "open-editor-side",
          label: "Open in Side-by-Side Editor",
          disabled: !targetConversation,
          onSelect: () => {
            if (!targetConversation) {
              return;
            }
            openAgentConversation({
              conversationId: tabId,
              title: targetConversation.title,
              group: "right",
            });
          },
        },
      ];
      openAt(e, items);
    },
    [
      activeWindowId,
      closeChatTab,
      closeOtherChatTabs,
      conversationsById,
      moveConversationToWorkspaceWindow,
      openAgentConversation,
      openAt,
      tabs,
      updateWorkspaceSession,
      globalPinnedAgentConversationIds,
      workspaceWindows,
    ]
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

  const submitPromptForDraft = useCallback(
    async (draftId: string, text: string, attachments?: ImageAttachment[], options?: { skipQueue?: boolean }) => {
      let conversationIdForError = conversationsById[draftId]?.id;
      try {
        const conversation =
          conversationsById[draftId] ??
          (draftId === activeConversation?.id ? activeConversation : null) ??
          (await createConversationAndOpen());
        conversationIdForError = conversation.id;
        if (
          !options?.skipQueue &&
          (conversation.status === "running" ||
            conversation.status === "awaiting_permission")
        ) {
          const convId = conversation.id;
          const entryId = globalThis.crypto?.randomUUID?.() ?? `q-${Date.now()}`;
          updateWorkspaceSession((current) => {
            const map = { ...(current.chat.queuedPromptsByConversationId ?? {}) };
            const prev = map[convId] ?? [];
            return {
              ...current,
              chat: {
                ...current.chat,
                queuedPromptsByConversationId: {
                  ...map,
                  [convId]: [...prev, { id: entryId, text, attachments }],
                },
              },
            };
          });
          return true;
        }
        const snapshot = await promptAgentConversation(conversation.id, text, attachments);
        mergeSnapshot(snapshot.snapshot);
        return true;
      } catch (error) {
        const message =
          error instanceof Error ? error.message : "Failed to start the agent turn.";
        if (conversationIdForError) {
          const errConvId = conversationIdForError;
          setEventsByConversationId((current) => {
            const existing = current[errConvId] ?? [];
            const nextSeq = getConversationLatestSeq(existing) + 1;
            return {
              ...current,
              [errConvId]: [
                ...existing,
                {
                  seq: nextSeq,
                  eventId:
                    globalThis.crypto?.randomUUID?.() ?? `local-error-${Date.now()}`,
                  conversationId: errConvId,
                  createdAt: Date.now(),
                  kind: "system",
                  level: "error",
                  text: message,
                },
              ],
            };
          });
          return false;
        }
        pushNotification({
          kind: WORKBENCH_NOTIFICATION_KIND.editorNotice,
          severity: "error",
          title: "Agent",
          message,
          autoDismissMs: 8000,
        });
        return false;
      }
    },
    [
      activeConversation,
      conversationsById,
      createConversationAndOpen,
      mergeSnapshot,
      pushNotification,
      updateWorkspaceSession,
    ]
  );

  const submitPromptForDraftRef = useRef(submitPromptForDraft);
  submitPromptForDraftRef.current = submitPromptForDraft;

  useEffect(() => {
    const queuedMap = workspaceSession.chat.queuedPromptsByConversationId ?? {};
    for (const conversationId of Object.keys(queuedMap)) {
      const queue = queuedMap[conversationId];
      if (!queue?.length) continue;
      const conv = conversationsById[conversationId];
      if (!conv || conv.status !== "idle") continue;
      if (!tryBeginQueuedPromptFlush(conversationId)) continue;

      const [head, ...tail] = queue;
      updateWorkspaceSession((current) => {
        const m = { ...(current.chat.queuedPromptsByConversationId ?? {}) };
        if (tail.length === 0) {
          delete m[conversationId];
        } else {
          m[conversationId] = tail;
        }
        return {
          ...current,
          chat: {
            ...current.chat,
            queuedPromptsByConversationId: m,
          },
        };
      });

      void (async () => {
        try {
          await submitPromptForDraftRef.current(conversationId, head.text, head.attachments, {
            skipQueue: true,
          });
        } finally {
          endQueuedPromptFlush(conversationId);
        }
      })();
    }
  }, [
    conversationsById,
    updateWorkspaceSession,
    workspaceSession.chat.queuedPromptsByConversationId,
  ]);

  const cancelPromptForDraft = useCallback(
    async (draftId: string) => {
      const conversation = conversationsById[draftId];
      if (!conversation) {
        return;
      }
      try {
        const result = await cancelAgentConversation(conversation.id);
        upsertConversation(result.conversation);
      } catch {
        syncConversationSnapshot(conversation.id);
      }
    },
    [conversationsById, syncConversationSnapshot, upsertConversation]
  );

  const expandedComposerState = useMemo(() => {
    if (!expandedComposerDraftId) {
      return null;
    }
    const state = resolveComposerStateForDraft(expandedComposerDraftId);
    const title =
      composerDrafts[expandedComposerDraftId]?.title ??
      (state.conversation?.title && state.conversation.title !== "New chat"
        ? `${state.conversation.title} prompt`
        : "Composer");
    return {
      draftId: expandedComposerDraftId,
      title,
      mode: state.mode,
      onModeChange: (next: EditorMode) =>
        void setModeForDraft(expandedComposerDraftId, next),
      model: state.model,
      onModelChange: (next: ModelInfo) =>
        void setModelForDraft(expandedComposerDraftId, next),
      backendId: state.backendId,
      backends,
      onBackendChange: (next: AgentBackendId) =>
        void setBackendForDraft(expandedComposerDraftId, next),
      models: state.models.length > 0 ? state.models : [state.model],
      modeOptions: state.modeOptions,
      sessionConfigOptions: state.sessionConfigOptions,
      onSessionConfigOptionChange: (configId: string, value: string) =>
        void setSessionConfigOptionForDraft(expandedComposerDraftId, configId, value),
      onSubmit: (text: string, attachments?: ImageAttachment[]) => {
        void submitPromptForDraft(expandedComposerDraftId, text, attachments);
      },
      onCancel: () => cancelPromptForDraft(expandedComposerDraftId),
      busy: state.busy,
      configLocked: false,
    };
  }, [
    backends,
    cancelPromptForDraft,
    composerDrafts,
    expandedComposerDraftId,
    resolveComposerStateForDraft,
    setBackendForDraft,
    setModeForDraft,
    setModelForDraft,
    setSessionConfigOptionForDraft,
    submitPromptForDraft,
  ]);

  useEffect(() => {
    setExpandedComposerController(expandedComposerState);
  }, [expandedComposerState, setExpandedComposerController]);

  useEffect(
    () => () => {
      setExpandedComposerController(null);
    },
    [setExpandedComposerController]
  );

  const composerHiddenForExpanded = expandedComposerDraftId === composerDraftId;

  const composer = (
    <ChatComposer
      key={composerDraftId}
      mode={mode}
      onModeChange={(next) => void setModeForDraft(composerDraftId, next)}
      model={model}
      onModelChange={(next) => void setModelForDraft(composerDraftId, next)}
      backendId={backendId}
      backends={backends}
      onBackendChange={(next) => void setBackendForDraft(composerDraftId, next)}
      models={models.length > 0 ? models : [model]}
      modeOptions={modeOptions}
      sessionConfigOptions={sessionConfigOptions}
      onSessionConfigOptionChange={(configId, value) =>
        void setSessionConfigOptionForDraft(composerDraftId, configId, value)
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
      busy={busy}
      configLocked={configLocked}
      onSubmit={(text, attachments) => {
        void submitPromptForDraft(composerDraftId, text, attachments);
      }}
      onCancel={() => cancelPromptForDraft(composerDraftId)}
      layout={isEmptyThread ? "empty-top" : "docked-bottom"}
    />
  );

  const recentChatsSection = showRecentChatsSection ? (
    <div className="flex flex-col gap-[2px]">
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
      {recentConversationPreview.map((conversation) => (
        <button
          key={conversation.id}
          type="button"
          onClick={() => openConversationById(conversation.id)}
          className="flex items-center gap-[10px] rounded-[8px] px-[8px] py-[7px] text-left transition-colors hover:bg-[color-mix(in_srgb,var(--bg-card-hover)_75%,transparent)]"
        >
          <span className="min-w-0 flex-1 truncate font-sans text-[13px] font-normal text-[var(--text-primary)]">
            {conversation.title}
          </span>
          <span className="shrink-0 font-sans text-[11px] font-normal text-[var(--text-secondary)]">
            {formatRecentConversationTime(conversation.updatedAt)}
          </span>
        </button>
      ))}
    </div>
  ) : null;

  return (
    <div className="flex h-full min-h-0 w-full flex-col overflow-hidden bg-[var(--bg-panel)]">
      <div className="shrink-0">
        <ChatTabs
          tabs={tabs}
          agentTabIndicators={agentTabIndicators}
          onSelectTab={handleSelectTab}
          onCloseTab={closeChatTab}
          onNewChat={handleNewChat}
          onTabContextMenu={handleChatTabContextMenu}
          onStripContextMenu={handleChatStripContextMenu}
          onReorderTabs={handleReorderChatTabs}
          onRenameTab={handleRenameChatTab}
          externalRenameTabId={chatTabRenameTargetId}
          onExternalRenameConsumed={() => setChatTabRenameTargetId(null)}
        />
      </div>

      {isEmptyThread ? (
        <div className="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden">
          {!composerHiddenForExpanded ? (
            <div className="shrink-0">
              {activeQueuedPrompts.length > 0 ? (
                <ComposerQueueDock
                  items={activeQueuedPrompts}
                  onDelete={removeQueuedPromptForActiveChat}
                  onUnqueue={unqueuePromptToComposer}
                />
              ) : null}
              {composer}
            </div>
          ) : null}
          <div className="min-h-0 flex-1 bg-[var(--bg-panel)] px-[10px] pb-[12px] pt-[10px]">
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
            key={activeTabId}
            messages={scrollMessages}
            conversationId={activeTabId}
            conversationBusy={
              activeConversation?.status === "running" ||
              activeConversation?.status === "awaiting_permission"
            }
            hasOlderHistory={panelHistoryCursor.hasOlder}
            loadingOlderHistory={panelHistoryCursor.loadingOlder}
            onRequestOlderHistory={
              activeTabId && activeTabId !== "__empty__"
                ? () => loadOlderConversationHistory(activeTabId)
                : undefined
            }
            onResolvePermission={handleResolveActivePermission}
            onCancelPermission={handleCancelActivePermission}
            initialScrollTop={workspaceSession.chat.scrollTopByTabId[activeTabId] ?? 0}
            onScrollTopSettled={handleScrollTopSettled}
            bottomDockVisible={!composerHiddenForExpanded}
          />
          {!composerHiddenForExpanded ? (
            <div className="pointer-events-none absolute inset-x-0 bottom-0 z-30">
              <div className="pointer-events-auto chat-bottom-dock">
                {recentChatsSection ? (
                  <div className="px-[10px] pt-[8px]">{recentChatsSection}</div>
                ) : null}
                {dockedAskSteps.length > 0 ? (
                  <div className="px-[10px] pt-[8px]">
                    <AskQuestionCard steps={dockedAskSteps} dockAboveComposer />
                  </div>
                ) : null}
                {activeQueuedPrompts.length > 0 ? (
                  <div className="px-[10px] pt-[8px]">
                    <ComposerQueueDock
                      items={activeQueuedPrompts}
                      onDelete={removeQueuedPromptForActiveChat}
                      onUnqueue={unqueuePromptToComposer}
                    />
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
        onSelectConversation={openConversationById}
      />
    </div>
  );
}
