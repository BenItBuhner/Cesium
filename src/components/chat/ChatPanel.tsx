"use client";

import {
  useCallback,
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
import { MessageList, type MessageListScrollPersistMeta } from "./MessageList";
import { ChatComposer } from "./ChatComposer";
import { ComposerQueueDock } from "./ComposerQueueDock";
import { AgentCompletionErrorDock } from "./AgentCompletionErrorDock";
import { useAgentCompletionErrorDock } from "./useAgentCompletionErrorDock";
import { AskQuestionCard } from "./AskQuestionCard";
import { RecentChatsModal } from "@/components/ide/RecentChatsModal";
import {
  findDockedAskQuestion,
  hideDockedAskFromScroll,
} from "@/lib/ask-question-dock";
import {
  buildDraftModeOptionsForBackend,
  buildDraftModelOptionsForBackend,
  buildConversationModeOptions,
  buildConversationModelOptions,
  extractComposerUserMessageHistory,
  isAgentConversationBusy,
  projectAgentEventsToChatMessages,
  resolveDraftModelForBackend,
  resolveConversationModel,
} from "@/lib/agent-chat";
import { DEFAULT_MODE_OPTIONS, isOrchestrationModeLocked, resolveCanonicalModeId } from "@/lib/chat-modes";
import { listSupplementaryAgentConfigOptions } from "@/lib/agent-config-option-utils";
import { useWorkbenchContextMenu } from "@/components/ide/WorkbenchContextMenuProvider";
import { useWorkbench } from "@/components/ide/WorkbenchContext";
import {
  useOpenInEditor,
  useRegisterDesignCaptureComposer,
} from "@/components/editor/OpenInEditorContext";
import type { ComposerDraftRecord } from "@/components/editor/OpenInEditorContext";
import { hasMeaningfulComposerContent } from "@/components/editor/OpenInEditorContext";
import { buildQueuedConfigOverride } from "@/lib/queued-prompt-utils";
import type { WorkbenchMenuItem } from "@/components/ide/workbench-context-menu-types";
import type {
  AgentBackendId,
  AgentBackendInfo,
  AgentConversationRecord,
} from "@/lib/agent-types";
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
import { useAgentConversations } from "@/components/chat/AgentConversationsContext";
import { useWorkbenchNotifications } from "@/components/notifications/WorkbenchNotificationProvider";
import { useGlobalSettings } from "@/components/preferences/GlobalSettingsProvider";
import { useUserPreferences } from "@/components/preferences/UserPreferencesProvider";
import { useIsCesiumDesktopApp } from "@/lib/desktop-environment";
import { WORKBENCH_NOTIFICATION_KIND } from "@/components/notifications/workbench-notification-types";
import {
  createWorkspaceWindow,
  deleteAgentConversationQueueItem,
  fetchAgentConversationSnapshot,
  forkAgentConversation,
  generateDraftTitle,
  handoffAgentConversation,
  patchAgentConversationMetadata,
  prepareRedoAgentConversation,
  saveWorkspaceWindowSession,
  updateAgentConversationConfig,
} from "@/lib/server-api";
import { dispatchAgentConversationUpserted } from "@/lib/agent-conversation-events";
import {
  createPersistableWorkspaceSession,
  resolvePersistedChatScroll,
} from "@/lib/workspace-session";
import { getActiveServerStorageKey } from "@/lib/server-connections";
import { getConfiguredServerBaseUrl } from "@/lib/resolve-server-base-url";
import {
  buildWorkspaceWindowUrl,
  FRESH_WORKSPACE_WINDOW_HIDDEN_CONVERSATIONS_SENTINEL,
  normalizeWorkspaceWindowSession,
} from "@/lib/workspace-windows";
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
      Boolean(tab.active) === Boolean(b[index]?.active) &&
      Boolean(tab.isDraft) === Boolean(b[index]?.isDraft)
  );
}

function createDraftChatTab(): ChatTab {
  const id =
    typeof crypto !== "undefined" && "randomUUID" in crypto
      ? `draft-${crypto.randomUUID()}`
      : `draft-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
  return {
    id,
    title: "New chat",
    active: true,
    isDraft: true,
  };
}

function isLocalDraftChatTab(tab: ChatTab): boolean {
  return Boolean(tab.isDraft) && tab.id.startsWith("draft-");
}

function isEmptyLocalDraftChatTab(
  tab: ChatTab,
  composerDrafts: Record<string, ComposerDraftRecord>
): boolean {
  const draft = composerDrafts[tab.id];
  return (
    isLocalDraftChatTab(tab) &&
    tab.title === "New chat" &&
    (!draft || !hasMeaningfulComposerContent(draft))
  );
}

function normalizeChatTabs(
  tabs: ChatTab[],
  composerDrafts: Record<string, ComposerDraftRecord>
): ChatTab[] {
  const emptyDraftTabs = tabs.filter((tab) =>
    isEmptyLocalDraftChatTab(tab, composerDrafts)
  );
  const keepEmptyDraftId =
    emptyDraftTabs.find((tab) => tab.active)?.id ?? emptyDraftTabs[0]?.id ?? null;
  const seenIds = new Set<string>();
  const deduped: ChatTab[] = [];
  let activeId: string | null = null;

  for (const tab of tabs) {
    if (
      isEmptyLocalDraftChatTab(tab, composerDrafts) &&
      tab.id !== keepEmptyDraftId
    ) {
      continue;
    }
    if (seenIds.has(tab.id)) {
      if (tab.active) {
        activeId = tab.id;
      }
      continue;
    }
    seenIds.add(tab.id);
    deduped.push(tab);
    if (tab.active) {
      activeId = tab.id;
    }
  }

  if (deduped.length === 0) {
    return deduped;
  }

  const resolvedActiveId = activeId ?? deduped[0]?.id ?? null;
  return deduped.map((tab) => ({
    ...tab,
    active: tab.id === resolvedActiveId,
  }));
}

function conversationRequiresVisibleTab(conversation: AgentConversationRecord): boolean {
  return (
    conversation.status === "running" ||
    conversation.status === "awaiting_permission"
  );
}

function isRecentConversationCandidate(
  conversation: AgentConversationRecord,
  composerDrafts: Record<string, ComposerDraftRecord>
): boolean {
  if (conversation.lastEventSeq > 0 || conversationRequiresVisibleTab(conversation)) {
    return true;
  }
  if (conversation.title.startsWith("Draft: ")) {
    return true;
  }
  const draft = composerDrafts[conversation.id];
  return Boolean(draft && hasMeaningfulComposerContent(draft));
}

type RedoMessageDraft = {
  messageId: string;
  content: string;
  attachments?: ImageAttachment[];
  backendId: AgentBackendId;
  mode: EditorMode;
  model: ModelInfo;
};

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

export function ChatPanel() {
  const { openAt } = useWorkbenchContextMenu();
  const { chatTrailingWindowControlsVisible } = useWorkbench();
  const isDesktopApp = useIsCesiumDesktopApp();
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
    workspaceInfo,
    workspaceSession,
    workspaceWindows,
    updateWorkspaceSession,
    updateWorkspaceSessionNow,
  } = useWorkspace();
const {
backends,
conversationsById,
conversations,
eventsByConversationId,
bootstrapped,
mergeConversationSnapshot,
refreshConversations,
syncConversationSnapshot,
upsertConversation,
answerPermissionForConversation,
answerQuestionForConversation,
cancelConversation: cancelConversationFromHook,
pauseConversation: pauseConversationFromHook,
resumeConversation: resumeConversationFromHook,
createConversation,
getConversationHistoryCursor,
loadOlderConversationHistory,
setConversationMode,
setConversationModel,
setConversationConfigOption,
promptConversation,
retryConversation,
pendingConfigByConversationId,
setPendingConfigForConversation,
clearPendingConfigForConversation,
} = useAgentConversations();
  const { settings: globalSettings } = useGlobalSettings();
  const { experimentalIpadWindowedTabInset } = useUserPreferences();
  const padTabsForWindowChrome =
    experimentalIpadWindowedTabInset && chatTrailingWindowControlsVisible;
  const electronChatTrailingChrome =
    isDesktopApp && chatTrailingWindowControlsVisible;
  const [recentChatsModalOpen, setRecentChatsModalOpen] = useState(false);
  const [chatTabRenameTargetId, setChatTabRenameTargetId] = useState<string | null>(
null
);
  const [redoMessageDraft, setRedoMessageDraft] = useState<RedoMessageDraft | null>(null);
  const redoEditorRef = useRef<HTMLDivElement>(null);
const chatDraftRef = useRef(workspaceSession.chat);
  const tabsRef = useRef<ChatTab[]>(workspaceSession.chat.tabs);
  const composerDraftsRef = useRef(composerDrafts);
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
    composerDraftsRef.current = composerDrafts;
  }, [composerDrafts]);

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
          tabs: normalizeChatTabs(
            updater(current.chat.tabs),
            composerDraftsRef.current
          ),
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

  const applyHandoffServerResult = useCallback(
    async (result: { newConversationId: string }) => {
      const nextConversations = await refreshConversations();
      const newConv = nextConversations.find((c) => c.id === result.newConversationId);
      if (!newConv) {
      pushNotification({
        kind: WORKBENCH_NOTIFICATION_KIND.editorNotice,
        severity: "error",
        title: "Handoff Failed",
        message: "Server did not return the new conversation in the workspace list.",
        compact: true,
      });
        throw new Error("Handoff list sync failed.");
      }
      const snap = await fetchAgentConversationSnapshot(result.newConversationId);
      mergeConversationSnapshot(snap.snapshot);
      setTabs((current) => {
        const existingTab = current.find((tab) => tab.id === newConv.id);
        if (existingTab) {
          return current.map((tab) => ({ ...tab, active: tab.id === newConv.id }));
        }
        return [
          ...current.map((tab) => ({ ...tab, active: false })),
          { id: newConv.id, title: newConv.title, active: true },
        ];
      });
      unhideConversationIds([newConv.id]);
    },
    [mergeConversationSnapshot, pushNotification, refreshConversations, setTabs, unhideConversationIds]
  );

const handoffConversationInPlace = useCallback(
async (conversationId: string, targetBackendId: AgentBackendId) => {
const conversation = conversationsByIdRef.current[conversationId];
if (!conversation) {
return false;
}
if (
conversation.status === "running" ||
conversation.status === "awaiting_permission"
) {
setPendingConfigForConversation(conversationId, { backendId: targetBackendId });
return true;
}
try {
const result = await handoffAgentConversation(conversationId, targetBackendId);
clearPendingConfigForConversation(conversationId);
await applyHandoffServerResult(result);
return true;
} catch (error) {
const message = error instanceof Error ? error.message : "Failed to hand off conversation.";
pushNotification({
kind: WORKBENCH_NOTIFICATION_KIND.editorNotice,
severity: "error",
title: "Handoff Failed",
message,
autoDismissMs: 8000,
compact: true,
});
return false;
}
},
[applyHandoffServerResult, clearPendingConfigForConversation, pushNotification, setPendingConfigForConversation]
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
const conv = conversationsByIdRef.current[draftId];
const currentMode = resolveCanonicalModeId(
  String(conv?.config.mode ?? workspaceSession.chat.mode ?? ""),
  conv ? buildConversationModeOptions(conv, backends) : DEFAULT_MODE_OPTIONS
) as EditorMode;
if (isOrchestrationModeLocked(currentMode, true)) {
  return;
}
if (conv && (conv.status === "running" || conv.status === "awaiting_permission")) {
setPendingConfigForConversation(draftId, { mode: next });
return;
}
try {
await setConversationMode(draftId, next);
} catch {
void syncConversationSnapshot(draftId).catch(() => undefined);
}
},
[backends, setConversationMode, setPendingConfigForConversation, syncConversationSnapshot, updateWorkspaceSession, workspaceSession.chat.mode]
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
const conv = conversationsByIdRef.current[draftId];
if (conv && (conv.status === "running" || conv.status === "awaiting_permission")) {
const modelId = next.modelValue ?? next.id;
setPendingConfigForConversation(draftId, {
modelId,
modelName: next.name,
setConfigOptions: next.configSelections,
});
return;
}
try {
await setConversationModel(draftId, next);
} catch {
void syncConversationSnapshot(draftId).catch(() => undefined);
}
},
[setConversationModel, setPendingConfigForConversation, syncConversationSnapshot, updateWorkspaceSession]
  );

  const setSessionConfigOptionForDraft = useCallback(
    async (draftId: string, configId: string, value: string) => {
      if (!isPersistedConversationTabId(draftId)) {
        return;
      }
      try {
        await setConversationConfigOption(draftId, configId, value);
      } catch {
        void syncConversationSnapshot(draftId).catch(() => undefined);
      }
    },
    [setConversationConfigOption, syncConversationSnapshot]
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
const conv = conversationsById[draftId];
const resolvedBackend = pickAvailableBackend(backends, nextBackendId);
const useBackendId = resolvedBackend?.id ?? nextBackendId;
if (conv && useBackendId === conv.config.backendId) {
clearPendingConfigForConversation(draftId);
return;
}
if (conv) {
await handoffConversationInPlace(draftId, useBackendId);
}
},
[
backends,
clearPendingConfigForConversation,
conversationsById,
handoffConversationInPlace,
updateWorkspaceSession,
workspaceSession.chat.mode,
]
  );

  const createConversationAndOpen = useCallback(async (options?: { replaceTabId?: string }) => {
    const draft = chatDraftRef.current;
    const conversation = await createConversation({
      backendId: draft.backendId,
      mode: draft.mode,
      modelId: draft.model.modelValue ?? draft.model.id,
      modelName: draft.model.name,
    });
    setTabs((current) => {
      const replaceTabId = options?.replaceTabId;
      if (replaceTabId && current.some((tab) => tab.id === replaceTabId)) {
        return current.map((tab) =>
          tab.id === replaceTabId
            ? { id: conversation.id, title: conversation.title, active: true }
            : { ...tab, active: false }
        );
      }
      return [
        ...current.map((tab) => ({ ...tab, active: false })),
        { id: conversation.id, title: conversation.title, active: true },
      ];
    });
    unhideConversationIds([conversation.id]);
    return conversation;
  }, [createConversation, setTabs, unhideConversationIds]);

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
    return getConversationHistoryCursor(activeTabId);
  }, [activeTabId, getConversationHistoryCursor]);
  const restoredChatScroll = useMemo(
    () =>
      resolvePersistedChatScroll(
        workspaceSession.chat.scrollTopByTabId,
        workspaceSession.chat.scrollAnchorByTabId ?? {},
        activeTabId,
        activeWorkspaceId,
        activeWindowId,
        getActiveServerStorageKey(getConfiguredServerBaseUrl())
      ),
    [
      activeTabId,
      activeWorkspaceId,
      activeWindowId,
      workspaceSession.chat.scrollTopByTabId,
      workspaceSession.chat.scrollAnchorByTabId,
    ]
  );
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
  const activeBackend = useMemo(
    () =>
      backends.find((backend) => backend.id === activeConversation?.config.backendId) ?? null,
    [activeConversation?.config.backendId, backends]
  );
  const dismissedCompletionErrorKey = activeConversation?.id
    ? workspaceSession.chat.dismissedCompletionErrorKeyByConversationId?.[
        activeConversation.id
      ]
    : undefined;
  const completionErrorDock = useAgentCompletionErrorDock({
    conversation: activeConversation,
    events: activeTabId ? eventsByConversationId[activeTabId] : undefined,
    backend: activeBackend,
    dismissedKey: dismissedCompletionErrorKey,
    onDismiss: (dismissKey) => {
      if (!activeConversation?.id) {
        return;
      }
      updateWorkspaceSession((current) => ({
        ...current,
        chat: {
          ...current.chat,
          dismissedCompletionErrorKeyByConversationId: {
            ...current.chat.dismissedCompletionErrorKeyByConversationId,
            [activeConversation.id]: dismissKey,
          },
        },
      }));
    },
    onRetry: async (conversationId) => {
      await retryConversation(conversationId);
    },
  });
  useEffect(() => {
    setRedoMessageDraft(null);
  }, [activeConversation?.id]);
  useEffect(() => {
    if (!redoMessageDraft) {
      return;
    }

    const handlePointerDown = (event: PointerEvent) => {
      const target = event.target;
      if (!(target instanceof Node)) {
        return;
      }
      const editor = redoEditorRef.current;
      if (editor?.contains(target)) {
        return;
      }
      if (
        target instanceof Element &&
        (target.closest("[data-ide-composer-floating-popover]") ||
          target.closest("#composer-autocomplete"))
      ) {
        return;
      }
      setRedoMessageDraft(null);
    };

    document.addEventListener("pointerdown", handlePointerDown, true);
    return () => document.removeEventListener("pointerdown", handlePointerDown, true);
  }, [redoMessageDraft]);
  const recentConversations = useMemo(
    () =>
      conversations
        .filter(
          (conversation) =>
            conversation.id !== activeConversation?.id &&
            isRecentConversationCandidate(conversation, composerDrafts)
        )
        .sort((a, b) => b.updatedAt - a.updatedAt),
    [activeConversation?.id, conversations, composerDrafts]
  );
  const recentConversationPreview = useMemo(
    () => recentConversations.slice(0, 5),
    [recentConversations]
  );
  const showRecentChatsSection =
    (activeConversation?.title === "New chat" || activeConversation?.title?.startsWith("Draft: ")) &&
    recentConversationPreview.length > 0;
  const composerDraftId = activeConversation?.id ?? activeTabId;
  useRegisterDesignCaptureComposer(composerDraftId, 5);
  const composerDraftTitle =
    activeConversation?.title && activeConversation.title !== "New chat" && !activeConversation.title.startsWith("Draft: ")
      ? `${activeConversation.title} prompt`
      : "Composer";
  const composerDraftText = composerDrafts[composerDraftId]?.content ?? "";
  const composerDraftAttachments = composerDrafts[composerDraftId]?.attachments;
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
  const modelVisibility = globalSettings.models.byBackend;
  const draftModels = useMemo(
    () => (draftBackend ? buildDraftModelOptionsForBackend(draftBackend, modelVisibility) : [workspaceSession.chat.model]),
    [draftBackend, workspaceSession.chat.model, modelVisibility]
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
  const composerUserMessageHistory = useMemo(
    () => extractComposerUserMessageHistory(rawPanelThreadEvents),
    [rawPanelThreadEvents]
  );
  const threadMessages = useMemo(
    () =>
      projectAgentEventsToChatMessages(rawPanelThreadEvents, {
        backendId: activeConversation?.config.backendId,
        workspaceRoot: workspaceInfo?.root ?? null,
      }),
    [activeConversation?.config.backendId, activeTabId, rawPanelThreadEvents, workspaceInfo?.root]
  );
  const isEmptyThread = threadMessages.length === 0;
const resolveComposerStateForDraft = useCallback(
(draftId: string) => {
const conversation = conversationsById[draftId] ?? null;
const busy = conversation ? isAgentConversationBusy(conversation.status) : false;
const pendingConfig = pendingConfigByConversationId[draftId];
const pendingBackendId = pendingConfig?.backendId;
const pendingMode = pendingConfig?.mode;
const pendingModelId = pendingConfig?.modelId;
const pendingTarget = busy && pendingBackendId ? pendingBackendId : undefined;
const backendFromConversation =
conversation
? pickAvailableBackend(backends, conversation.config.backendId)
: draftBackend;
const backendForPending = pendingTarget != null ? pickAvailableBackend(backends, pendingTarget) : null;
const backend =
pendingTarget != null && backendForPending
? backendForPending
: backendFromConversation;
const models =
pendingTarget != null && backend
? buildDraftModelOptionsForBackend(backend, modelVisibility)
: conversation
? buildConversationModelOptions(conversation, backends, modelVisibility)
: backend
? buildDraftModelOptionsForBackend(backend, modelVisibility)
: [workspaceSession.chat.model];
const model = conversation
? pendingTarget != null && backend
? resolveDraftModelForBackend(backend)
: pendingModelId && busy
? models.find((m) => (m.modelValue ?? m.id) === pendingModelId) ?? resolveConversationModel(conversation, backends)
: resolveConversationModel(conversation, backends)
: backend
? (() => {
const currentModelValue = workspaceSession.chat.model.modelValue ?? workspaceSession.chat.model.id;
return (
models.find(
(candidate) => (candidate.modelValue ?? candidate.id) === currentModelValue
) ?? resolveDraftModelForBackend(backend)
);
})()
: workspaceSession.chat.model;
const modeOptions =
pendingTarget != null && backend
? buildDraftModeOptionsForBackend(backend)
: conversation
? buildConversationModeOptions(conversation, backends)
: backend
? buildDraftModeOptionsForBackend(backend)
: DEFAULT_MODE_OPTIONS;
const mode = resolveCanonicalModeId(
String(
(pendingTarget != null && backend
? buildDraftModeOptionsForBackend(backend)[0]?.id
: busy && pendingMode
? pendingMode
: conversation?.config.mode) ?? workspaceSession.chat.mode ?? ""
),
modeOptions
) as EditorMode;
return {
conversation,
backendId:
(pendingTarget != null ? pickAvailableBackend(backends, pendingTarget)?.id : undefined) ??
conversation?.config.backendId ??
backend?.id ??
workspaceSession.chat.backendId,
models,
model,
modeOptions,
mode,
sessionConfigOptions:
pendingTarget != null ? [] : conversation
? listSupplementaryAgentConfigOptions(conversation)
: [],
busy,
};
},
[
backends,
conversationsById,
draftBackend,
modelVisibility,
pendingConfigByConversationId,
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
  const modeLocked = isOrchestrationModeLocked(
    mode,
    isPersistedConversationTabId(composerDraftId)
  );

  const flashError = useCallback(
  (message: string) => {
    pushNotification({
      kind: WORKBENCH_NOTIFICATION_KIND.editorNotice,
      severity: "error",
      title: "Chat",
      message,
      autoDismissMs: 8000,
      compact: true,
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

  const dockedAsk = useMemo(
    () =>
      findDockedAskQuestion({
        events: rawPanelThreadEvents,
        conversation: activeConversation,
      }),
    [activeConversation, rawPanelThreadEvents]
  );
  const scrollMessages = useMemo(
    () => hideDockedAskFromScroll(threadMessages, dockedAsk),
    [dockedAsk, threadMessages]
  );
  const [submittingQuestion, setSubmittingQuestion] = useState(false);

  const activeQueuedPrompts = useMemo(
    () => activeConversation?.queuedPrompts ?? [],
    [activeConversation?.id, activeConversation?.queuedPrompts]
  );

  const removeQueuedPromptForActiveChat = useCallback(
    (item: QueuedChatPrompt) => {
      const cid = activeConversation?.id;
      if (!cid) {
        return;
      }
      void (async () => {
        try {
          const { conversation } = await deleteAgentConversationQueueItem(cid, item.id);
          upsertConversation(conversation);
        } catch {
          void syncConversationSnapshot(cid).catch(() => undefined);
        }
      })();
    },
    [activeConversation?.id, syncConversationSnapshot, upsertConversation]
  );

  const unqueuePromptToComposer = useCallback(
    (item: QueuedChatPrompt) => {
      const cid = activeConversation?.id;
      if (!cid) {
        return;
      }
      void (async () => {
        try {
          const { conversation } = await deleteAgentConversationQueueItem(cid, item.id);
          upsertConversation(conversation);
        } catch {
          void syncConversationSnapshot(cid).catch(() => undefined);
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
      activeConversation?.id,
      composerDraftId,
      composerDraftTitle,
      syncConversationSnapshot,
      upsertComposerDraft,
    ]
  );

  const editQueuedPromptForActiveChat = useCallback(
    (item: QueuedChatPrompt) => {
      const cid = activeConversation?.id;
      if (!cid) {
        return;
      }
      void (async () => {
        try {
          const { conversation } = await deleteAgentConversationQueueItem(cid, item.id);
          upsertConversation(conversation);
        } catch {
          void syncConversationSnapshot(cid).catch(() => undefined);
          return;
        }
        upsertComposerDraft(composerDraftId, {
          title: composerDraftTitle,
          content: item.text,
          attachments: item.attachments,
        });
        if (item.configOverride) {
          setPendingConfigForConversation(cid, item.configOverride);
        }
        updateWorkspaceSession((current) => ({
          ...current,
          chat: {
            ...current.chat,
            editingQueuedPromptIdByConversationId: {
              ...(current.chat.editingQueuedPromptIdByConversationId ?? {}),
              [cid]: item.id,
            },
          },
        }));
      })();
    },
    [
      activeConversation?.id,
      composerDraftId,
      composerDraftTitle,
      setPendingConfigForConversation,
      syncConversationSnapshot,
      updateWorkspaceSession,
      upsertComposerDraft,
    ]
  );

  const clearEditingQueuedPromptForConversation = useCallback(
    (conversationId: string) => {
      updateWorkspaceSession((current) => {
        const currentMap = current.chat.editingQueuedPromptIdByConversationId ?? {};
        if (!currentMap[conversationId]) {
          return current;
        }
        const nextMap = { ...currentMap };
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
    if (!activeWorkspaceId || !bootstrapped) {
      return;
    }
    updateWorkspaceSession((current) => {
      const validIds = new Set(conversations.map((c) => c.id));
      const hiddenConversationIds = new Set(current.chat.hiddenConversationIds);
      const currentComposerDrafts = composerDraftsRef.current;
      const existing = current.chat.tabs
        .filter((tab) => validIds.has(tab.id) || isLocalDraftChatTab(tab))
        .map((tab) => {
          if (isLocalDraftChatTab(tab)) {
            return tab;
          }
          const serverConversation = conversations.find((c) => c.id === tab.id);
          const serverTitle = serverConversation?.title ?? tab.title;
          const isDraft = tab.isDraft && serverConversation?.lastEventSeq === 0;
          return {
            ...tab,
            title: isDraft ? tab.title : serverTitle,
            isDraft: isDraft || undefined,
          };
        });
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
            (isRecentConversationCandidate(conversation, currentComposerDrafts) &&
              !hiddenConversationIds.has(conversation.id)) ||
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
      const dedupedTabs = normalizeChatTabs(normalizedTabs, currentComposerDrafts);
      return tabsEqual(current.chat.tabs, dedupedTabs)
        ? current
        : {
            ...current,
            chat: {
              ...current.chat,
              tabs: dedupedTabs,
            },
          };
    });
  }, [activeWorkspaceId, bootstrapped, conversations, updateWorkspaceSession]);

  const prevActiveTabIdRef = useRef<string | null>(null);

  useEffect(() => {
    const prevTabId = prevActiveTabIdRef.current;
    prevActiveTabIdRef.current = activeTabId;

    if (!prevTabId || prevTabId === activeTabId || prevTabId === "__empty__") {
      return;
    }

    const prevTab = tabs.find((t) => t.id === prevTabId);
    if (prevTab?.isDraft) {
      return;
    }

    const prevConversation = conversationsById[prevTabId];
    if (!prevConversation || prevConversation.lastEventSeq > 0) {
      return;
    }

    const draft = composerDrafts[prevTabId];
    if (!draft || !hasMeaningfulComposerContent(draft)) {
      return;
    }

    let cancelled = false;
    void (async () => {
      try {
        const result = await generateDraftTitle(draft.content);
        if (cancelled) return;
        const generatedTitle = result.title ?? "Untitled";
        const draftTabTitle = `Draft: ${generatedTitle}`;
        setTabs((current) =>
          current.map((tab) =>
            tab.id === prevTabId
              ? { ...tab, title: draftTabTitle, isDraft: true }
              : tab
          )
        );
        unhideConversationIds([prevTabId]);
        void updateAgentConversationConfig(prevTabId, { title: draftTabTitle }).catch(() => undefined);
      } catch {
        if (cancelled) return;
        const fallbackTitle = "Draft: Untitled";
        setTabs((current) =>
          current.map((tab) =>
            tab.id === prevTabId
              ? { ...tab, title: fallbackTitle, isDraft: true }
              : tab
          )
        );
        unhideConversationIds([prevTabId]);
        void updateAgentConversationConfig(prevTabId, { title: fallbackTitle }).catch(() => undefined);
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [activeTabId, tabs, conversationsById, composerDrafts, setTabs, unhideConversationIds]);

  useEffect(() => {
    if (!activeWorkspaceId) {
      return;
    }
    const handleVisibilityChange = () => {
      if (document.visibilityState !== "visible") {
        return;
      }
      void refreshConversations().catch(() => undefined);
    };
    document.addEventListener("visibilitychange", handleVisibilityChange);
    return () => document.removeEventListener("visibilitychange", handleVisibilityChange);
  }, [activeWorkspaceId, refreshConversations]);

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
    setTabs((current) => {
      const existingEmptyDraft = current.find((tab) =>
        isEmptyLocalDraftChatTab(tab, composerDraftsRef.current)
      );
      if (existingEmptyDraft) {
        return current.map((tab) => ({
          ...tab,
          active: tab.id === existingEmptyDraft.id,
        }));
      }
      return [
        ...current.map((tab) => ({ ...tab, active: false })),
        createDraftChatTab(),
      ];
    });
  }, [expandedComposerDraftId, setExpandedComposerDraft, setTabs]);

  useEffect(() => {
    const handler = () => handleNewChat();
    window.addEventListener("opencursor:newChat", handler);
    return () => window.removeEventListener("opencursor:newChat", handler);
  }, [handleNewChat]);

  const closeChatTab = useCallback((tabId: string) => {
    const currentTabs = tabsRef.current;
    const remaining = currentTabs.filter((tab) => tab.id !== tabId);
    if (expandedComposerDraftId === tabId) {
      setExpandedComposerDraft(null);
    }
    if (remaining.length === 0) {
      void persistClosedTabsNow([], [tabId]);
      return;
    }
    const closingActive = currentTabs.find((tab) => tab.id === tabId)?.active;
    const nextTabs = !closingActive
      ? remaining
      : remaining.map((tab, index) => ({ ...tab, active: index === 0 }));
    void persistClosedTabsNow(nextTabs, [tabId]);
  }, [expandedComposerDraftId, persistClosedTabsNow, setExpandedComposerDraft]);

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
  }, [expandedComposerDraftId, persistClosedTabsNow, setExpandedComposerDraft]);

  const handleResolveActivePermission = useCallback(
    (requestId: string, optionId: string) => {
      if (!activeTabId || activeTabId === "__empty__") {
        return;
      }
      void answerPermissionForConversation(activeTabId, requestId, optionId);
    },
    [activeTabId, answerPermissionForConversation]
  );

  const handleScrollTopSettled = useCallback(
    (scrollTop: number, meta: MessageListScrollPersistMeta) => {
      updateWorkspaceSession((current) => {
        const map = current.chat.scrollTopByTabId;
        const anchorMap = { ...(current.chat.scrollAnchorByTabId ?? {}) };
        const hadTop = Object.hasOwn(map, activeTabId);
        if (meta.pinnedToBottom) {
          if (!hadTop && !Object.hasOwn(anchorMap, activeTabId)) {
            return current;
          }
          const nextMap = { ...map };
          delete nextMap[activeTabId];
          delete anchorMap[activeTabId];
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
          anchorMap[activeTabId] = meta.anchor;
        } else {
          delete anchorMap[activeTabId];
        }
        const prevTop = map[activeTabId];
        const prevAnchor = current.chat.scrollAnchorByTabId?.[activeTabId];
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
              [activeTabId]: scrollTop,
            },
            scrollAnchorByTabId: anchorMap,
          },
        };
      });
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
          scrollTopByTabId: Object.hasOwn(
            workspaceSession.chat.scrollTopByTabId,
            conversationId
          )
            ? {
                [conversationId]: workspaceSession.chat.scrollTopByTabId[conversationId]!,
              }
            : {},
          scrollAnchorByTabId: Object.hasOwn(
            workspaceSession.chat.scrollAnchorByTabId ?? {},
            conversationId
          )
            ? {
                [conversationId]: workspaceSession.chat.scrollAnchorByTabId![conversationId]!,
              }
            : {},
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
            void (async () => {
              try {
                const { conversation } = await patchAgentConversationMetadata(tabId, {
                  archived: true,
                });
                dispatchAgentConversationUpserted(conversation);
              } catch {
                /* list refresh in shell */
              }
            })();
            closeChatTab(tabId);
          },
        },
        {
          type: "item",
          id: "fork",
          label: "Fork",
          disabled: !targetConversation || targetConversation.status === "running" || targetConversation.status === "awaiting_permission",
          onSelect: () => {
            if (!targetConversation) return;
            void forkAgentConversation(targetConversation.id).then(
              async (result) => {
                const nextConversations = await refreshConversations();
                const newConv = nextConversations.find(
                  (c) => c.id === result.conversation.id
                );
                if (!newConv) {
                  pushNotification({
                    kind: WORKBENCH_NOTIFICATION_KIND.editorNotice,
                    severity: "error",
                    title: "Fork Failed",
                    message: "Server did not return the new conversation in the workspace list.",
                    compact: true,
                  });
                  return;
                }
                const snap = await fetchAgentConversationSnapshot(result.conversation.id);
                mergeConversationSnapshot(snap.snapshot);
                setTabs((current) => {
                  const existingTab = current.find((tab) => tab.id === newConv.id);
                  if (existingTab) {
                    return current.map((tab) => ({ ...tab, active: tab.id === newConv.id }));
                  }
                  return [
                    ...current.map((tab) => ({ ...tab, active: false })),
                    { id: newConv.id, title: newConv.title, active: true },
                  ];
                });
                unhideConversationIds([newConv.id]);
              }
            ).catch((error) => {
              const message =
                error instanceof Error ? error.message : "Failed to fork conversation.";
              pushNotification({
                kind: WORKBENCH_NOTIFICATION_KIND.editorNotice,
                severity: "error",
                title: "Fork Failed",
                message,
                autoDismissMs: 8000,
                compact: true,
              });
            });
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
    mergeConversationSnapshot,
    moveConversationToWorkspaceWindow,
    openAgentConversation,
    openAt,
    pushNotification,
    refreshConversations,
    setTabs,
    tabs,
    unhideConversationIds,
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
    async (
      draftId: string,
      text: string,
      attachments?: ImageAttachment[],
      options?: { delivery?: "normal" | "steer" }
    ) => {
      let conversationIdForError = conversationsById[draftId]?.id;
      try {
        const conversation =
          conversationsById[draftId] ??
          (draftId === activeConversation?.id ? activeConversation : null) ??
          (await createConversationAndOpen(
            draftId.startsWith("draft-") ? { replaceTabId: draftId } : undefined
          ));
        conversationIdForError = conversation.id;

        const draftTab = tabs.find((t) => t.id === conversation.id);
        if (draftTab?.isDraft) {
          setTabs((current) =>
            current.map((tab) =>
              tab.id === conversation.id
                ? { ...tab, title: "New chat", isDraft: undefined }
                : tab
            )
          );
        }

        const pendingConfig = isPersistedConversationTabId(conversation.id)
          ? pendingConfigByConversationId[conversation.id]
          : undefined;
        const isBusy =
          conversation.status === "running" || conversation.status === "awaiting_permission";

        if (pendingConfig && !isBusy) {
          const pendingTarget = pendingConfig.backendId;
          if (pendingTarget && pendingTarget !== conversation.config.backendId) {
            try {
              const handoffResult = await handoffAgentConversation(conversation.id, pendingTarget);
              clearPendingConfigForConversation(conversation.id);
              await applyHandoffServerResult(handoffResult);
              const ok = await promptConversation(
                handoffResult.newConversationId,
                text,
                attachments,
                undefined,
                options?.delivery
              );
              clearEditingQueuedPromptForConversation(conversation.id);
              return ok;
            } catch (error) {
              const message =
                error instanceof Error ? error.message : "Failed to hand off conversation.";
              pushNotification({
                kind: WORKBENCH_NOTIFICATION_KIND.editorNotice,
                severity: "error",
                title: "Handoff Failed",
                message,
                autoDismissMs: 8000,
                compact: true,
              });
              return false;
            }
          }
          if (pendingConfig.mode || pendingConfig.modelId || pendingConfig.setConfigOptions) {
            try {
              const patch: Record<string, unknown> = {};
              if (pendingConfig.mode) patch.mode = pendingConfig.mode;
              if (pendingConfig.modelId) {
                patch.modelId = pendingConfig.modelId;
                patch.modelName = pendingConfig.modelName;
              }
              if (pendingConfig.setConfigOptions) {
                patch.setConfigOptions = pendingConfig.setConfigOptions;
              }
              const updated = await updateAgentConversationConfig(conversation.id, patch);
              upsertConversation(updated.conversation);
              clearPendingConfigForConversation(conversation.id);
              clearEditingQueuedPromptForConversation(conversation.id);
            } catch {
              void syncConversationSnapshot(conversation.id).catch(() => undefined);
            }
          }
        }

        if (isBusy) {
          const state = resolveComposerStateForDraft(conversation.id);
          const derivedOverride = buildQueuedConfigOverride(
            conversation.config,
            state.backendId,
            state.mode,
            state.model
          );
          const merged: typeof derivedOverride = { ...derivedOverride, ...pendingConfig };
          const configOverride =
            merged && Object.keys(merged).length > 0 ? merged : undefined;
          const ok = await promptConversation(
            conversation.id,
            text,
            attachments,
            configOverride,
            options?.delivery
          );
          clearEditingQueuedPromptForConversation(conversation.id);
          return ok;
        }

        const ok = await promptConversation(
          conversation.id,
          text,
          attachments,
          undefined,
          options?.delivery
        );
        clearEditingQueuedPromptForConversation(conversation.id);
        return ok;
      } catch (error) {
        const message = error instanceof Error ? error.message : "Failed to start the agent turn.";
        if (conversationIdForError) {
          void syncConversationSnapshot(conversationIdForError).catch(() => undefined);
          pushNotification({
            kind: WORKBENCH_NOTIFICATION_KIND.editorNotice,
            severity: "error",
            title: "Agent",
            message,
            autoDismissMs: 8000,
            compact: true,
          });
          return false;
        }
        pushNotification({
          kind: WORKBENCH_NOTIFICATION_KIND.editorNotice,
          severity: "error",
          title: "Agent",
          message,
          autoDismissMs: 8000,
          compact: true,
        });
        return false;
      }
    },
    [
      activeConversation,
      applyHandoffServerResult,
      clearEditingQueuedPromptForConversation,
      clearPendingConfigForConversation,
      conversationsById,
      createConversationAndOpen,
      mergeConversationSnapshot,
      pendingConfigByConversationId,
      promptConversation,
      pushNotification,
      resolveComposerStateForDraft,
      setTabs,
      syncConversationSnapshot,
      tabs,
      upsertConversation,
    ]
  );

  const handleRequestHandoff = useCallback(
    async (targetBackendId: AgentBackendId) => {
      if (!activeConversation) return;
      await handoffConversationInPlace(activeConversation.id, targetBackendId);
    },
    [activeConversation, handoffConversationInPlace]
  );

  const handleStartRedoMessage = useCallback(
    (message: ChatMessage) => {
      if (!activeConversation) {
        return;
      }
      if (
        activeConversation.status === "running" ||
        activeConversation.status === "awaiting_permission"
      ) {
        pushNotification({
          kind: WORKBENCH_NOTIFICATION_KIND.editorNotice,
          severity: "warning",
          title: "Agent busy",
          message: "Wait for the current reply or cancel before redoing a message.",
          autoDismissMs: 8000,
          compact: true,
        });
        return;
      }
      const state = resolveComposerStateForDraft(activeConversation.id);
      setRedoMessageDraft({
        messageId: message.id,
        content: message.rawContent ?? message.content ?? "",
        attachments: message.attachments?.map((attachment) => ({ ...attachment })),
        backendId: state.backendId,
        mode: state.mode,
        model: state.model,
      });
    },
    [activeConversation, pushNotification, resolveComposerStateForDraft]
  );

  const submitRedoMessageDraft = useCallback(
    async (text: string, attachments?: ImageAttachment[]) => {
      if (!activeConversation || !redoMessageDraft) {
        return false;
      }
      if (
        activeConversation.status === "running" ||
        activeConversation.status === "awaiting_permission"
      ) {
        pushNotification({
          kind: WORKBENCH_NOTIFICATION_KIND.editorNotice,
          severity: "warning",
          title: "Agent busy",
          message: "Wait for the current reply or cancel before redoing a message.",
          autoDismissMs: 8000,
          compact: true,
        });
        return false;
      }

      try {
        const result = await prepareRedoAgentConversation(activeConversation.id, {
          beforeMessageId: redoMessageDraft.messageId,
        });
        const nextConversationId = activeConversation.id;
        let nextConversation = result.conversation;

        if (redoMessageDraft.backendId !== nextConversation.config.backendId) {
          nextConversation = {
            ...nextConversation,
            config: {
              ...nextConversation.config,
              backendId: redoMessageDraft.backendId,
            },
          };
        }

        const modelId = redoMessageDraft.model.modelValue ?? redoMessageDraft.model.id;
        const configPatch: Record<string, unknown> = {};
        if (redoMessageDraft.backendId !== result.conversation.config.backendId) {
          configPatch.backendId = redoMessageDraft.backendId;
        }
        if (redoMessageDraft.mode !== nextConversation.config.mode) {
          configPatch.mode = redoMessageDraft.mode;
        }
        if (
          modelId !== nextConversation.config.modelId ||
          redoMessageDraft.model.name !== nextConversation.config.modelName
        ) {
          configPatch.modelId = modelId;
          configPatch.modelName = redoMessageDraft.model.name;
          if (redoMessageDraft.model.configSelections?.length) {
            configPatch.setConfigOptions = redoMessageDraft.model.configSelections;
          }
        }
        if (Object.keys(configPatch).length > 0) {
          const updated = await updateAgentConversationConfig(
            nextConversationId,
            configPatch
          );
          nextConversation = updated.conversation;
          upsertConversation(updated.conversation);
        }

        const snapshot = await fetchAgentConversationSnapshot(nextConversationId);
        mergeConversationSnapshot(snapshot.snapshot);
        setRedoMessageDraft(null);
        return await promptConversation(nextConversationId, text, attachments);
      } catch (error) {
        const message = error instanceof Error ? error.message : "Failed to redo message.";
        pushNotification({
          kind: WORKBENCH_NOTIFICATION_KIND.editorNotice,
          severity: "error",
          title: "Redo Failed",
          message,
          autoDismissMs: 8000,
          compact: true,
        });
        return false;
      }
    },
    [
      activeConversation,
      mergeConversationSnapshot,
      promptConversation,
      pushNotification,
      redoMessageDraft,
      upsertConversation,
    ]
  );

  const renderRedoMessageEditor = useCallback(
    (message: ChatMessage) => {
      if (!redoMessageDraft || redoMessageDraft.messageId !== message.id) {
        return null;
      }
      const targetBackend =
        pickAvailableBackend(backends, redoMessageDraft.backendId) ??
        pickAvailableBackend(backends, activeConversation?.config.backendId);
      const redoModels = targetBackend
        ? buildDraftModelOptionsForBackend(targetBackend, modelVisibility)
        : models;
      const redoModeOptions = targetBackend
        ? buildDraftModeOptionsForBackend(targetBackend)
        : modeOptions;
      const redoMode = resolveCanonicalModeId(
        String(redoMessageDraft.mode),
        redoModeOptions
      ) as EditorMode;
      const redoModeLocked = isOrchestrationModeLocked(redoMode, true);

      return (
        <div ref={redoEditorRef} className="flex min-h-[180px] flex-col">
          <ChatComposer
            key={`redo-${redoMessageDraft.messageId}`}
            mode={redoMode}
            onModeChange={(next) => {
              if (isOrchestrationModeLocked(redoMode, true)) {
                return;
              }
              setRedoMessageDraft((current) =>
                current && current.messageId === redoMessageDraft.messageId
                  ? { ...current, mode: next }
                  : current
              );
            }}
            model={redoMessageDraft.model}
            onModelChange={(next) =>
              setRedoMessageDraft((current) =>
                current && current.messageId === redoMessageDraft.messageId
                  ? { ...current, model: next }
                  : current
              )
            }
            backendId={targetBackend?.id ?? redoMessageDraft.backendId}
            backends={backends}
            onBackendChange={(nextBackendId) => {
              const nextBackend = pickAvailableBackend(backends, nextBackendId);
              const nextModel = nextBackend
                ? resolveDraftModelForBackend(nextBackend)
                : redoMessageDraft.model;
              const nextMode = nextBackend
                ? buildDraftModeOptionsForBackend(nextBackend)[0]?.id ?? redoMessageDraft.mode
                : redoMessageDraft.mode;
              setRedoMessageDraft((current) =>
                current && current.messageId === redoMessageDraft.messageId
                  ? {
                      ...current,
                      backendId: nextBackend?.id ?? nextBackendId,
                      mode: nextMode as EditorMode,
                      model: nextModel,
                    }
                  : current
              );
            }}
            models={redoModels.length > 0 ? redoModels : [redoMessageDraft.model]}
            modeOptions={redoModeOptions}
            value={redoMessageDraft.content}
            onValueChange={(next) =>
              setRedoMessageDraft((current) =>
                current && current.messageId === redoMessageDraft.messageId
                  ? { ...current, content: next }
                  : current
              )
            }
            busy={false}
            configLocked={false}
            modeLocked={redoModeLocked}
            onSubmit={(text, attachments) => submitRedoMessageDraft(text, attachments)}
            layout="empty-top"
            variant="expanded"
            shellMxClass=""
            draftAttachments={redoMessageDraft.attachments}
            onDraftAttachmentsChange={(next) =>
              setRedoMessageDraft((current) =>
                current && current.messageId === redoMessageDraft.messageId
                  ? { ...current, attachments: next }
                  : current
              )
            }
            userMessageHistory={composerUserMessageHistory}
            hasMoreOlderUserMessageHistory={panelHistoryCursor.hasOlder}
            onRequestOlderUserMessageHistory={
              activeTabId && activeTabId !== "__empty__"
                ? () => loadOlderConversationHistory(activeTabId)
                : undefined
            }
          />
        </div>
      );
    },
    [
      activeConversation?.config.backendId,
      activeTabId,
      backends,
      composerUserMessageHistory,
      loadOlderConversationHistory,
      modeOptions,
      modelVisibility,
      models,
      panelHistoryCursor.hasOlder,
      redoMessageDraft,
      submitRedoMessageDraft,
    ]
  );

  const handleForkMessage = useCallback(
    async (messageId: string) => {
      if (!activeConversation) return;
      if (
        activeConversation.status === "running" ||
        activeConversation.status === "awaiting_permission"
      ) {
        pushNotification({
          kind: WORKBENCH_NOTIFICATION_KIND.editorNotice,
          severity: "warning",
          title: "Agent busy",
          message: "Wait for the current reply or cancel before forking.",
          autoDismissMs: 8000,
          compact: true,
        });
        return;
      }
      try {
        const result = await forkAgentConversation(activeConversation.id, {
          upToMessageId: messageId,
        });
        const nextConversations = await refreshConversations();
        const newConv = nextConversations.find(
          (c) => c.id === result.conversation.id
        );
        if (!newConv) {
          pushNotification({
            kind: WORKBENCH_NOTIFICATION_KIND.editorNotice,
            severity: "error",
            title: "Fork Failed",
            message: "Server did not return the new conversation in the workspace list.",
            compact: true,
          });
          return;
        }
        const snap = await fetchAgentConversationSnapshot(result.conversation.id);
        mergeConversationSnapshot(snap.snapshot);
        setTabs((current) => {
          const existingTab = current.find((tab) => tab.id === newConv.id);
          if (existingTab) {
            return current.map((tab) => ({ ...tab, active: tab.id === newConv.id }));
          }
          return [
            ...current.map((tab) => ({ ...tab, active: false })),
            { id: newConv.id, title: newConv.title, active: true },
          ];
        });
        unhideConversationIds([newConv.id]);
      } catch (error) {
        const message =
          error instanceof Error ? error.message : "Failed to fork conversation.";
        pushNotification({
          kind: WORKBENCH_NOTIFICATION_KIND.editorNotice,
          severity: "error",
          title: "Fork Failed",
          message,
          autoDismissMs: 8000,
          compact: true,
        });
      }
    },
    [
      activeConversation,
      mergeConversationSnapshot,
      pushNotification,
      refreshConversations,
      setTabs,
      unhideConversationIds,
    ]
  );

const cancelPromptForDraft = useCallback(
    async (draftId: string) => {
      const conversation = conversationsById[draftId];
      if (!conversation) {
        return;
      }
      try {
        await cancelConversationFromHook(conversation.id);
      } catch {
        void syncConversationSnapshot(conversation.id).catch(() => undefined);
      }
    },
    [cancelConversationFromHook, conversationsById, syncConversationSnapshot]
  );

  const pausePromptForDraft = useCallback(
    async (draftId: string) => {
      const conversation = conversationsById[draftId];
      if (!conversation) {
        return;
      }
      try {
        await pauseConversationFromHook(conversation.id);
      } catch {
        void syncConversationSnapshot(conversation.id).catch(() => undefined);
      }
    },
    [conversationsById, pauseConversationFromHook, syncConversationSnapshot]
  );

  const resumePromptForDraft = useCallback(
    async (draftId: string) => {
      const conversation = conversationsById[draftId];
      if (!conversation) {
        return;
      }
      try {
        await resumeConversationFromHook(conversation.id);
      } catch {
        void syncConversationSnapshot(conversation.id).catch(() => undefined);
      }
    },
    [conversationsById, resumeConversationFromHook, syncConversationSnapshot]
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
      onSubmit: (
        text: string,
        attachments?: ImageAttachment[],
        options?: { delivery?: "normal" | "steer" }
      ) => {
        void submitPromptForDraft(expandedComposerDraftId, text, attachments, options);
      },
      onCancel: () => cancelPromptForDraft(expandedComposerDraftId),
      onPause: () => pausePromptForDraft(expandedComposerDraftId),
      onResume: () => resumePromptForDraft(expandedComposerDraftId),
      conversationStatus: state.conversation?.status,
      busy: state.busy,
      configLocked: false,
      modeLocked: isOrchestrationModeLocked(
        state.mode,
        isPersistedConversationTabId(expandedComposerDraftId)
      ),
      onRequestHandoff:
        state.conversation && isPersistedConversationTabId(expandedComposerDraftId)
          ? handleRequestHandoff
          : undefined,
      userMessageHistory: composerUserMessageHistory,
      hasMoreOlderUserMessageHistory: panelHistoryCursor.hasOlder,
      onRequestOlderUserMessageHistory:
        activeTabId && activeTabId !== "__empty__"
          ? () => loadOlderConversationHistory(activeTabId)
          : undefined,
    };
  }, [
    backends,
    activeTabId,
    cancelPromptForDraft,
    pausePromptForDraft,
    resumePromptForDraft,
    composerDrafts,
    composerUserMessageHistory,
    expandedComposerDraftId,
    handleRequestHandoff,
    loadOlderConversationHistory,
    panelHistoryCursor.hasOlder,
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
      modeLocked={modeLocked}
      onSubmit={(text, attachments, options) => {
        void submitPromptForDraft(composerDraftId, text, attachments, options);
      }}
      onCancel={() => cancelPromptForDraft(composerDraftId)}
      onPause={() => pausePromptForDraft(composerDraftId)}
      onResume={() => resumePromptForDraft(composerDraftId)}
      conversationStatus={activeConversation?.status}
      onRequestHandoff={
        activeConversation && isPersistedConversationTabId(composerDraftId)
          ? handleRequestHandoff
          : undefined
      }
      layout={isEmptyThread ? "empty-top" : "docked-bottom"}
            shellMxClass=""
            draftAttachments={composerDraftAttachments}
onDraftAttachmentsChange={(next) =>
                upsertComposerDraft(composerDraftId, {
                  title: composerDraftTitle,
                  attachments: next,
                })
              }
              draftCaptures={composerDrafts[composerDraftId]?.captures}
              onDraftCapturesChange={(next) =>
                upsertComposerDraft(composerDraftId, {
                  title: composerDraftTitle,
                  captures: next,
                })
              }
              userMessageHistory={composerUserMessageHistory}
              hasMoreOlderUserMessageHistory={panelHistoryCursor.hasOlder}
              onRequestOlderUserMessageHistory={
                activeTabId && activeTabId !== "__empty__"
                  ? () => loadOlderConversationHistory(activeTabId)
                  : undefined
              }
            />
  );

  const activeQueueConversationId = activeConversation?.id;
  const queueDockCollapsed = Boolean(
    activeQueueConversationId &&
      workspaceSession.chat.composerQueueDockCollapsedByConversationId?.[activeQueueConversationId]
  );
  const onQueueDockCollapsedChange = useCallback(
    (nextCollapsed: boolean) => {
      if (!activeQueueConversationId) {
        return;
      }
      updateWorkspaceSession((current) => {
        const prev = current.chat.composerQueueDockCollapsedByConversationId ?? {};
        const m = { ...prev };
        if (nextCollapsed) {
          m[activeQueueConversationId] = true;
        } else {
          delete m[activeQueueConversationId];
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
    [activeQueueConversationId, updateWorkspaceSession]
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
    <div className="flex h-full min-h-0 w-full flex-col overflow-hidden bg-[var(--bg-panel)] @container">
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
          padTrailingForWindowChrome={padTabsForWindowChrome}
          electronTrailingChromeMargin={electronChatTrailingChrome}
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
                  onEdit={editQueuedPromptForActiveChat}
                  conversationConfig={activeConversation?.config}
                  backendLabels={Object.fromEntries(
                    backends.map((b) => [b.id, b.label ?? b.id])
                  )}
                  collapsed={queueDockCollapsed}
                  onCollapsedChange={onQueueDockCollapsedChange}
                />
              ) : null}
              <AgentCompletionErrorDock dock={completionErrorDock} />
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
          composerDraftId={composerDraftId}
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
          onForkMessage={handleForkMessage}
          onRedoMessage={handleStartRedoMessage}
          renderUserMessageEditor={renderRedoMessageEditor}
          editingUserMessageId={redoMessageDraft?.messageId ?? null}
          initialScrollTop={
            restoredChatScroll.mode === "restore" &&
            restoredChatScroll.scrollTop !== undefined
              ? restoredChatScroll.scrollTop
              : undefined
          }
          initialScrollAnchor={
            restoredChatScroll.mode === "restore"
              ? restoredChatScroll.anchor
              : undefined
          }
          onScrollTopSettled={handleScrollTopSettled}
          bottomDockVisible={!composerHiddenForExpanded}
        />
          {!composerHiddenForExpanded ? (
            <div className="pointer-events-none absolute inset-x-0 bottom-0 z-30">
              <div className="pointer-events-auto chat-bottom-dock">
                {recentChatsSection ? (
                  <div className="px-[10px] pt-[8px]">{recentChatsSection}</div>
                ) : null}
                <AgentCompletionErrorDock dock={completionErrorDock} />
                {dockedAsk ? (
                  <div className="pt-[8px]">
                    <AskQuestionCard
                      steps={dockedAsk.steps}
                      dockAboveComposer
                      submitting={submittingQuestion}
                      onSubmit={async (answer) => {
                        if (!activeConversation?.id) {
                          return;
                        }
                        setSubmittingQuestion(true);
                        try {
                          await answerQuestionForConversation(
                            activeConversation.id,
                            dockedAsk.questionId,
                            answer
                          );
                        } finally {
                          setSubmittingQuestion(false);
                        }
                      }}
                    />
                  </div>
                ) : null}
                {activeQueuedPrompts.length > 0 ? (
                  <div className="px-[10px] pt-[8px]">
<ComposerQueueDock
                      items={activeQueuedPrompts}
                      onDelete={removeQueuedPromptForActiveChat}
                      onUnqueue={unqueuePromptToComposer}
                      onEdit={editQueuedPromptForActiveChat}
                      conversationConfig={activeConversation?.config}
                      backendLabels={Object.fromEntries(
                        backends.map((b) => [b.id, b.label ?? b.id])
                      )}
                      collapsed={queueDockCollapsed}
                      onCollapsedChange={onQueueDockCollapsedChange}
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
