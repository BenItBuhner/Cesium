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
import { PermissionRequestCard } from "./PermissionRequestCard";
import { askStepsFromMessage } from "@/lib/ask-question-utils";
import {
  buildDraftModeOptionsForBackend,
  buildDraftModelOptionsForBackend,
  buildConversationModeOptions,
  buildConversationModelOptions,
  getConversationLatestSeq,
  projectAgentEventsToChatMessages,
  agentPermissionOptionsToUiChoices,
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
  AgentConversationSnapshot,
  AgentSocketServerMessage,
  AgentStoredEvent,
} from "@/lib/agent-types";
import type { ChatMessage, ChatTab, EditorMode, ModelInfo } from "@/lib/types";
import { useWorkspace } from "@/contexts/WorkspaceContext";
import { JsonWebSocket } from "@/lib/ws-client";
import { useWorkbenchNotifications } from "@/components/notifications/WorkbenchNotificationProvider";
import { WORKBENCH_NOTIFICATION_KIND } from "@/components/notifications/workbench-notification-types";
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
    upsertComposerDraft,
    setComposerSelection,
    expandedComposerDraftId,
    setExpandedComposerDraft,
    setExpandedComposerController,
  } = useOpenInEditor();
  const { pushNotification, dismiss } = useWorkbenchNotifications();
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
  const [chatTabRenameTargetId, setChatTabRenameTargetId] = useState<string | null>(
    null
  );
  const socketRef = useRef<JsonWebSocket<AgentSocketServerMessage> | null>(null);
  const chatDraftRef = useRef(workspaceSession.chat);
  const tabsRef = useRef<ChatTab[]>(workspaceSession.chat.tabs);
  const eventsRef = useRef(eventsByConversationId);
  const hydratingConversationIdsRef = useRef(new Set<string>());
  const permissionToastIdsRef = useRef(new Map<string, string>());
  const dismissedPermissionToastKeysRef = useRef(new Set<string>());

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

  const syncConversationSnapshot = useCallback((conversationId: string) => {
    void fetchAgentConversationSnapshot(conversationId)
      .then((result) => {
        const incoming = result.snapshot.conversation;
        setConversationsById((current) => ({
          ...current,
          [incoming.id]: mergeConversationByRecency(current[incoming.id], incoming),
        }));
        setEventsByConversationId((current) => {
          const existing = current[incoming.id] ?? [];
          const existingSeq = existing.at(-1)?.seq ?? 0;
          const incomingSeq = result.snapshot.events.at(-1)?.seq ?? 0;
          return {
            ...current,
            [incoming.id]:
              incomingSeq >= existingSeq ? result.snapshot.events : existing,
          };
        });
      })
      .catch(() => undefined);
  }, []);

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

  const mergeSnapshot = useCallback((snapshot: AgentConversationSnapshot) => {
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
        [conversation.id]: mergeConversationByRecency(current[conversation.id], conversation),
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

  const answerPermissionForConversation = useCallback(
    async (conversationId: string, requestId: string, optionId: string) => {
      try {
        const result = await answerAgentPermission(conversationId, {
          requestId,
          optionId,
        });
        upsertConversation(result.conversation);
      } catch {
        void fetchAgentConversationSnapshot(conversationId)
          .then((result) => mergeSnapshot(result.snapshot))
          .catch(() => undefined);
      }
    },
    [mergeSnapshot, upsertConversation]
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
        void fetchAgentConversationSnapshot(conversationId)
          .then((r) => mergeSnapshot(r.snapshot))
          .catch(() => undefined);
      }
    },
    [mergeSnapshot, upsertConversation]
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

  const activeTabId = useMemo(
    () => tabs.find((tab) => tab.active)?.id ?? tabs[0]?.id ?? "__empty__",
    [tabs]
  );
  const activeConversation = activeTabId ? conversationsById[activeTabId] ?? null : null;
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
  const threadMessages = useMemo(
    () =>
      projectAgentEventsToChatMessages(
        activeTabId ? eventsByConversationId[activeTabId] ?? [] : []
      ),
    [activeTabId, eventsByConversationId]
  );
  const isEmptyThread = threadMessages.length === 0;
  const pendingPermissionDock = useMemo(() => {
    const pending = activeConversation?.pendingPermission;
    if (!pending || !activeConversation) {
      return null;
    }
    return (
      <div className="border-t border-[var(--border-card)] bg-[var(--bg-panel)] px-[10px] pb-[10px] pt-[8px]">
        <PermissionRequestCard
          title={pending.title ?? "Permission required"}
          detail={pending.detail}
          options={agentPermissionOptionsToUiChoices(pending.options ?? [])}
          onSelect={(optionId) => {
            void answerPermissionForConversation(activeConversation.id, pending.requestId, optionId);
          }}
        />
        <div className="mt-[8px] flex justify-end">
          <button
            type="button"
            className="font-sans text-[11px] text-[var(--text-secondary)] underline decoration-dotted underline-offset-2 hover:text-[var(--text-primary)]"
            onClick={() =>
              void cancelPermissionForConversation(activeConversation.id, pending.requestId)
            }
          >
            Cancel request
          </button>
        </div>
      </div>
    );
  }, [
    activeConversation,
    answerPermissionForConversation,
    cancelPermissionForConversation,
  ]);
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

  useEffect(() => {
    upsertComposerDraft(composerDraftId, {
      title: composerDraftTitle,
      content: composerDraftText,
    });
  }, [composerDraftId, composerDraftText, composerDraftTitle, upsertComposerDraft]);

  useEffect(() => {
    const nextKeys = new Set<string>();
    for (const conversation of Object.values(conversationsById)) {
      const pending = conversation.pendingPermission;
      if (!pending) {
        continue;
      }
      const key = `${conversation.id}:${pending.requestId}`;
      nextKeys.add(key);
      if (
        permissionToastIdsRef.current.has(key) ||
        dismissedPermissionToastKeysRef.current.has(key)
      ) {
        continue;
      }
      const notificationId = pushNotification({
        kind: WORKBENCH_NOTIFICATION_KIND.agentPermissionRequest,
        severity: "warning",
        title: "Agent permission required",
        message:
          conversation.title && conversation.title !== "New chat"
            ? `${conversation.title}: ${pending.title ?? "Waiting for approval to continue."}`
            : pending.title ?? "Waiting for approval to continue.",
        persistent: true,
        actions: (pending.options ?? []).map((option) => ({
          id: `${key}:${option.optionId}`,
          label: option.name,
          primary: option.kind === "allow_once" || option.kind === "allow_always",
          onClick: () => {
            void answerPermissionForConversation(
              conversation.id,
              pending.requestId,
              option.optionId
            );
          },
        })),
        onDismiss: () => {
          permissionToastIdsRef.current.delete(key);
          dismissedPermissionToastKeysRef.current.add(key);
        },
      });
      permissionToastIdsRef.current.set(key, notificationId);
    }

    for (const [key, notificationId] of permissionToastIdsRef.current.entries()) {
      if (nextKeys.has(key)) {
        continue;
      }
      dismiss(notificationId);
      permissionToastIdsRef.current.delete(key);
      dismissedPermissionToastKeysRef.current.delete(key);
    }

    for (const key of Array.from(dismissedPermissionToastKeysRef.current)) {
      if (!nextKeys.has(key)) {
        dismissedPermissionToastKeysRef.current.delete(key);
      }
    }
  }, [
    answerPermissionForConversation,
    conversationsById,
    dismiss,
    pushNotification,
  ]);

  useEffect(() => {
    return () => {
      for (const notificationId of permissionToastIdsRef.current.values()) {
        dismiss(notificationId);
      }
      permissionToastIdsRef.current.clear();
      dismissedPermissionToastKeysRef.current.clear();
    };
  }, [dismiss]);

  const { scrollMessages, dockedAsk } =
    partitionMessagesForDock(threadMessages);

  const dockedAskSteps = useMemo(
    () => (dockedAsk ? askStepsFromMessage(dockedAsk) : []),
    [dockedAsk]
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
  }, [createConversationAndOpen, expandedComposerDraftId, hideConversationIds, setExpandedComposerDraft, setTabs]);

  const closeOtherChatTabs = useCallback(
    (tabId: string) => {
      const keep = tabsRef.current.find((tab) => tab.id === tabId);
      if (!keep) {
        return;
      }
      if (expandedComposerDraftId && expandedComposerDraftId !== tabId) {
        setExpandedComposerDraft(null);
      }
      hideConversationIds(
        tabsRef.current.filter((tab) => tab.id !== tabId).map((tab) => tab.id)
      );
      setTabs(() => [{ ...keep, active: true }]);
    },
    [expandedComposerDraftId, hideConversationIds, setExpandedComposerDraft, setTabs]
  );

  const closeAllChatTabs = useCallback(() => {
    if (expandedComposerDraftId) {
      setExpandedComposerDraft(null);
    }
    hideConversationIds(tabsRef.current.map((tab) => tab.id));
    setTabs(() => []);
    void createConversationAndOpen();
  }, [createConversationAndOpen, expandedComposerDraftId, hideConversationIds, setExpandedComposerDraft, setTabs]);

  const handleResolveActivePermission = useCallback(
    (requestId: string, optionId: string) => {
      if (!activeConversation) {
        return;
      }
      void answerPermissionForConversation(activeConversation.id, requestId, optionId);
    },
    [activeConversation, answerPermissionForConversation]
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

  const handleChatTabContextMenu = useCallback(
    (e: MouseEvent, tabId: string) => {
      const othersOpen = tabs.length > 1;
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

  const submitPromptForDraft = useCallback(
    async (draftId: string, text: string) => {
      let conversationIdForError = conversationsById[draftId]?.id;
      try {
        const conversation =
          conversationsById[draftId] ??
          (draftId === activeConversation?.id ? activeConversation : null) ??
          (await createConversationAndOpen());
        conversationIdForError = conversation.id;
        const snapshot = await promptAgentConversation(conversation.id, text);
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
    [activeConversation, conversationsById, createConversationAndOpen, mergeSnapshot, pushNotification]
  );

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
      onSubmit: (text: string) => submitPromptForDraft(expandedComposerDraftId, text),
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
      onSubmit={async (text) => { await submitPromptForDraft(composerDraftId, text); }}
      onCancel={() => cancelPromptForDraft(composerDraftId)}
      layout={isEmptyThread ? "empty-top" : "docked-bottom"}
    />
  );

  return (
    <div className="flex h-full min-h-0 w-full flex-col overflow-hidden bg-[var(--bg-panel)]">
      <div className="shrink-0">
        <ChatTabs
          tabs={tabs}
          onSelectTab={handleSelectTab}
          onCloseTab={closeChatTab}
          onNewChat={handleNewChat}
          onTabContextMenu={handleChatTabContextMenu}
          onStripContextMenu={handleChatStripContextMenu}
        />
      </div>

      {isEmptyThread ? (
        <div className="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden">
          {!composerHiddenForExpanded ? (
            <div className="shrink-0">
              {pendingPermissionDock}
              {composer}
            </div>
          ) : null}
          <div
            className="min-h-0 flex-1 bg-[var(--bg-panel)]"
            aria-hidden
          />
        </div>
      ) : (
        <div className="relative min-h-0 min-w-0 flex-1 overflow-hidden">
          <MessageList
            key={activeTabId}
            messages={scrollMessages}
            onResolvePermission={handleResolveActivePermission}
            initialScrollTop={workspaceSession.chat.scrollTopByTabId[activeTabId] ?? 0}
            onScrollTopSettled={handleScrollTopSettled}
            bottomDockVisible={!composerHiddenForExpanded}
          />
          {!composerHiddenForExpanded ? (
            <div className="pointer-events-none absolute inset-x-0 bottom-0 z-30">
              <div className="pointer-events-auto chat-bottom-dock">
                {pendingPermissionDock ? (
                  <div className="pointer-events-auto">{pendingPermissionDock}</div>
                ) : null}
                {dockedAskSteps.length > 0 ? (
                  <div className="px-[10px] pt-[8px]">
                    <AskQuestionCard steps={dockedAskSteps} dockAboveComposer />
                  </div>
                ) : null}
                {composer}
              </div>
            </div>
          ) : null}
        </div>
      )}
    </div>
  );
}
