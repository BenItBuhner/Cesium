"use client";

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import {
  buildConversationModeOptions,
  buildConversationModelOptions,
  dedupeAgentStoredEvents,
  getConversationLatestSeq,
  isIncomingEventDroppedByAcpToolStrip,
  resolveConversationModel,
} from "@/lib/agent-chat";
import { DEFAULT_MODE_OPTIONS, resolveCanonicalModeId } from "@/lib/chat-modes";
import { listSupplementaryAgentConfigOptions } from "@/lib/agent-config-option-utils";
import type {
  AgentBackendId,
  AgentBackendInfo,
  AgentConfigOption,
  AgentConversationCreateInput,
  AgentConversationEventWindow,
  AgentConversationRecord,
  AgentConversationSnapshot,
  AgentConversationSnapshotHead,
  AgentSocketServerMessage,
  AgentStoredEvent,
} from "@/lib/agent-types";
import type { AgentModeOption, EditorMode, ImageAttachment, ModelInfo, QueuedPromptConfigOverride } from "@/lib/types";
import { useWorkspace } from "@/contexts/WorkspaceContext";
import { useGlobalSettings } from "@/components/preferences/GlobalSettingsProvider";
import { nextUnreadCompletionMap } from "@/lib/chat-unread-completion";
import {
  AGENT_NEW_CHAT_SESSION_ID,
  createEmptyEditorSession,
  getAgentSidePaneSessionScopeId,
} from "@/lib/workspace-session";
import { resolveEffectiveConfig } from "@/lib/queued-prompt-utils";
import { useShellView } from "@/components/layout/ShellViewContext";
import { normalizeEditorPanelState } from "@/components/editor/editor-panel-state";
import { JsonWebSocket } from "@/lib/ws-client";
import { recordPerfSample } from "@/lib/dev-perf";
import {
  dispatchAgentConversationDeleted,
  dispatchAgentConversationUpserted,
} from "@/lib/agent-conversation-events";
import {
  answerAgentPermission,
  buildAgentWebSocketUrl,
  cancelAgentConversation,
  createAndPromptAgentConversation,
  createAgentConversation,
  fetchAgentConversationSnapshot,
  forkAgentConversation,
  handoffAgentConversation,
  listAgentConversations,
  promptAgentConversation,
  updateAgentConversationConfig,
} from "@/lib/server-api";

function toConversationMap(
  conversations: AgentConversationRecord[]
): Record<string, AgentConversationRecord> {
  return Object.fromEntries(
    conversations.map((conversation) => [conversation.id, conversation])
  );
}

function agentSocketMessageWorkspaceScope(
  message: AgentSocketServerMessage
): string | null {
  switch (message.type) {
    case "conversation":
    case "conversation_upserted":
      return message.conversation.workspaceId;
    case "snapshot":
    case "snapshot_head":
      return message.snapshot.conversation.workspaceId;
    case "history_page":
    case "event":
    case "event_batch":
    case "conversation_deleted":
      return message.workspaceId;
    default:
      return null;
  }
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

function mergeConversationByRecency(
  existing: AgentConversationRecord | undefined,
  incoming: AgentConversationRecord
): AgentConversationRecord {
  const incomingWithQueue: AgentConversationRecord = {
    ...incoming,
    queuedPrompts: incoming.queuedPrompts ?? [],
  };
  if (!existing) {
    return incomingWithQueue;
  }
  if (incomingWithQueue.updatedAt > existing.updatedAt) {
    return incomingWithQueue;
  }
  if (incomingWithQueue.updatedAt < existing.updatedAt) {
    if (incomingWithQueue.lastEventSeq > existing.lastEventSeq) {
      return { ...incomingWithQueue, updatedAt: existing.updatedAt };
    }
    const metaChanged =
      existing.status !== incomingWithQueue.status ||
      JSON.stringify(existing.pendingPermission) !==
        JSON.stringify(incomingWithQueue.pendingPermission) ||
      existing.title !== incomingWithQueue.title ||
      existing.lastError !== incomingWithQueue.lastError ||
      existing.archivedAt !== incomingWithQueue.archivedAt ||
      JSON.stringify(existing.queuedPrompts ?? []) !==
        JSON.stringify(incomingWithQueue.queuedPrompts ?? []);
    if (metaChanged) {
      return {
        ...existing,
        ...incomingWithQueue,
        updatedAt: existing.updatedAt,
      };
    }
    return existing;
  }
  return incomingWithQueue;
}

function conversationNeedsRuntimeHydration(
  conversation: AgentConversationRecord | null | undefined
): conversation is AgentConversationRecord {
  if (!conversation) {
    return false;
  }
  return (
    conversation.configOptions.length === 0 ||
    conversation.providerSessionId == null ||
    !conversation.capabilities.supportsLoadSession ||
    (conversation.config.backendId === "cursor-acp" &&
      (!conversation.capabilities.supportsPermissions ||
        !conversation.capabilities.supportsSessionResume)) ||
    ((conversation.status === "running" ||
      conversation.status === "awaiting_permission") &&
      conversation.providerSessionId == null)
  );
}

function runtimeHydrationSignature(conversation: AgentConversationRecord): string {
  return [
    conversation.updatedAt,
    conversation.status,
    conversation.lastEventSeq,
    conversation.providerSessionId ?? "",
    conversation.config.backendId,
    conversation.config.mode,
    conversation.configOptions.length,
    conversation.capabilities.supportsLoadSession ? 1 : 0,
    conversation.capabilities.supportsPermissions ? 1 : 0,
    conversation.capabilities.supportsSessionResume ? 1 : 0,
  ].join(":");
}

type ConversationComposerState = {
  conversation: AgentConversationRecord | null;
  backendId: AgentBackendId;
  models: ModelInfo[];
  model: ModelInfo;
  modeOptions: AgentModeOption[];
  mode: EditorMode;
  sessionConfigOptions: AgentConfigOption[];
  busy: boolean;
};

type ConversationLoadStatus = "idle" | "loading" | "ready" | "error";

const BACKGROUND_SNAPSHOT_COOLDOWN_MS = 60_000;

export type ConversationHistoryCursor = {
  hasOlder: boolean;
  loadingOlder: boolean;
};

type AgentConversationsContextValue = {
  backends: AgentBackendInfo[];
  conversationsById: Record<string, AgentConversationRecord>;
  conversations: AgentConversationRecord[];
  eventsByConversationId: Record<string, AgentStoredEvent[]>;
  bootstrapped: boolean;
  getConversationLoadStatus: (conversationId: string) => ConversationLoadStatus;
  createConversation: (
    input?: AgentConversationCreateInput
  ) => Promise<AgentConversationRecord>;
  createAndPromptConversation: (
    input: AgentConversationCreateInput,
    text: string,
    attachments?: ImageAttachment[]
  ) => Promise<AgentConversationRecord | null>;
  renameConversation: (conversationId: string, title: string) => Promise<void>;
  /** Merge a conversation record from push/HTTP (title, status, unread, tab strip). */
  upsertConversation: (conversation: AgentConversationRecord) => void;
  answerPermissionForConversation: (
    conversationId: string,
    requestId: string,
    optionId: string
  ) => Promise<void>;
  cancelPermissionForConversation: (
    conversationId: string,
    requestId: string
  ) => Promise<void>;
  setConversationMode: (
    conversationId: string,
    mode: EditorMode
  ) => Promise<void>;
  setConversationModel: (
    conversationId: string,
    model: ModelInfo
  ) => Promise<void>;
  setConversationBackend: (
    conversationId: string,
    backendId: AgentBackendId
  ) => Promise<void>;
  setConversationConfigOption: (
    conversationId: string,
    configId: string,
    value: string
  ) => Promise<void>;
  promptConversation: (conversationId: string, text: string, attachments?: ImageAttachment[], configOverride?: QueuedPromptConfigOverride) => Promise<boolean>;
  cancelConversation: (conversationId: string) => Promise<void>;
  pendingConfigByConversationId: Record<string, QueuedPromptConfigOverride>;
  setPendingConfigForConversation: (conversationId: string, patch: Partial<QueuedPromptConfigOverride>) => void;
  clearPendingConfigForConversation: (conversationId: string) => void;
  getConversationComposerState: (
    conversationId: string
  ) => ConversationComposerState | null;
  syncConversationSnapshot: (
    conversationId: string,
    options?: { hydrateRuntime?: boolean }
  ) => Promise<void>;
  /** Merge a snapshot from HTTP or WebSocket (prompt result, snapshot_head, etc.). */
  mergeConversationSnapshot: (
    snapshot: AgentConversationSnapshot | AgentConversationSnapshotHead
  ) => void;
  /** Re-fetch conversation list + backends (e.g. after visibility change). */
  refreshConversations: () => Promise<AgentConversationRecord[]>;
  forkConversation: (
    conversationId: string,
    options?: { upToMessageId?: string }
  ) => Promise<AgentConversationRecord>;
  getConversationHistoryCursor: (conversationId: string) => ConversationHistoryCursor;
  loadOlderConversationHistory: (conversationId: string) => void;
};

const AgentConversationsContext =
  createContext<AgentConversationsContextValue | null>(null);

export function AgentConversationsProvider({
  children,
}: {
  children: ReactNode;
}) {
  const {
    activeWorkspaceId,
    markWorkspaceActivity,
    workspaceSession,
    updateWorkspaceSession,
  } = useWorkspace();
  const activeWorkspaceIdRef = useRef<string | null>(activeWorkspaceId);
  activeWorkspaceIdRef.current = activeWorkspaceId;
  const { settings: globalSettings } = useGlobalSettings();
  const [backends, setBackends] = useState<AgentBackendInfo[]>([]);
  const [conversationsById, setConversationsById] = useState<
    Record<string, AgentConversationRecord>
  >({});
  const [eventsByConversationId, setEventsByConversationId] = useState<
    Record<string, AgentStoredEvent[]>
  >({});
  const [bootstrapped, setBootstrapped] = useState(false);
  const [conversationLoadStatusById, setConversationLoadStatusById] = useState<
    Record<string, ConversationLoadStatus>
  >({});
  const [historyMetaById, setHistoryMetaById] = useState<
    Record<string, { hasOlder: boolean }>
  >({});
  const [loadingOlderById, setLoadingOlderById] = useState<Record<string, boolean>>({});
 const [pendingConfigByConversationId, setPendingConfigByConversationId] = useState<Record<string, QueuedPromptConfigOverride>>({});
  const pendingConfigRef = useRef(pendingConfigByConversationId);
  pendingConfigRef.current = pendingConfigByConversationId;
  const historyMetaRef = useRef(historyMetaById);
  const loadingOlderRef = useRef<Record<string, boolean>>({});
  const socketRef = useRef<JsonWebSocket<AgentSocketServerMessage> | null>(null);
  const subscribeDebounceTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const openConversationsSyncTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const chatDraftRef = useRef(workspaceSession.chat);
  const eventsRef = useRef(eventsByConversationId);
  const loadedSnapshotConversationIdsRef = useRef(new Set<string>());
  const backgroundSnapshotCooldownUntilRef = useRef<Record<string, number>>({});
  const openConversationIdsRef = useRef<string[]>([]);
  const snapshotPrimeInFlightRef = useRef(new Set<string>());
  const hydratingConversationIdsRef = useRef(new Set<string>());
  const runtimeHydrationSignatureByIdRef = useRef<Record<string, string>>({});
  /** Successful `history_page` responses per conversation (first fetch asks for a larger page). */
  const historyOlderPagesFetchedRef = useRef<Record<string, number>>({});
  const conversationsByIdRef = useRef(conversationsById);
  conversationsByIdRef.current = conversationsById;

  useEffect(() => {
    chatDraftRef.current = workspaceSession.chat;
  }, [workspaceSession.chat]);

  useEffect(() => {
    eventsRef.current = eventsByConversationId;
  }, [eventsByConversationId]);

  useEffect(() => {
    historyMetaRef.current = historyMetaById;
  }, [historyMetaById]);

  const { shellView } = useShellView();
  const isAgentRoute = shellView === "agent";
  const requestedConversationIdFromLocation =
    isAgentRoute && typeof window !== "undefined"
      ? new URL(window.location.href).searchParams.get("conversationId")?.trim() || null
      : null;
  const activeSelectedConversationId =
    requestedConversationIdFromLocation &&
    requestedConversationIdFromLocation !== AGENT_NEW_CHAT_SESSION_ID
      ? requestedConversationIdFromLocation
      : workspaceSession.agentView.selectedConversationId &&
          workspaceSession.agentView.selectedConversationId !== AGENT_NEW_CHAT_SESSION_ID
        ? workspaceSession.agentView.selectedConversationId
        : null;
  const activeAgentSidePaneEditor = useMemo(() => {
    const scopeId = getAgentSidePaneSessionScopeId(
      requestedConversationIdFromLocation ?? workspaceSession.agentView.selectedConversationId
    );
    return (
      workspaceSession.agentView.sidePaneSessionsByConversationId?.[scopeId]?.editor ??
      null
    );
  }, [
    requestedConversationIdFromLocation,
    workspaceSession.agentView.sidePaneSessionsByConversationId,
    workspaceSession.agentView.selectedConversationId,
  ]);
  const scopedEditorSession =
    isAgentRoute
      ? activeAgentSidePaneEditor ??
        (Object.keys(workspaceSession.agentView.sidePaneSessionsByConversationId ?? {}).length ===
        0
          ? workspaceSession.editor
          : createEmptyEditorSession())
      : workspaceSession.editor;

  const conversations = useMemo(
    () =>
      Object.values(conversationsById).sort((a, b) => b.updatedAt - a.updatedAt),
    [conversationsById]
  );

  const openConversationIds = useMemo(() => {
    const ids = new Set<string>();
    if (activeSelectedConversationId) {
      ids.add(activeSelectedConversationId);
    }
    for (const tab of scopedEditorSession.leftTabs) {
      if (tab.conversationId) {
        ids.add(tab.conversationId);
      }
    }
    for (const tab of scopedEditorSession.rightTabs) {
      if (tab.conversationId) {
        ids.add(tab.conversationId);
      }
    }
    // IDE chat tabs (session.chat.tabs) are separate from editor tabs; include them
    // so the agent socket subscribes without needing a second WebSocket in ChatPanel.
    for (const tab of workspaceSession.chat.tabs) {
      if (tab.id) {
        ids.add(tab.id);
      }
    }
    return [...ids];
  }, [
    activeSelectedConversationId,
    scopedEditorSession.leftTabs,
    scopedEditorSession.rightTabs,
    workspaceSession.chat.tabs,
  ]);

  useEffect(() => {
    openConversationIdsRef.current = openConversationIds;
  }, [openConversationIds]);

  const visibleConversationIds = useMemo(() => {
    const ids = new Set<string>();
    if (activeSelectedConversationId) {
      ids.add(activeSelectedConversationId);
    }
    const leftActive = scopedEditorSession.leftTabs.find(
      (tab) => tab.id === scopedEditorSession.leftActiveId
    );
    if (leftActive?.conversationId) {
      ids.add(leftActive.conversationId);
    }

    const rightActive = scopedEditorSession.rightTabs.find(
      (tab) => tab.id === scopedEditorSession.rightActiveId
    );
    if (rightActive?.conversationId) {
      ids.add(rightActive.conversationId);
    }

    return [...ids];
  }, [
    activeSelectedConversationId,
    scopedEditorSession.leftActiveId,
    scopedEditorSession.leftTabs,
    scopedEditorSession.rightActiveId,
    scopedEditorSession.rightTabs,
  ]);

  /** Keep background snapshot work off the critical path; selected/visible panes load explicitly. */
  const prefetchTargetConversationIds = useMemo(() => {
    const ids: string[] = [];
    const seen = new Set<string>();
    for (const id of visibleConversationIds) {
      if (!id || seen.has(id)) {
        continue;
      }
      seen.add(id);
      ids.push(id);
    }
    return ids;
  }, [visibleConversationIds]);

  const mergeConversationSnapshot = useCallback(
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
          const mergedEvents = dedupeAgentStoredEvents(
            [...bySeq.values()].sort((a, b) => a.seq - b.seq)
          );
          return { ...current, [incoming.id]: mergedEvents };
        });
        setHistoryMetaById((c) => ({
          ...c,
          [incoming.id]: { hasOlder: head.window.hasOlder },
        }));
      } else {
        const full = snapshot as AgentConversationSnapshot;
        setEventsByConversationId((current) => {
          const existing = dedupeAgentStoredEvents(current[full.conversation.id] ?? []);
          const existingSeq = existing.at(-1)?.seq ?? 0;
          const incomingDeduped = dedupeAgentStoredEvents(full.events);
          const incomingSeq = incomingDeduped.at(-1)?.seq ?? 0;
          return {
            ...current,
            [full.conversation.id]:
              incomingSeq >= existingSeq ? incomingDeduped : existing,
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
        tab.id === incoming.id
          ? {
              ...tab,
              title: incoming.lastEventSeq > 0 && tab.isDraft ? incoming.title : tab.isDraft ? tab.title : incoming.title,
              isDraft: incoming.lastEventSeq > 0 ? undefined : tab.isDraft,
            }
          : tab
      );
      const tabUnchanged = nextTabs.every(
        (tab, index) =>
          tab.id === current.chat.tabs[index]?.id &&
          tab.title === current.chat.tabs[index]?.title &&
          Boolean(tab.active) === Boolean(current.chat.tabs[index]?.active) &&
          Boolean(tab.isDraft) === Boolean(current.chat.tabs[index]?.isDraft)
      );
      if (unreadMap === null && tabUnchanged) {
        return current;
      }
        return {
          ...current,
          chat: {
            ...current.chat,
            ...(unreadMap === null
              ? {}
              : { unreadChatCompletionByConversationId: unreadMap }),
            ...(!tabUnchanged ? { tabs: nextTabs } : {}),
          },
        };
      });
      setConversationLoadStatusById((current) =>
        current[incoming.id] === "ready"
          ? current
          : {
              ...current,
              [incoming.id]: "ready",
            }
      );
      delete historyOlderPagesFetchedRef.current[incoming.id];
      dispatchAgentConversationUpserted(merged);
      loadedSnapshotConversationIdsRef.current.add(incoming.id);
    },
    [updateWorkspaceSession]
  );

  const primeConversationSnapshotIfEmpty = useCallback(
    async (conversationId: string) => {
      if (!conversationId || conversationId === AGENT_NEW_CHAT_SESSION_ID) {
        return;
      }
      if (conversationId.startsWith("draft-")) {
        return;
      }
      if (loadedSnapshotConversationIdsRef.current.has(conversationId)) {
        return;
      }
      if ((backgroundSnapshotCooldownUntilRef.current[conversationId] ?? 0) > Date.now()) {
        return;
      }
      if (eventsRef.current[conversationId] !== undefined) {
        loadedSnapshotConversationIdsRef.current.add(conversationId);
        return;
      }
      if (snapshotPrimeInFlightRef.current.has(conversationId)) {
        return;
      }
      snapshotPrimeInFlightRef.current.add(conversationId);
      backgroundSnapshotCooldownUntilRef.current[conversationId] =
        Date.now() + BACKGROUND_SNAPSHOT_COOLDOWN_MS;
      const controller = new AbortController();
      const timer = window.setTimeout(() => controller.abort(), 55_000);
      try {
        const result = await fetchAgentConversationSnapshot(conversationId, {
          signal: controller.signal,
        });
        mergeConversationSnapshot(result.snapshot);
      } catch {
        /* background prime */
      } finally {
        window.clearTimeout(timer);
        snapshotPrimeInFlightRef.current.delete(conversationId);
      }
    },
    [mergeConversationSnapshot]
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
        const merged = dedupeAgentStoredEvents(
          [...bySeq.values()].sort((a, b) => a.seq - b.seq)
        );
        return { ...current, [conversationId]: merged };
      });
      setHistoryMetaById((c) => ({
        ...c,
        [conversationId]: { hasOlder: window.hasOlder },
      }));
      historyOlderPagesFetchedRef.current[conversationId] =
        (historyOlderPagesFetchedRef.current[conversationId] ?? 0) + 1;
    },
    []
  );

  const loadOlderConversationHistory = useCallback((conversationId: string) => {
    const socket = socketRef.current;
    if (!socket?.connected) {
      return;
    }
    const meta = historyMetaRef.current[conversationId];
    if (!meta?.hasOlder) {
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
    const pagesDone = historyOlderPagesFetchedRef.current[conversationId] ?? 0;
    socket.send({
      type: "request_history",
      conversationId,
      beforeSeq: oldest,
      ...(pagesDone === 0
        ? { limitTurns: 160, limitEvents: 4000 }
        : {}),
    });
    window.setTimeout(() => {
      if (loadingOlderRef.current[conversationId]) {
        loadingOlderRef.current[conversationId] = false;
        setLoadingOlderById((c) => ({ ...c, [conversationId]: false }));
      }
    }, 18_000);
  }, []);

  const getConversationHistoryCursor = useCallback(
    (conversationId: string): ConversationHistoryCursor => ({
      hasOlder: historyMetaById[conversationId]?.hasOlder ?? false,
      loadingOlder: loadingOlderById[conversationId] ?? false,
    }),
    [historyMetaById, loadingOlderById]
  );

  const appendConversationEvent = useCallback(
    (conversationId: string, event: AgentStoredEvent) => {
      setEventsByConversationId((current) => {
        const existing = current[conversationId] ?? [];
        if (
          existing.some(
            (item) => item.seq === event.seq || item.eventId === event.eventId
          )
        ) {
          return current;
        }
        if (isIncomingEventDroppedByAcpToolStrip(existing, event)) {
          return current;
        }
        return {
          ...current,
          [conversationId]: dedupeAgentStoredEvents([...existing, event]).sort(
            (a, b) => a.seq - b.seq
          ),
        };
      });
    },
    []
  );

  const appendConversationEventBatch = useCallback(
    (conversationId: string, incoming: AgentStoredEvent[]) => {
      if (incoming.length === 0) {
        return;
      }
      setEventsByConversationId((current) => {
        const existing = current[conversationId] ?? [];
        let next: AgentStoredEvent[] = existing;
        for (const event of incoming) {
          if (
            next.some(
              (item) => item.seq === event.seq || item.eventId === event.eventId
            )
          ) {
            continue;
          }
          if (isIncomingEventDroppedByAcpToolStrip(next, event)) {
            continue;
          }
          if (next === existing) {
            next = [...existing];
          }
          next.push(event);
        }
        if (next === existing) {
          return current;
        }
        return {
          ...current,
          [conversationId]: dedupeAgentStoredEvents(next).sort(
            (a, b) => a.seq - b.seq
          ),
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
        tab.id === conversation.id
          ? {
              ...tab,
              title: conversation.lastEventSeq > 0 && tab.isDraft ? conversation.title : tab.isDraft ? tab.title : conversation.title,
              isDraft: conversation.lastEventSeq > 0 ? undefined : tab.isDraft,
            }
          : tab
      );
      const tabUnchanged = nextTabs.every(
        (tab, index) =>
          tab.id === current.chat.tabs[index]?.id &&
          tab.title === current.chat.tabs[index]?.title &&
          Boolean(tab.active) === Boolean(current.chat.tabs[index]?.active) &&
          Boolean(tab.isDraft) === Boolean(current.chat.tabs[index]?.isDraft)
      );
      if (unreadMap === null && tabUnchanged) {
        return current;
      }
        return {
          ...current,
          chat: {
            ...current.chat,
            ...(unreadMap === null
              ? {}
              : { unreadChatCompletionByConversationId: unreadMap }),
            ...(!tabUnchanged ? { tabs: nextTabs } : {}),
          },
        };
      });
    },
    [updateWorkspaceSession]
  );

  const syncSnapshotPromisesRef = useRef(
    new Map<string, Promise<void>>()
  );

  const syncConversationSnapshot = useCallback(
    async (conversationId: string, options?: { hydrateRuntime?: boolean }) => {
      const inFlight = syncSnapshotPromisesRef.current.get(conversationId);
      if (inFlight) {
        return inFlight;
      }
      const run = (async () => {
        const controller = new AbortController();
        const timer = window.setTimeout(() => controller.abort(), 55_000);
        try {
          const result = await fetchAgentConversationSnapshot(conversationId, {
            ...options,
            signal: controller.signal,
          });
          mergeConversationSnapshot(result.snapshot);
        } catch (error) {
          const conv = conversationsByIdRef.current[conversationId];
          const ev = eventsRef.current[conversationId];
          const usable =
            Boolean(conv) &&
            (conv!.lastEventSeq === 0 || (ev != null && ev.length > 0));
          setConversationLoadStatusById((current) => ({
            ...current,
            [conversationId]: usable ? "ready" : "error",
          }));
          if (!usable) {
            throw error;
          }
        } finally {
          window.clearTimeout(timer);
        }
      })();
      syncSnapshotPromisesRef.current.set(conversationId, run);
      try {
        await run;
      } finally {
        syncSnapshotPromisesRef.current.delete(conversationId);
      }
    },
    [mergeConversationSnapshot]
  );

  const renameConversation = useCallback(
    async (conversationId: string, title: string) => {
      const trimmed = title.trim();
      if (!trimmed) {
        return;
      }
      const result = await updateAgentConversationConfig(conversationId, {
        title: trimmed,
      });
      upsertConversation(result.conversation);
      dispatchAgentConversationUpserted(result.conversation);
    },
    [upsertConversation]
  );

  const answerPermissionForConversation = useCallback(
    async (conversationId: string, requestId: string, optionId: string) => {
      try {
        await answerAgentPermission(conversationId, {
          requestId,
          optionId,
        });
        const result = await fetchAgentConversationSnapshot(conversationId);
        mergeConversationSnapshot(result.snapshot);
        dispatchAgentConversationUpserted(result.snapshot.conversation);
      } catch {
        void syncConversationSnapshot(conversationId).catch(() => undefined);
      }
    },
    [mergeConversationSnapshot, syncConversationSnapshot]
  );

  const cancelPermissionForConversation = useCallback(
    async (conversationId: string, requestId: string) => {
      try {
        await answerAgentPermission(conversationId, {
          requestId,
          cancelled: true,
        });
        const result = await fetchAgentConversationSnapshot(conversationId);
        mergeConversationSnapshot(result.snapshot);
        dispatchAgentConversationUpserted(result.snapshot.conversation);
      } catch {
        void syncConversationSnapshot(conversationId).catch(() => undefined);
      }
    },
    [mergeConversationSnapshot, syncConversationSnapshot]
  );

  const setConversationMode = useCallback(
    async (conversationId: string, next: EditorMode) => {
      setConversationsById((current) => {
        const conversation = current[conversationId];
        if (!conversation) {
          return current;
        }
        return {
          ...current,
          [conversationId]: {
            ...conversation,
            config: { ...conversation.config, mode: next },
          },
        };
      });
      try {
        const updated = await updateAgentConversationConfig(conversationId, {
          mode: next,
        });
        upsertConversation(updated.conversation);
      } catch {
        void syncConversationSnapshot(conversationId).catch(() => undefined);
      }
    },
    [syncConversationSnapshot, upsertConversation]
  );

  const setConversationModel = useCallback(
    async (conversationId: string, next: ModelInfo) => {
      const modelId = next.modelValue ?? next.id;
      setConversationsById((current) => {
        const conversation = current[conversationId];
        if (!conversation) {
          return current;
        }
        return {
          ...current,
          [conversationId]: {
            ...conversation,
            config: {
              ...conversation.config,
              modelId,
              modelName: next.name,
            },
          },
        };
      });
      try {
        const updated = await updateAgentConversationConfig(conversationId, {
          modelId,
          modelName: next.name,
          setConfigOptions: next.configSelections,
        });
        upsertConversation(updated.conversation);
      } catch {
        void syncConversationSnapshot(conversationId).catch(() => undefined);
      }
    },
    [syncConversationSnapshot, upsertConversation]
  );

  const setConversationBackend = useCallback(
    async (conversationId: string, nextBackendId: AgentBackendId) => {
      try {
        const result = await handoffAgentConversation(conversationId, nextBackendId);
        await syncConversationSnapshot(result.newConversationId, {
          hydrateRuntime: true,
        });
      } catch {
        void syncConversationSnapshot(conversationId).catch(() => undefined);
      }
    },
    [syncConversationSnapshot]
  );

  const setConversationConfigOption = useCallback(
    async (conversationId: string, configId: string, value: string) => {
      try {
        const updated = await updateAgentConversationConfig(conversationId, {
          setConfigOption: { configId, value },
        });
        upsertConversation(updated.conversation);
      } catch {
        void syncConversationSnapshot(conversationId).catch(() => undefined);
      }
    },
[syncConversationSnapshot, upsertConversation]
);

const setPendingConfigForConversation = useCallback(
(conversationId: string, patch: Partial<QueuedPromptConfigOverride>) => {
setPendingConfigByConversationId((current) => {
const existing = current[conversationId];
const next: QueuedPromptConfigOverride = { ...existing, ...patch };
return { ...current, [conversationId]: next };
});
},
[]
);

const clearPendingConfigForConversation = useCallback(
(conversationId: string) => {
setPendingConfigByConversationId((current) => {
if (!current[conversationId]) return current;
const next = { ...current };
delete next[conversationId];
return next;
});
},
[]
);

const executePrompt = useCallback(
    async (
      conversationId: string,
      text: string,
      attachments?: ImageAttachment[],
      configOverride?: QueuedPromptConfigOverride
    ) => {
      const startedAt = performance.now();
      const clientEventId =
        globalThis.crypto?.randomUUID?.() ?? `local-user-event-${Date.now()}`;
      const clientMessageId =
        globalThis.crypto?.randomUUID?.() ?? `local-user-message-${Date.now()}`;
      const createdAt = Date.now();
      const currentConversation = conversationsByIdRef.current[conversationId];
      const canOptimisticallyAppend =
        currentConversation?.status !== "running" &&
        currentConversation?.status !== "awaiting_permission";
      if (canOptimisticallyAppend) {
        const optimisticConversation: AgentConversationRecord | null = currentConversation
          ? {
              ...currentConversation,
              status: "running",
              updatedAt: Math.max(currentConversation.updatedAt + 1, Date.now()),
            }
          : null;
        setEventsByConversationId((current) => {
          const existing = current[conversationId] ?? [];
          if (existing.some((event) => event.eventId === clientEventId)) {
            return current;
          }
          return {
            ...current,
            [conversationId]: [
              ...existing,
              {
                seq: getConversationLatestSeq(existing) + 1,
                eventId: clientEventId,
                conversationId,
                createdAt,
                kind: "user_message",
                messageId: clientMessageId,
                content: text,
                attachments,
              },
            ],
          };
        });
        setConversationsById((current) => {
          if (!optimisticConversation || !current[conversationId]) {
            return current;
          }
          return {
            ...current,
            [conversationId]: optimisticConversation,
          };
        });
        if (optimisticConversation) {
          dispatchAgentConversationUpserted(optimisticConversation);
          recordPerfSample("rail.position_after_prompt_optimistic", startedAt, {
            conversationId,
          });
        }
        recordPerfSample("conversation.prompt.optimistic_visible", startedAt, {
          conversationId,
        });
      }
      try {
        const snapshot = await promptAgentConversation(
          conversationId,
          text,
          attachments,
          configOverride,
          { clientEventId, clientMessageId }
        );
        recordPerfSample("conversation.prompt.ack", startedAt, {
          conversationId,
        });
        mergeConversationSnapshot(snapshot.snapshot);
        dispatchAgentConversationUpserted(snapshot.snapshot.conversation);
        void markWorkspaceActivity(snapshot.snapshot.conversation.workspaceId).catch(
          () => undefined
        );
        return true;
      } catch (error) {
        if (canOptimisticallyAppend) {
          setEventsByConversationId((current) => {
            const existing = current[conversationId] ?? [];
            return {
              ...current,
              [conversationId]: existing.filter((event) => event.eventId !== clientEventId),
            };
          });
          if (currentConversation) {
            setConversationsById((current) => ({
              ...current,
              [conversationId]: currentConversation,
            }));
          }
        }
        const message =
          error instanceof Error ? error.message : "Failed to start the agent turn.";
        setEventsByConversationId((current) => {
          const existing = current[conversationId] ?? [];
          const nextSeq = getConversationLatestSeq(existing) + 1;
          return {
            ...current,
            [conversationId]: [
              ...existing,
              {
                seq: nextSeq,
                eventId:
                  globalThis.crypto?.randomUUID?.() ?? `local-error-${Date.now()}`,
                conversationId,
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
    },
    [markWorkspaceActivity, mergeConversationSnapshot]
  );

  const clearEditingQueuedPromptForConversation = useCallback(
    (conversationId: string) => {
      updateWorkspaceSession((current) => {
        const map = current.chat.editingQueuedPromptIdByConversationId ?? {};
        if (!map[conversationId]) {
          return current;
        }
        const nextMap = { ...map };
        delete nextMap[conversationId];
        return {
          ...current,
          chat: {
            ...current.chat,
            editingQueuedPromptIdByConversationId: nextMap,
          },
        };
      });
    },
    [updateWorkspaceSession]
  );

  const promptConversation = useCallback(
    async (
      conversationId: string,
      text: string,
      attachments?: ImageAttachment[],
      configOverride?: QueuedPromptConfigOverride
    ) => {
      const ok = await executePrompt(conversationId, text, attachments, configOverride);
      if (ok) {
        clearEditingQueuedPromptForConversation(conversationId);
      }
      return ok;
    },
    [clearEditingQueuedPromptForConversation, executePrompt]
  );

  const createConversation = useCallback(
    async (input?: AgentConversationCreateInput) => {
      const result = await createAgentConversation(input ?? {});
      upsertConversation(result.conversation);
      dispatchAgentConversationUpserted(result.conversation);
      setConversationLoadStatusById((current) => ({
        ...current,
        [result.conversation.id]: "ready",
      }));
      return result.conversation;
    },
    [upsertConversation]
  );

  const createAndPromptConversation = useCallback(
    async (
      input: AgentConversationCreateInput,
      text: string,
      attachments?: ImageAttachment[]
    ) => {
      const startedAt = performance.now();
      const clientEventId =
        globalThis.crypto?.randomUUID?.() ?? `local-user-event-${Date.now()}`;
      const clientMessageId =
        globalThis.crypto?.randomUUID?.() ?? `local-user-message-${Date.now()}`;
      try {
        const result = await createAndPromptAgentConversation(input, text, attachments, {
          clientEventId,
          clientMessageId,
        });
        mergeConversationSnapshot(result.snapshot);
        dispatchAgentConversationUpserted(result.snapshot.conversation);
        recordPerfSample("conversation.create_and_prompt.ack", startedAt, {
          conversationId: result.snapshot.conversation.id,
        });
        void markWorkspaceActivity(result.snapshot.conversation.workspaceId).catch(
          () => undefined
        );
        return result.snapshot.conversation;
      } catch (error) {
        const message =
          error instanceof Error ? error.message : "Failed to create the agent turn.";
        console.warn("[agent] create-and-prompt failed:", message);
        return null;
      }
    },
    [markWorkspaceActivity, mergeConversationSnapshot]
  );

  const cancelConversation = useCallback(
    async (conversationId: string) => {
      try {
        const result = await cancelAgentConversation(conversationId);
        upsertConversation(result.conversation);
        dispatchAgentConversationUpserted(result.conversation);
      } catch {
        void syncConversationSnapshot(conversationId).catch(() => undefined);
      }
    },
[syncConversationSnapshot, upsertConversation]
);

useEffect(() => {
const pendingIds = Object.keys(pendingConfigByConversationId);
if (pendingIds.length === 0) return;
const toClear: string[] = [];
for (const id of pendingIds) {
const conv = conversationsById[id];
if (conv && conv.status !== "running" && conv.status !== "awaiting_permission") {
toClear.push(id);
}
}
if (toClear.length > 0) {
setPendingConfigByConversationId((current) => {
const next = { ...current };
for (const id of toClear) {
delete next[id];
}
return next;
});
}
}, [conversationsById, pendingConfigByConversationId]);

const getConversationComposerState = useCallback(
(conversationId: string): ConversationComposerState | null => {
const conversation = conversationsById[conversationId] ?? null;
if (!conversation) {
return null;
}
const busy =
conversation.status === "running" || conversation.status === "awaiting_permission";
const pending = pendingConfigByConversationId[conversationId];
const effectiveConfig = busy && pending
? resolveEffectiveConfig(conversation.config, pending)
: conversation.config;
const backend = pickAvailableBackend(backends, effectiveConfig.backendId);
const models = buildConversationModelOptions(
{ ...conversation, config: effectiveConfig },
backends,
globalSettings.models.byBackend
);
const model = resolveConversationModel(
{ ...conversation, config: effectiveConfig },
backends
);
const modeOptions = buildConversationModeOptions(
{ ...conversation, config: effectiveConfig },
backends
);
const mode = resolveCanonicalModeId(
String(effectiveConfig.mode ?? ""),
modeOptions
) as EditorMode;
return {
conversation,
backendId:
effectiveConfig.backendId ??
backend?.id ??
chatDraftRef.current.backendId,
models,
model,
modeOptions: modeOptions.length > 0 ? modeOptions : DEFAULT_MODE_OPTIONS,
mode,
sessionConfigOptions: listSupplementaryAgentConfigOptions(conversation),
busy,
};
},
[backends, conversationsById, globalSettings.models.byBackend, pendingConfigByConversationId]
  );

  const getConversationLoadStatus = useCallback(
    (conversationId: string): ConversationLoadStatus => {
      const row = conversationLoadStatusById[conversationId];
      if (row === "error") {
        return "error";
      }
      const conv = conversationsById[conversationId];
      if (!conv) {
        return row ?? "idle";
      }
      if (conv.lastEventSeq === 0) {
        return "ready";
      }
      if (Object.hasOwn(eventsByConversationId, conversationId)) {
        return "ready";
      }
      return "loading";
    },
    [conversationLoadStatusById, conversationsById, eventsByConversationId]
  );

  const flushSubscription = useCallback(() => {
    const socket = socketRef.current;
    if (!socket?.connected) {
      return;
    }
    const ws = activeWorkspaceIdRef.current;
    if (!ws) {
      return;
    }
    const convMap = conversationsByIdRef.current;
    const conversationIds = openConversationIdsRef.current
      .filter(Boolean)
      .filter((id) => convMap[id]?.workspaceId === ws);
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

  const scheduleSubscription = useCallback(() => {
    if (subscribeDebounceTimerRef.current != null) {
      clearTimeout(subscribeDebounceTimerRef.current);
    }
    subscribeDebounceTimerRef.current = setTimeout(() => {
      subscribeDebounceTimerRef.current = null;
      flushSubscription();
    }, 100);
  }, [flushSubscription]);

  const refreshConversations = useCallback(async () => {
    const result = await listAgentConversations();
    setBackends(result.backends);
    setConversationsById(toConversationMap(result.conversations));
    return result.conversations;
  }, []);

  const forkConversation = useCallback(
    async (
      conversationId: string,
      options?: { upToMessageId?: string }
    ): Promise<AgentConversationRecord> => {
      const result = await forkAgentConversation(conversationId, options);
      upsertConversation(result.conversation);
      dispatchAgentConversationUpserted(result.conversation);
      try {
        const snapshot = await fetchAgentConversationSnapshot(result.conversation.id);
        mergeConversationSnapshot(snapshot.snapshot);
      } catch {
        void syncConversationSnapshot(result.conversation.id).catch(() => undefined);
      }
      return result.conversation;
    },
    [mergeConversationSnapshot, syncConversationSnapshot, upsertConversation]
  );

  useEffect(() => {
    if (!activeWorkspaceId) {
      if (subscribeDebounceTimerRef.current != null) {
        clearTimeout(subscribeDebounceTimerRef.current);
        subscribeDebounceTimerRef.current = null;
      }
      setBackends([]);
      setConversationsById({});
      setEventsByConversationId({});
      loadedSnapshotConversationIdsRef.current.clear();
      backgroundSnapshotCooldownUntilRef.current = {};
      setConversationLoadStatusById({});
      setHistoryMetaById({});
      setLoadingOlderById({});
      loadingOlderRef.current = {};
      runtimeHydrationSignatureByIdRef.current = {};
      setBootstrapped(false);
      socketRef.current?.disconnect();
      socketRef.current = null;
      return;
    }

    let cancelled = false;
    setBootstrapped(false);
    setConversationsById({});
    setEventsByConversationId({});
    loadedSnapshotConversationIdsRef.current.clear();
    backgroundSnapshotCooldownUntilRef.current = {};
    setHistoryMetaById({});
    setLoadingOlderById({});
    loadingOlderRef.current = {};
    runtimeHydrationSignatureByIdRef.current = {};
    setConversationLoadStatusById({});

    void (async () => {
      const result = await listAgentConversations();
      if (cancelled) {
        return;
      }

      const nextConversations = result.conversations;
      setBackends(result.backends);

      setConversationsById(toConversationMap(nextConversations));
      setEventsByConversationId({});
      loadedSnapshotConversationIdsRef.current.clear();
      backgroundSnapshotCooldownUntilRef.current = {};
      setHistoryMetaById({});
      setLoadingOlderById({});
      loadingOlderRef.current = {};
      runtimeHydrationSignatureByIdRef.current = {};
      setConversationLoadStatusById(() => {
        const next: Record<string, ConversationLoadStatus> = {};
        for (const conversation of nextConversations) {
          next[conversation.id] = "ready";
        }
        return next;
      });
      const validIds = new Set(nextConversations.map((conversation) => conversation.id));
      updateWorkspaceSession((current) => {
        const pruneGroup = (tabs: typeof current.editor.leftTabs, activeId: string | null) => {
          const nextTabs = tabs.filter(
            (tab) => !tab.conversationId || validIds.has(tab.conversationId)
          );
          const nextActiveId =
            activeId && nextTabs.some((tab) => tab.id === activeId)
              ? activeId
              : nextTabs[0]?.id ?? null;
          return { nextTabs, nextActiveId };
        };

        const pruneEditorSession = (editor: typeof current.editor) => {
          const left = pruneGroup(editor.leftTabs, editor.leftActiveId);
          const right = pruneGroup(editor.rightTabs, editor.rightActiveId);
          const validTabIds = new Set([
            ...left.nextTabs.map((tab) => tab.id),
            ...right.nextTabs.map((tab) => tab.id),
          ]);
          const viewStateByTabId = Object.fromEntries(
            Object.entries(editor.viewStateByTabId).filter(([tabId]) =>
              validTabIds.has(tabId)
            )
          );
          const normalized = normalizeEditorPanelState({
            split: editor.split,
            splitOrientation: editor.splitOrientation,
            splitLayout: editor.splitLayout,
            focusedGroup: editor.focusedGroup,
            leftTabs: left.nextTabs,
            rightTabs: right.nextTabs,
            leftActiveId: left.nextActiveId,
            rightActiveId: right.nextActiveId,
            leftTabGroups: editor.leftTabGroups,
            rightTabGroups: editor.rightTabGroups,
            leftStripItems: editor.leftStripItems,
            rightStripItems: editor.rightStripItems,
          });
          const nextEditor = {
            ...normalized,
            viewStateByTabId,
          };
          const changed =
            left.nextTabs.length !== editor.leftTabs.length ||
            right.nextTabs.length !== editor.rightTabs.length ||
            left.nextActiveId !== editor.leftActiveId ||
            right.nextActiveId !== editor.rightActiveId ||
            Object.keys(editor.viewStateByTabId).length !==
              Object.keys(viewStateByTabId).length ||
            JSON.stringify(normalized.leftStripItems) !==
              JSON.stringify(editor.leftStripItems) ||
            JSON.stringify(normalized.rightStripItems) !==
              JSON.stringify(editor.rightStripItems) ||
            JSON.stringify(normalized.leftTabGroups) !==
              JSON.stringify(editor.leftTabGroups) ||
            JSON.stringify(normalized.rightTabGroups) !==
              JSON.stringify(editor.rightTabGroups);
          return { nextEditor, changed };
        };

        const { nextEditor, changed: editorChanged } = pruneEditorSession(current.editor);
        const currentSidePaneSessions =
          current.agentView.sidePaneSessionsByConversationId ?? {};
        const nextSidePaneSessions = Object.fromEntries(
          Object.entries(currentSidePaneSessions)
            .filter(
              ([scopeId]) =>
                scopeId === AGENT_NEW_CHAT_SESSION_ID || validIds.has(scopeId)
            )
            .map(([scopeId, session]) => {
              const pruned = pruneEditorSession(session.editor);
              return [
                scopeId,
                {
                  ...session,
                  editor: pruned.nextEditor,
                },
              ];
            })
        );
        const nextChatTabs = current.chat.tabs.filter((tab) => validIds.has(tab.id));
        const normalizedChatTabs =
          nextChatTabs.length === 0 || nextChatTabs.some((tab) => tab.active)
            ? nextChatTabs
            : nextChatTabs.map((tab, index) => ({ ...tab, active: index === 0 }));
        const nextHiddenConversationIds = current.chat.hiddenConversationIds.filter((id) =>
          validIds.has(id)
        );

        const sidePaneSessionsUnchanged =
          JSON.stringify(currentSidePaneSessions) === JSON.stringify(nextSidePaneSessions);
        const chatUnchanged =
          normalizedChatTabs.length === current.chat.tabs.length &&
          normalizedChatTabs.every(
            (tab, index) =>
              tab.id === current.chat.tabs[index]?.id &&
              tab.title === current.chat.tabs[index]?.title &&
              Boolean(tab.active) === Boolean(current.chat.tabs[index]?.active)
          ) &&
          nextHiddenConversationIds.length === current.chat.hiddenConversationIds.length &&
          nextHiddenConversationIds.every(
            (id, index) => id === current.chat.hiddenConversationIds[index]
          );

        return !editorChanged && sidePaneSessionsUnchanged && chatUnchanged
          ? current
          : {
              ...current,
              editor: nextEditor,
              chat: {
                ...current.chat,
                tabs: normalizedChatTabs,
                hiddenConversationIds: nextHiddenConversationIds,
              },
              agentView: {
                ...current.agentView,
                sidePaneSessionsByConversationId: nextSidePaneSessions,
              },
            };
      });
      setBootstrapped(true);
    })().catch(() => undefined);

    return () => {
      cancelled = true;
    };
  }, [activeWorkspaceId, updateWorkspaceSession]);

  useEffect(() => {
    if (!activeWorkspaceId || !bootstrapped) {
      return;
    }
    if (openConversationsSyncTimerRef.current != null) {
      window.clearTimeout(openConversationsSyncTimerRef.current);
    }
    openConversationsSyncTimerRef.current = window.setTimeout(() => {
      openConversationsSyncTimerRef.current = null;
      for (const conversationId of openConversationIds) {
        const events = eventsRef.current[conversationId];
        if (
          loadedSnapshotConversationIdsRef.current.has(conversationId) ||
          (conversationsById[conversationId] && events !== undefined)
        ) {
          continue;
        }
        if ((backgroundSnapshotCooldownUntilRef.current[conversationId] ?? 0) > Date.now()) {
          continue;
        }
        backgroundSnapshotCooldownUntilRef.current[conversationId] =
          Date.now() + BACKGROUND_SNAPSHOT_COOLDOWN_MS;
        void syncConversationSnapshot(conversationId).catch(() => undefined);
      }
    }, 80) as unknown as ReturnType<typeof setTimeout>;
    return () => {
      if (openConversationsSyncTimerRef.current != null) {
        window.clearTimeout(openConversationsSyncTimerRef.current);
        openConversationsSyncTimerRef.current = null;
      }
    };
  }, [
    activeWorkspaceId,
    bootstrapped,
    conversationsById,
    openConversationIds,
    syncConversationSnapshot,
  ]);

  useEffect(() => {
    if (!activeWorkspaceId || !bootstrapped) {
      return;
    }
    let cancelled = false;
    const list = prefetchTargetConversationIds;
    let index = 0;
    const runWorker = async () => {
      while (!cancelled && index < list.length) {
        const i = index++;
        const cid = list[i]!;
        await primeConversationSnapshotIfEmpty(cid);
      }
    };
    void Promise.all([runWorker(), runWorker()]);
    return () => {
      cancelled = true;
    };
  }, [
    activeWorkspaceId,
    bootstrapped,
    prefetchTargetConversationIds,
    primeConversationSnapshotIfEmpty,
  ]);

  useEffect(() => {
    if (!bootstrapped) {
      return;
    }
    for (const conversationId of visibleConversationIds) {
      const conversation = conversationsById[conversationId];
      if (!conversationNeedsRuntimeHydration(conversation)) {
        continue;
      }
      const signature = runtimeHydrationSignature(conversation);
      if (runtimeHydrationSignatureByIdRef.current[conversation.id] === signature) {
        continue;
      }
      if ((backgroundSnapshotCooldownUntilRef.current[conversation.id] ?? 0) > Date.now()) {
        continue;
      }
      if (hydratingConversationIdsRef.current.has(conversation.id)) {
        continue;
      }
      const cid = conversation.id;
      runtimeHydrationSignatureByIdRef.current[cid] = signature;
      backgroundSnapshotCooldownUntilRef.current[cid] =
        Date.now() + BACKGROUND_SNAPSHOT_COOLDOWN_MS;
      hydratingConversationIdsRef.current.add(cid);
      const controller = new AbortController();
      const bgTimer = window.setTimeout(() => controller.abort(), 90_000);
      void fetchAgentConversationSnapshot(cid, {
        hydrateRuntime: true,
        signal: controller.signal,
      })
        .then((result) => {
          mergeConversationSnapshot(result.snapshot);
        })
        .catch(() => undefined)
        .finally(() => {
          window.clearTimeout(bgTimer);
          hydratingConversationIdsRef.current.delete(cid);
        });
    }
  }, [bootstrapped, conversationsById, mergeConversationSnapshot, visibleConversationIds]);

  useEffect(() => {
    if (!activeWorkspaceId || !bootstrapped) {
      return;
    }

    const socket = new JsonWebSocket<AgentSocketServerMessage>(() =>
      buildAgentWebSocketUrl(activeWorkspaceId)
    );
    socketRef.current = socket;

    const disposeOpen = socket.onOpen(() => {
      flushSubscription();
    });
    const disposeClose = socket.onClose(() => {
      loadingOlderRef.current = {};
      setLoadingOlderById({});
    });
    const disposeMessage = socket.onMessage((message) => {
      const expectWs = activeWorkspaceIdRef.current;
      const scoped = agentSocketMessageWorkspaceScope(message);
      if (scoped != null && scoped !== expectWs) {
        return;
      }
      switch (message.type) {
        case "conversation":
          upsertConversation(message.conversation);
          dispatchAgentConversationUpserted(message.conversation);
          return;
        case "conversation_upserted":
          upsertConversation(message.conversation);
          dispatchAgentConversationUpserted(message.conversation);
          return;
        case "conversation_deleted": {
          const deletedId = message.conversationId;
          setConversationsById((current) => {
            if (!current[deletedId]) {
              return current;
            }
            const next = { ...current };
            delete next[deletedId];
            return next;
          });
          setEventsByConversationId((current) => {
            if (!current[deletedId]) {
              return current;
            }
            const next = { ...current };
            delete next[deletedId];
            return next;
          });
          setHistoryMetaById((current) => {
            if (!current[deletedId]) {
              return current;
            }
            const next = { ...current };
            delete next[deletedId];
            return next;
          });
          setLoadingOlderById((current) => {
            if (!current[deletedId]) {
              return current;
            }
            const next = { ...current };
            delete next[deletedId];
            return next;
          });
          loadedSnapshotConversationIdsRef.current.delete(deletedId);
          delete backgroundSnapshotCooldownUntilRef.current[deletedId];
          delete runtimeHydrationSignatureByIdRef.current[deletedId];
          updateWorkspaceSession((current) => {
            const nextTabs = current.chat.tabs.filter((tab) => tab.id !== deletedId);
            if (nextTabs.length === current.chat.tabs.length) {
              return current;
            }
            const normalizedTabs =
              nextTabs.length === 0 || nextTabs.some((tab) => tab.active)
                ? nextTabs
                : nextTabs.map((tab, index) => ({ ...tab, active: index === 0 }));
            return {
              ...current,
              chat: {
                ...current.chat,
                tabs: normalizedTabs,
              },
            };
          });
          dispatchAgentConversationDeleted({
            conversationId: deletedId,
            workspaceId: message.workspaceId,
          });
          return;
        }
        case "snapshot":
          mergeConversationSnapshot(message.snapshot);
          return;
        case "snapshot_head":
          mergeConversationSnapshot(message.snapshot);
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
        case "event_batch":
          appendConversationEventBatch(message.conversationId, message.events);
          return;
        case "error": {
          const forConv = message.conversationId;
          if (forConv) {
            loadingOlderRef.current[forConv] = false;
            setLoadingOlderById((c) => ({ ...c, [forConv]: false }));
            return;
          }
          loadingOlderRef.current = {};
          setLoadingOlderById({});
          return;
        }
        default:
          return;
      }
    });

    socket.connect();
    return () => {
      disposeOpen();
      disposeClose();
      disposeMessage();
      socket.disconnect();
      if (socketRef.current === socket) {
        socketRef.current = null;
      }
    };
  }, [
    activeWorkspaceId,
    bootstrapped,
    appendConversationEvent,
    appendConversationEventBatch,
    flushSubscription,
    mergeConversationSnapshot,
    prependHistoryPage,
    updateWorkspaceSession,
    upsertConversation,
  ]);

  useEffect(() => {
    if (!activeWorkspaceId || !bootstrapped) {
      return;
    }
    scheduleSubscription();
    return () => {
      if (subscribeDebounceTimerRef.current != null) {
        clearTimeout(subscribeDebounceTimerRef.current);
        subscribeDebounceTimerRef.current = null;
      }
    };
  }, [activeWorkspaceId, bootstrapped, openConversationIds, scheduleSubscription]);

  const value = useMemo<AgentConversationsContextValue>(
    () => ({
      backends,
      conversationsById,
      conversations,
      eventsByConversationId,
      bootstrapped,
      getConversationLoadStatus,
      createConversation,
      createAndPromptConversation,
      renameConversation,
      upsertConversation,
      answerPermissionForConversation,
      cancelPermissionForConversation,
      setConversationMode,
      setConversationModel,
      setConversationBackend,
      setConversationConfigOption,
      promptConversation,
cancelConversation,
getConversationComposerState,
syncConversationSnapshot,
mergeConversationSnapshot,
refreshConversations,
forkConversation,
getConversationHistoryCursor,
loadOlderConversationHistory,
pendingConfigByConversationId,
setPendingConfigForConversation,
clearPendingConfigForConversation,
}),
[
backends,
bootstrapped,
cancelConversation,
cancelPermissionForConversation,
clearPendingConfigForConversation,
createConversation,
createAndPromptConversation,
conversations,
conversationsById,
eventsByConversationId,
forkConversation,
getConversationLoadStatus,
getConversationComposerState,
mergeConversationSnapshot,
pendingConfigByConversationId,
promptConversation,
refreshConversations,
renameConversation,
upsertConversation,
setConversationBackend,
setConversationConfigOption,
setConversationMode,
setConversationModel,
setPendingConfigForConversation,
syncConversationSnapshot,
answerPermissionForConversation,
getConversationHistoryCursor,
loadOlderConversationHistory,
]
  );

  return (
    <AgentConversationsContext.Provider value={value}>
      {children}
    </AgentConversationsContext.Provider>
  );
}

export function useAgentConversations(): AgentConversationsContextValue {
  const context = useContext(AgentConversationsContext);
  if (!context) {
    throw new Error(
      "useAgentConversations must be used within AgentConversationsProvider"
    );
  }
  return context;
}
