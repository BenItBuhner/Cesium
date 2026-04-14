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
  getConversationLatestSeq,
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
import type { AgentModeOption, EditorMode, ImageAttachment, ModelInfo } from "@/lib/types";
import { useWorkspace } from "@/contexts/WorkspaceContext";
import { nextUnreadCompletionMap } from "@/lib/chat-unread-completion";
import {
  AGENT_NEW_CHAT_SESSION_ID,
  createEmptyEditorSession,
  getAgentSidePaneSessionScopeId,
} from "@/lib/workspace-session";
import {
  endQueuedPromptFlush,
  tryBeginQueuedPromptFlush,
} from "@/lib/queued-prompt-flush-guard";
import { useShellView } from "@/components/layout/ShellViewContext";
import { JsonWebSocket } from "@/lib/ws-client";
import {
  answerAgentPermission,
  buildAgentWebSocketUrl,
  cancelAgentConversation,
  createAgentConversation,
  fetchAgentConversationSnapshot,
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
  if (!existing || incoming.updatedAt > existing.updatedAt) {
    return incoming;
  }
  return existing;
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
  renameConversation: (conversationId: string, title: string) => Promise<void>;
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
  promptConversation: (conversationId: string, text: string, attachments?: ImageAttachment[]) => Promise<boolean>;
  cancelConversation: (conversationId: string) => Promise<void>;
  getConversationComposerState: (
    conversationId: string
  ) => ConversationComposerState | null;
  syncConversationSnapshot: (
    conversationId: string,
    options?: { hydrateRuntime?: boolean }
  ) => Promise<void>;
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
  const historyMetaRef = useRef(historyMetaById);
  const loadingOlderRef = useRef<Record<string, boolean>>({});
  const socketRef = useRef<JsonWebSocket<AgentSocketServerMessage> | null>(null);
  const chatDraftRef = useRef(workspaceSession.chat);
  const eventsRef = useRef(eventsByConversationId);
  const openConversationIdsRef = useRef<string[]>([]);
  const hydratingConversationIdsRef = useRef(new Set<string>());
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
    return [...ids];
  }, [
    activeSelectedConversationId,
    scopedEditorSession.leftTabs,
    scopedEditorSession.rightTabs,
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
        const tabUnchanged = nextTabs.every(
          (tab, index) =>
            tab.id === current.chat.tabs[index]?.id &&
            tab.title === current.chat.tabs[index]?.title &&
            Boolean(tab.active) === Boolean(current.chat.tabs[index]?.active)
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
        const tabUnchanged = nextTabs.every(
          (tab, index) =>
            tab.id === current.chat.tabs[index]?.id &&
            tab.title === current.chat.tabs[index]?.title &&
            Boolean(tab.active) === Boolean(current.chat.tabs[index]?.active)
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

  const syncConversationSnapshot = useCallback(
    async (conversationId: string, options?: { hydrateRuntime?: boolean }) => {
      setConversationLoadStatusById((current) => ({
        ...current,
        [conversationId]: "loading",
      }));
      try {
        const result = await fetchAgentConversationSnapshot(conversationId, options);
        mergeSnapshot(result.snapshot);
      } catch (error) {
        setConversationLoadStatusById((current) => ({
          ...current,
          [conversationId]: "error",
        }));
        throw error;
      }
    },
    [mergeSnapshot]
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
        mergeSnapshot(result.snapshot);
      } catch {
        void syncConversationSnapshot(conversationId).catch(() => undefined);
      }
    },
    [mergeSnapshot, syncConversationSnapshot]
  );

  const cancelPermissionForConversation = useCallback(
    async (conversationId: string, requestId: string) => {
      try {
        await answerAgentPermission(conversationId, {
          requestId,
          cancelled: true,
        });
        const result = await fetchAgentConversationSnapshot(conversationId);
        mergeSnapshot(result.snapshot);
      } catch {
        void syncConversationSnapshot(conversationId).catch(() => undefined);
      }
    },
    [mergeSnapshot, syncConversationSnapshot]
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

  const executePrompt = useCallback(
    async (conversationId: string, text: string, attachments?: ImageAttachment[]) => {
      try {
        const snapshot = await promptAgentConversation(conversationId, text, attachments);
        mergeSnapshot(snapshot.snapshot);
        void markWorkspaceActivity(snapshot.snapshot.conversation.workspaceId).catch(
          () => undefined
        );
        return true;
      } catch (error) {
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
    [markWorkspaceActivity, mergeSnapshot]
  );

  const executePromptRef = useRef(executePrompt);
  executePromptRef.current = executePrompt;

  const promptConversation = useCallback(
    async (conversationId: string, text: string, attachments?: ImageAttachment[]) => {
      const conv = conversationsById[conversationId];
      if (
        conv &&
        (conv.status === "running" || conv.status === "awaiting_permission")
      ) {
        const entryId = globalThis.crypto?.randomUUID?.() ?? `q-${Date.now()}`;
        updateWorkspaceSession((current) => {
          const map = { ...(current.chat.queuedPromptsByConversationId ?? {}) };
          const prev = map[conversationId] ?? [];
          return {
            ...current,
            chat: {
              ...current.chat,
              queuedPromptsByConversationId: {
                ...map,
                [conversationId]: [...prev, { id: entryId, text, attachments }],
              },
            },
          };
        });
        return true;
      }
      return executePrompt(conversationId, text, attachments);
    },
    [conversationsById, executePrompt, updateWorkspaceSession]
  );

  const createConversation = useCallback(
    async (input?: AgentConversationCreateInput) => {
      const result = await createAgentConversation(input ?? {});
      upsertConversation(result.conversation);
      setConversationLoadStatusById((current) => ({
        ...current,
        [result.conversation.id]: "ready",
      }));
      return result.conversation;
    },
    [upsertConversation]
  );

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
          await executePromptRef.current(conversationId, head.text, head.attachments);
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

  const cancelConversation = useCallback(
    async (conversationId: string) => {
      try {
        const result = await cancelAgentConversation(conversationId);
        upsertConversation(result.conversation);
      } catch {
        void syncConversationSnapshot(conversationId).catch(() => undefined);
      }
    },
    [syncConversationSnapshot, upsertConversation]
  );

  const getConversationComposerState = useCallback(
    (conversationId: string): ConversationComposerState | null => {
      const conversation = conversationsById[conversationId] ?? null;
      if (!conversation) {
        return null;
      }
      const backend = pickAvailableBackend(backends, conversation.config.backendId);
      const models = buildConversationModelOptions(conversation, backends);
      const model = resolveConversationModel(conversation, backends);
      const modeOptions = buildConversationModeOptions(conversation, backends);
      const mode = resolveCanonicalModeId(
        String(conversation.config.mode ?? ""),
        modeOptions
      ) as EditorMode;
      return {
        conversation,
        backendId:
          conversation.config.backendId ??
          backend?.id ??
          chatDraftRef.current.backendId,
        models,
        model,
        modeOptions:
          modeOptions.length > 0 ? modeOptions : DEFAULT_MODE_OPTIONS,
        mode,
        sessionConfigOptions: listSupplementaryAgentConfigOptions(conversation),
        busy:
          conversation.status === "running" ||
          conversation.status === "awaiting_permission",
      };
    },
    [backends, conversationsById]
  );

  const getConversationLoadStatus = useCallback(
    (conversationId: string): ConversationLoadStatus => {
      if (conversationsById[conversationId]) {
        return "ready";
      }
      return conversationLoadStatusById[conversationId] ?? "idle";
    },
    [conversationLoadStatusById, conversationsById]
  );

  const sendSubscription = useCallback(() => {
    const socket = socketRef.current;
    if (!socket?.connected) {
      return;
    }
    const conversationIds = openConversationIdsRef.current.filter(Boolean);
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
      setBackends([]);
      setConversationsById({});
      setEventsByConversationId({});
      setConversationLoadStatusById({});
      setHistoryMetaById({});
      setLoadingOlderById({});
      loadingOlderRef.current = {};
      setBootstrapped(false);
      socketRef.current?.disconnect();
      socketRef.current = null;
      return;
    }

    let cancelled = false;

    void (async () => {
      const result = await listAgentConversations();
      if (cancelled) {
        return;
      }

      const nextConversations = result.conversations;
      setBackends(result.backends);

      setConversationsById(toConversationMap(nextConversations));
      setEventsByConversationId({});
      setHistoryMetaById({});
      setLoadingOlderById({});
      loadingOlderRef.current = {};
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
          return {
            nextEditor: {
              ...editor,
              leftTabs: left.nextTabs,
              rightTabs: right.nextTabs,
              leftActiveId: left.nextActiveId,
              rightActiveId: right.nextActiveId,
              viewStateByTabId: Object.fromEntries(
                Object.entries(editor.viewStateByTabId).filter(([tabId]) =>
                  validTabIds.has(tabId)
                )
              ),
            },
            changed:
              left.nextTabs.length !== editor.leftTabs.length ||
              right.nextTabs.length !== editor.rightTabs.length ||
              left.nextActiveId !== editor.leftActiveId ||
              right.nextActiveId !== editor.rightActiveId ||
              Object.keys(editor.viewStateByTabId).length !== validTabIds.size,
          };
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
    if (!activeWorkspaceId) {
      return;
    }
    for (const conversationId of openConversationIds) {
      const events = eventsRef.current[conversationId];
      if (conversationsById[conversationId] && events !== undefined) {
        continue;
      }
      void syncConversationSnapshot(conversationId).catch(() => undefined);
    }
  }, [
    activeWorkspaceId,
    conversationsById,
    openConversationIds,
    syncConversationSnapshot,
  ]);

  useEffect(() => {
    for (const conversationId of visibleConversationIds) {
      const conversation = conversationsById[conversationId];
      if (!conversationNeedsRuntimeHydration(conversation)) {
        continue;
      }
      if (hydratingConversationIdsRef.current.has(conversation.id)) {
        continue;
      }
      hydratingConversationIdsRef.current.add(conversation.id);
      void syncConversationSnapshot(conversation.id, {
        hydrateRuntime: true,
      })
        .catch(() => undefined)
        .finally(() => {
          hydratingConversationIdsRef.current.delete(conversation.id);
        });
    }
  }, [conversationsById, syncConversationSnapshot, visibleConversationIds]);

  useEffect(() => {
    if (!activeWorkspaceId) {
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
  }, [openConversationIds, sendSubscription]);

  const value = useMemo<AgentConversationsContextValue>(
    () => ({
      backends,
      conversationsById,
      conversations,
      eventsByConversationId,
      bootstrapped,
      getConversationLoadStatus,
      createConversation,
      renameConversation,
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
      getConversationHistoryCursor,
      loadOlderConversationHistory,
    }),
    [
      backends,
      bootstrapped,
      cancelConversation,
      cancelPermissionForConversation,
      createConversation,
      conversations,
      conversationsById,
      eventsByConversationId,
      getConversationLoadStatus,
      getConversationComposerState,
      promptConversation,
      renameConversation,
      setConversationBackend,
      setConversationConfigOption,
      setConversationMode,
      setConversationModel,
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
