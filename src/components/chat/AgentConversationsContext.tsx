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
  AgentConversationRecord,
  AgentConversationSnapshot,
  AgentSocketServerMessage,
  AgentStoredEvent,
} from "@/lib/agent-types";
import type { AgentModeOption, EditorMode, ModelInfo } from "@/lib/types";
import { useWorkspace } from "@/contexts/WorkspaceContext";
import { JsonWebSocket } from "@/lib/ws-client";
import {
  answerAgentPermission,
  buildAgentWebSocketUrl,
  cancelAgentConversation,
  fetchAgentConversationSnapshot,
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

type AgentConversationsContextValue = {
  backends: AgentBackendInfo[];
  conversationsById: Record<string, AgentConversationRecord>;
  conversations: AgentConversationRecord[];
  eventsByConversationId: Record<string, AgentStoredEvent[]>;
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
  promptConversation: (conversationId: string, text: string) => Promise<boolean>;
  cancelConversation: (conversationId: string) => Promise<void>;
  getConversationComposerState: (
    conversationId: string
  ) => ConversationComposerState | null;
  syncConversationSnapshot: (
    conversationId: string,
    options?: { hydrateRuntime?: boolean }
  ) => Promise<void>;
};

const AgentConversationsContext =
  createContext<AgentConversationsContextValue | null>(null);

export function AgentConversationsProvider({
  children,
}: {
  children: ReactNode;
}) {
  const { activeWorkspaceId, workspaceSession, updateWorkspaceSession } = useWorkspace();
  const [backends, setBackends] = useState<AgentBackendInfo[]>([]);
  const [conversationsById, setConversationsById] = useState<
    Record<string, AgentConversationRecord>
  >({});
  const [eventsByConversationId, setEventsByConversationId] = useState<
    Record<string, AgentStoredEvent[]>
  >({});
  const socketRef = useRef<JsonWebSocket<AgentSocketServerMessage> | null>(null);
  const chatDraftRef = useRef(workspaceSession.chat);
  const eventsRef = useRef(eventsByConversationId);
  const openConversationIdsRef = useRef<string[]>([]);
  const hydratingConversationIdsRef = useRef(new Set<string>());

  useEffect(() => {
    chatDraftRef.current = workspaceSession.chat;
  }, [workspaceSession.chat]);

  useEffect(() => {
    eventsRef.current = eventsByConversationId;
  }, [eventsByConversationId]);

  const conversations = useMemo(
    () =>
      Object.values(conversationsById).sort((a, b) => b.updatedAt - a.updatedAt),
    [conversationsById]
  );

  const openConversationIds = useMemo(() => {
    const ids = new Set<string>();
    for (const tab of workspaceSession.editor.leftTabs) {
      if (tab.conversationId) {
        ids.add(tab.conversationId);
      }
    }
    for (const tab of workspaceSession.editor.rightTabs) {
      if (tab.conversationId) {
        ids.add(tab.conversationId);
      }
    }
    return [...ids];
  }, [
    workspaceSession.editor.leftTabs,
    workspaceSession.editor.rightTabs,
  ]);

  useEffect(() => {
    openConversationIdsRef.current = openConversationIds;
  }, [openConversationIds]);

  const visibleConversationIds = useMemo(() => {
    const ids = new Set<string>();
    const leftActive = workspaceSession.editor.leftTabs.find(
      (tab) => tab.id === workspaceSession.editor.leftActiveId
    );
    if (leftActive?.conversationId) {
      ids.add(leftActive.conversationId);
    }

    const rightActive = workspaceSession.editor.rightTabs.find(
      (tab) => tab.id === workspaceSession.editor.rightActiveId
    );
    if (rightActive?.conversationId) {
      ids.add(rightActive.conversationId);
    }

    return [...ids];
  }, [
    workspaceSession.editor.leftActiveId,
    workspaceSession.editor.leftTabs,
    workspaceSession.editor.rightActiveId,
    workspaceSession.editor.rightTabs,
  ]);

  const mergeSnapshot = useCallback(
    (snapshot: AgentConversationSnapshot) => {
      setConversationsById((current) => {
        const incoming = snapshot.conversation;
        return {
          ...current,
          [incoming.id]: mergeConversationByRecency(current[incoming.id], incoming),
        };
      });
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
        return nextTabs.every(
          (tab, index) =>
            tab.id === current.chat.tabs[index]?.id &&
            tab.title === current.chat.tabs[index]?.title &&
            Boolean(tab.active) === Boolean(current.chat.tabs[index]?.active)
        )
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
        [conversation.id]: mergeConversationByRecency(current[conversation.id], conversation),
      }));
      updateWorkspaceSession((current) => {
        const nextTabs = current.chat.tabs.map((tab) =>
          tab.id === conversation.id ? { ...tab, title: conversation.title } : tab
        );
        return nextTabs.every(
          (tab, index) =>
            tab.id === current.chat.tabs[index]?.id &&
            tab.title === current.chat.tabs[index]?.title &&
            Boolean(tab.active) === Boolean(current.chat.tabs[index]?.active)
        )
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

  const syncConversationSnapshot = useCallback(
    async (conversationId: string, options?: { hydrateRuntime?: boolean }) => {
      const result = await fetchAgentConversationSnapshot(conversationId, options);
      mergeSnapshot(result.snapshot);
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
        const result = await answerAgentPermission(conversationId, {
          requestId,
          optionId,
        });
        upsertConversation(result.conversation);
      } catch {
        void syncConversationSnapshot(conversationId).catch(() => undefined);
      }
    },
    [syncConversationSnapshot, upsertConversation]
  );

  const cancelPermissionForConversation = useCallback(
    async (conversationId: string, requestId: string) => {
      try {
        const result = await answerAgentPermission(conversationId, {
          requestId,
          cancelled: true,
        });
        upsertConversation(result.conversation);
      } catch {
        void syncConversationSnapshot(conversationId).catch(() => undefined);
      }
    },
    [syncConversationSnapshot, upsertConversation]
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
        const updated = await updateAgentConversationConfig(conversationId, {
          backendId: nextBackendId,
        });
        upsertConversation(updated.conversation);
      } catch {
        void syncConversationSnapshot(conversationId).catch(() => undefined);
      }
    },
    [syncConversationSnapshot, upsertConversation]
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

  const promptConversation = useCallback(
    async (conversationId: string, text: string) => {
      try {
        const snapshot = await promptAgentConversation(conversationId, text);
        mergeSnapshot(snapshot.snapshot);
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
    [mergeSnapshot]
  );

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
      socketRef.current?.disconnect();
      socketRef.current = null;
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

      const nextConversations = result.conversations;
      setBackends(result.backends);

      setConversationsById(toConversationMap(nextConversations));
    })().catch(() => undefined);

    return () => {
      cancelled = true;
    };
  }, [activeWorkspaceId]);

  useEffect(() => {
    if (!activeWorkspaceId) {
      return;
    }
    for (const conversationId of openConversationIds) {
      if (conversationsById[conversationId] && eventsRef.current[conversationId]) {
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
  }, [
    activeWorkspaceId,
    appendConversationEvent,
    mergeSnapshot,
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
    }),
    [
      backends,
      cancelConversation,
      cancelPermissionForConversation,
      conversations,
      conversationsById,
      eventsByConversationId,
      getConversationComposerState,
      promptConversation,
      renameConversation,
      setConversationBackend,
      setConversationConfigOption,
      setConversationMode,
      setConversationModel,
      syncConversationSnapshot,
      answerPermissionForConversation,
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
