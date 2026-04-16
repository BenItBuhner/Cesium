"use client";

import {
  useReducer,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  type DragEvent,
  type MouseEvent,
} from "react";
import { Group, Panel, Separator } from "react-resizable-panels";
import { EditorTabs } from "./EditorTabs";
import { CodeEditor } from "./CodeEditor";
import { Terminal } from "./Terminal";
import { SimpleMarkdownPreview } from "./SimpleMarkdownPreview";
import { FilePreview } from "./FilePreview";
import { AgentTranscriptView } from "./AgentTranscriptView";
import { AgentConversationView } from "./AgentConversationView";
import { BrowserTab } from "./BrowserTab";
import { ExpandedComposerView } from "./ExpandedComposerView";
import { useEditorBridgeRef } from "@/components/ide/EditorBridgeContext";
import { useWorkbenchContextMenu } from "@/components/ide/WorkbenchContextMenuProvider";
import type { WorkbenchMenuItem } from "@/components/ide/workbench-context-menu-types";
import {
  useOpenInEditor,
  type OpenAgentConversationPayload,
  type OpenComposerDraftPayload,
  type OpenTranscriptPayload,
} from "./OpenInEditorContext";
import { CHAT_TAB_DND_MIME, parseChatTabDragPayload } from "@/lib/chat-tab-dnd";
import type { ExplorerOpenRequest } from "@/lib/types";
import type { AgentTabIndicatorByConversationId, EditorTab } from "@/lib/types";
import {
  TAB_GROUP_COLOR_PRESET_IDS,
  editorPanelReducer,
  resolveTabGroupColorHex,
  type EditorPanelAction,
  type EditorGroup,
  TAB_DND_MIME,
  parseTabDragPayload,
} from "./editor-panel-state";
import {
  fetchWorkspaceWindowSession,
  saveWorkspaceWindowSession,
  createTerminal,
  deleteTerminal,
  readFile,
  writeFile,
  type FileReadResult,
} from "@/lib/server-api";
import { useAgentConversations } from "@/components/chat/AgentConversationsContext";
import { useViewport } from "@/hooks/useViewport";
import { useWorkspace } from "@/contexts/WorkspaceContext";
import { useWorkbench } from "@/components/ide/WorkbenchContext";
import { useUserPreferences } from "@/components/preferences/UserPreferencesProvider";
import { useWorkbenchNotifications } from "@/components/notifications/WorkbenchNotificationProvider";
import { WORKBENCH_NOTIFICATION_KIND } from "@/components/notifications/workbench-notification-types";
import {
  createPersistableWorkspaceSession,
  type EditorSessionState,
  type EditorSplitOrientation,
} from "@/lib/workspace-session";
import {
  buildWorkspaceWindowUrl,
  normalizeWorkspaceWindowSession,
} from "@/lib/workspace-windows";

function fileContentLoadAction(
  tabId: string,
  result: FileReadResult
): Extract<EditorPanelAction, { type: "LOAD_FILE_CONTENT" }> {
  const total = result.totalSize ?? result.size;
  const readOff = result.readByteOffset ?? 0;
  const readLen = result.readByteLength ?? 0;
  const loadedThrough =
    result.truncated && readLen > 0 ? readOff + readLen : total;
  return {
    type: "LOAD_FILE_CONTENT",
    tabId,
    content: result.content,
    language: result.language,
    fileKind: result.fileKind,
    mimeType: result.mimeType,
    previewPath: result.previewPath,
    fileContentTruncated: Boolean(result.truncated),
    fileTotalBytes: total,
    fileLoadedThroughByte: loadedThrough,
  };
}

const EDITOR_SPLIT_PANEL_IDS = {
  left: "editor-split-left",
  right: "editor-split-right",
} as const;

const DEFAULT_EDITOR_SPLIT_LAYOUT: Record<string, number> = {
  [EDITOR_SPLIT_PANEL_IDS.left]: 50,
  [EDITOR_SPLIT_PANEL_IDS.right]: 50,
};

function tabCanSave(tab: EditorTab): boolean {
  return Boolean(tab.filePath && tab.fileKind && tab.fileKind !== "image");
}

function isUnknownTerminalError(error: unknown): boolean {
  return error instanceof Error && error.message.includes("Unknown terminal");
}

function normalizeSplitOrientation(value: unknown): EditorSplitOrientation {
  return value === "vertical" ? "vertical" : "horizontal";
}

function normalizeSplitLayout(value: unknown): Record<string, number> | null {
  if (!value || typeof value !== "object") {
    return null;
  }
  const entries = Object.entries(value).filter(
    ([panelId, size]) =>
      typeof panelId === "string" &&
      panelId.length > 0 &&
      typeof size === "number" &&
      Number.isFinite(size)
  );
  return entries.length > 0 ? Object.fromEntries(entries) : null;
}

function EditorSplitResizeHandle({
  orientation,
}: {
  orientation: EditorSplitOrientation;
}) {
  const className =
    orientation === "horizontal"
      ? "group relative w-[1px] bg-[var(--border-subtle)] transition-colors hover:bg-[var(--accent)] active:bg-[var(--accent)]"
      : "group relative h-[1px] w-full bg-[var(--border-subtle)] transition-colors hover:bg-[var(--accent)] active:bg-[var(--accent)]";
  const hitTargetClassName =
    orientation === "horizontal"
      ? "absolute inset-y-0 -left-1 -right-1 z-10"
      : "absolute inset-x-0 -top-1 -bottom-1 z-10";

  return (
    <Separator className={className}>
      <div className={hitTargetClassName} />
    </Separator>
  );
}

function createEditorStateFromSession(session: {
  split: boolean;
  splitOrientation?: EditorSplitOrientation;
  splitLayout?: Record<string, number> | null;
  focusedGroup: EditorGroup;
  leftTabs: EditorTab[];
  rightTabs: EditorTab[];
  leftActiveId: string | null;
  rightActiveId: string | null;
  leftTabGroups?: EditorSessionState["leftTabGroups"];
  rightTabGroups?: EditorSessionState["rightTabGroups"];
  leftStripItems?: EditorSessionState["leftStripItems"];
  rightStripItems?: EditorSessionState["rightStripItems"];
}) {
  const normalizeTranscriptTab = (tab: EditorTab): EditorTab => {
    if (tab.transcriptSessionId || !tab.transcriptMessages?.length) {
      return tab;
    }
    const inferred = tab.transcriptMessages
      .map((message) => message.id.match(/(ses_[A-Za-z0-9]+)/)?.[1])
      .find((value): value is string => Boolean(value));
    return inferred ? { ...tab, transcriptSessionId: inferred } : tab;
  };
  const leftTabs = session.leftTabs.map(normalizeTranscriptTab);
  const rightTabs = session.rightTabs.map(normalizeTranscriptTab);
  const leftTabGroups = session.leftTabGroups ?? {};
  const rightTabGroups = session.rightTabGroups ?? {};
  let leftStripItems = session.leftStripItems ?? [];
  let rightStripItems = session.rightStripItems ?? [];
  if (
    leftStripItems.length === 0 &&
    leftTabs.length > 0 &&
    Object.keys(leftTabGroups).length === 0
  ) {
    leftStripItems = leftTabs.map((t) => ({ type: "tab" as const, tabId: t.id }));
  }
  if (
    rightStripItems.length === 0 &&
    rightTabs.length > 0 &&
    Object.keys(rightTabGroups).length === 0
  ) {
    rightStripItems = rightTabs.map((t) => ({ type: "tab" as const, tabId: t.id }));
  }
  return {
    split: session.split,
    splitOrientation: normalizeSplitOrientation(session.splitOrientation),
    splitLayout: normalizeSplitLayout(session.splitLayout),
    focusedGroup: session.focusedGroup,
    leftTabs,
    rightTabs,
    leftActiveId: session.leftActiveId,
    rightActiveId: session.rightActiveId,
    leftTabGroups,
    rightTabGroups,
    leftStripItems,
    rightStripItems,
  };
}

function areViewStatesEqual(a: unknown, b: unknown): boolean {
  if (Object.is(a, b)) {
    return true;
  }
  try {
    return JSON.stringify(a) === JSON.stringify(b);
  } catch {
    return false;
  }
}

interface EditorPanelProps {
  session?: EditorSessionState;
  onSessionChange?: (
    updater: (current: EditorSessionState) => EditorSessionState
  ) => void;
  expandedComposerDraftId?: string | null;
  setExpandedComposerDraft?: (draftId: string | null) => void;
  reserveTrailingPaneCloseSlot?: boolean;
}

export function EditorPanel({
  session: sessionOverride,
  onSessionChange,
  expandedComposerDraftId: expandedComposerDraftIdOverride,
  setExpandedComposerDraft: setExpandedComposerDraftOverride,
  reserveTrailingPaneCloseSlot = false,
}: EditorPanelProps = {}) {
  const {
    registerOpenTranscript,
    registerOpenComposerDraft,
    registerOpenAgentConversation,
    registerOpenExplorerFile,
    composerDrafts,
    upsertComposerDraft,
    setActiveExplorerPath,
    expandedComposerDraftId: workspaceExpandedComposerDraftId,
    setExpandedComposerDraft: setWorkspaceExpandedComposerDraft,
  } = useOpenInEditor();
  const {
    activeWindowId,
    activeWorkspaceId,
    createWorkspaceWindow,
    fsResyncToken,
    lastFileChange,
    refreshTerminals,
    terminals,
    workspaceInfo,
    workspaceWindows,
    workspaceSession,
    updateWorkspaceSession,
  } = useWorkspace();
  const { isMobile } = useViewport();
  const { primarySidebarVisible } = useWorkbench();
  const { experimentalIpadWindowedTabInset } = useUserPreferences();
  const { openAt } = useWorkbenchContextMenu();
  const { pushNotification, dismiss, dismissByKind } = useWorkbenchNotifications();
  const persistedSession = sessionOverride ?? workspaceSession.editor;
  const expandedComposerDraftId =
    expandedComposerDraftIdOverride ?? workspaceExpandedComposerDraftId;
  const setExpandedComposerDraft =
    setExpandedComposerDraftOverride ?? setWorkspaceExpandedComposerDraft;
  const hasExpandedComposerOverrides =
    expandedComposerDraftIdOverride !== undefined ||
    setExpandedComposerDraftOverride !== undefined;
  const updateEditorSession = useCallback(
    (updater: (current: EditorSessionState) => EditorSessionState) => {
      if (onSessionChange) {
        onSessionChange(updater);
        return;
      }
      updateWorkspaceSession((current) => {
        const nextEditor = updater(current.editor);
        if (nextEditor === current.editor) {
          return current;
        }
        return {
          ...current,
          editor: nextEditor,
        };
      });
    },
    [onSessionChange, updateWorkspaceSession]
  );
  const liveTabContentRef = useRef<Map<string, string>>(new Map());
  const viewStateByTabIdRef = useRef<Record<string, unknown>>(
    persistedSession.viewStateByTabId
  );
  const handledDiskChangeAtRef = useRef<number | null>(null);
  const handledFsResyncTokenRef = useRef<number | null>(null);
  const [state, dispatch] = useReducer(
    editorPanelReducer,
    persistedSession,
    createEditorStateFromSession
  );

  const { conversationsById } = useAgentConversations();
  const agentTabIndicators = useMemo(() => {
    const unread = workspaceSession.chat.unreadChatCompletionByConversationId ?? {};
    const m: AgentTabIndicatorByConversationId = {};
    for (const tab of [...state.leftTabs, ...state.rightTabs]) {
      if (!tab.conversationId) continue;
      const c = conversationsById[tab.conversationId];
      if (!c) continue;
      m[tab.conversationId] = {
        needsAttention: c.status === "awaiting_permission",
        running: c.status === "running",
        unreadCompletion:
          Boolean(unread[tab.conversationId]) && c.status === "idle",
      };
    }
    return m;
  }, [
    state.leftTabs,
    state.rightTabs,
    conversationsById,
    workspaceSession.chat.unreadChatCompletionByConversationId,
  ]);

  const stateRef = useRef(state);
  const bridgeRef = useEditorBridgeRef();

  useEffect(() => {
    stateRef.current = state;
  }, [state]);

  useEffect(() => {
    updateEditorSession(() => ({
      ...state,
      viewStateByTabId: viewStateByTabIdRef.current,
    }));
  }, [state, updateEditorSession]);

  const flashNotice = useCallback(
    (message: string, severity: "info" | "error" = "info") => {
      pushNotification({
        kind: WORKBENCH_NOTIFICATION_KIND.editorNotice,
        severity,
        title: severity === "error" ? "Editor" : "Notice",
        message,
        persistent: false,
        autoDismissMs: severity === "error" ? 10_000 : 4000,
      });
    },
    [pushNotification]
  );

  const findTab = useCallback((tabId: string) => {
    const snapshot = stateRef.current;
    return (
      snapshot.leftTabs.find((tab) => tab.id === tabId) ??
      snapshot.rightTabs.find((tab) => tab.id === tabId) ??
      null
    );
  }, []);

  const loadExplorerFile = useCallback(
    async (payload: ExplorerOpenRequest) => {
      dispatch({ type: "OPEN_EXPLORER_FILE", ...payload });
      if (payload.content != null) {
        return;
      }

      const tabId = `explorer:${payload.path}`;
      const existing = findTab(tabId);
      if (existing && !existing.loading && existing.savedContent != null) {
        return;
      }

      try {
        const result = await readFile(payload.path);
        dispatch(fileContentLoadAction(tabId, result));
      } catch (error) {
        flashNotice(
          error instanceof Error
            ? `Failed to open ${payload.name}: ${error.message}`
            : `Failed to open ${payload.name}.`
        );
      }
    },
    [findTab, flashNotice]
  );

  const saveTab = useCallback(
    async (
      tabId: string,
      nextContent?: string,
      options?: { quiet?: boolean }
    ) => {
      const tab = findTab(tabId);
      if (!tab?.filePath || tab.fileKind === "image") {
        return false;
      }

      const contentToSave =
        nextContent ??
        liveTabContentRef.current.get(tabId) ??
        tab.content;
      try {
        await writeFile(tab.filePath, contentToSave);
        liveTabContentRef.current.set(tabId, contentToSave);
        dispatch({ type: "MARK_SAVED", tabId, content: contentToSave });
        if (!options?.quiet) {
          pushNotification({
            kind: WORKBENCH_NOTIFICATION_KIND.editorNotice,
            severity: "info",
            title: "Saved",
            message: tab.name,
            persistent: false,
            autoDismissMs: 4000,
          });
        }
        return true;
      } catch (error) {
        flashNotice(
          error instanceof Error
            ? `Failed to save ${tab.name}: ${error.message}`
            : `Failed to save ${tab.name}.`,
          "error"
        );
        return false;
      }
    },
    [findTab, flashNotice, pushNotification]
  );

  const saveAllTabs = useCallback(async () => {
    const tabs = [
      ...stateRef.current.leftTabs,
      ...stateRef.current.rightTabs,
    ].filter(tabCanSave);
    const dirtyTabs = tabs.filter((tab) => tab.dirty);
    if (dirtyTabs.length === 0) {
      return { savedCount: 0, attemptedCount: 0 };
    }

    let savedCount = 0;
    for (const tab of dirtyTabs) {
      const ok = await saveTab(tab.id, undefined, { quiet: true });
      if (!ok) {
        break;
      }
      savedCount += 1;
    }
    return { savedCount, attemptedCount: dirtyTabs.length };
  }, [saveTab]);

  const openTerminalTab = useCallback(async () => {
    try {
      const terminal = await createTerminal();
      dispatch({
        type: "OPEN_TERMINAL_TAB",
        terminalId: terminal.id,
        name: `Terminal ${stateRef.current.leftTabs.filter((tab) => tab.terminalId).length + stateRef.current.rightTabs.filter((tab) => tab.terminalId).length + 1}`,
      });
      await refreshTerminals();
    } catch (error) {
      flashNotice(
        error instanceof Error
          ? `Failed to create terminal: ${error.message}`
          : "Failed to create terminal."
      );
    }
  }, [flashNotice, refreshTerminals]);

  const openBrowserTab = useCallback((url: string) => {
    dispatch({ type: "OPEN_BROWSER_TAB", url });
  }, []);

  const closeTabs = useCallback(
    async (tabsToClose: EditorTab[], action: EditorPanelAction) => {
      const terminalIds = [
        ...new Set(
          tabsToClose
            .map((tab) => tab.terminalId)
            .filter((terminalId): terminalId is string => Boolean(terminalId))
        ),
      ];

      for (const terminalId of terminalIds) {
        try {
          await deleteTerminal(terminalId);
        } catch (error) {
          if (isUnknownTerminalError(error)) {
            continue;
          }

          flashNotice(
            error instanceof Error
              ? `Failed to close terminal: ${error.message}`
              : "Failed to close terminal.",
            "error"
          );
          return false;
        }
      }

      dispatch(action);

      if (terminalIds.length > 0) {
        void refreshTerminals().catch(() => {
          // Ignore background refresh failures after the close succeeds.
        });
      }

      return true;
    },
    [flashNotice, refreshTerminals]
  );

  useEffect(() => {
    const onTranscript = (payload: OpenTranscriptPayload) => {
      dispatch({
        type: "OPEN_TRANSCRIPT_TAB",
        title: payload.title,
        messages: payload.messages,
        sessionId: payload.sessionId,
      });
    };
    const onComposerDraft = (payload: OpenComposerDraftPayload) => {
      dispatch({
        type: "OPEN_COMPOSER_DRAFT_TAB",
        draftId: payload.draftId,
        title: payload.title,
        content: payload.content,
      });
    };
    const onAgentConversation = (payload: OpenAgentConversationPayload) => {
      dispatch({
        type: "OPEN_AGENT_CONVERSATION_TAB",
        conversationId: payload.conversationId,
        title: payload.title,
        group: payload.group,
      });
    };
    const onExplorer = (payload: ExplorerOpenRequest) => {
      void loadExplorerFile(payload);
    };
    registerOpenTranscript(onTranscript);
    registerOpenComposerDraft(onComposerDraft);
    registerOpenAgentConversation(onAgentConversation);
    registerOpenExplorerFile(onExplorer);
    return () => {
      registerOpenTranscript(null);
      registerOpenComposerDraft(null);
      registerOpenAgentConversation(null);
      registerOpenExplorerFile(null);
    };
  }, [
    loadExplorerFile,
    registerOpenAgentConversation,
    registerOpenComposerDraft,
    registerOpenTranscript,
    registerOpenExplorerFile,
  ]);

  useEffect(() => {
    const openDraftTabs = [...state.leftTabs, ...state.rightTabs].filter(
      (tab) => tab.composerDraftId
    );
    for (const tab of openDraftTabs) {
      const draftId = tab.composerDraftId;
      if (!draftId) {
        continue;
      }
      const draft = composerDrafts[draftId];
      if (!draft || tab.content === draft.content) {
        continue;
      }
      dispatch({ type: "UPDATE_TAB_CONTENT", tabId: tab.id, content: draft.content });
    }
  }, [composerDrafts, state.leftTabs, state.rightTabs]);

  useEffect(() => {
    if (!expandedComposerDraftId) {
      return;
    }
    const openDraftIds = new Set(
      [...state.leftTabs, ...state.rightTabs]
        .map((tab) => tab.composerDraftId)
        .filter((value): value is string => Boolean(value))
    );
    if (!openDraftIds.has(expandedComposerDraftId)) {
      setExpandedComposerDraft(null);
    }
  }, [
    expandedComposerDraftId,
    setExpandedComposerDraft,
    state.leftTabs,
    state.rightTabs,
  ]);

  useEffect(() => {
    if (!lastFileChange) return;
    if (handledDiskChangeAtRef.current === lastFileChange.at) {
      return;
    }
    handledDiskChangeAtRef.current = lastFileChange.at;

    const matchingTab = [
      ...stateRef.current.leftTabs,
      ...stateRef.current.rightTabs,
    ].find((tab) => tab.filePath === lastFileChange.path);
    if (!matchingTab) return;

    if (matchingTab.dirty) {
      dispatch({ type: "FILE_CHANGED_ON_DISK", path: lastFileChange.path });
      return;
    }

    void readFile(lastFileChange.path)
      .then((result) => {
        dispatch(fileContentLoadAction(matchingTab.id, result));
      })
      .catch(() => {
        // Keep the stale buffer visible if a background refresh fails.
      });
  }, [lastFileChange]);

  useEffect(() => {
    if (fsResyncToken === 0) return;
    if (handledFsResyncTokenRef.current === fsResyncToken) {
      return;
    }
    handledFsResyncTokenRef.current = fsResyncToken;

    const openTabs = [...stateRef.current.leftTabs, ...stateRef.current.rightTabs];
    for (const tab of openTabs) {
      if (!tab.filePath || tab.dirty || tab.fileKind === "image") {
        continue;
      }

      void readFile(tab.filePath)
        .then((result) => {
          dispatch(fileContentLoadAction(tab.id, result));
        })
        .catch(() => {
          // Keep the current buffer if a resync refresh fails.
        });
    }
  }, [fsResyncToken]);

  useEffect(() => {
    const activeId =
      state.focusedGroup === "left" ? state.leftActiveId : state.rightActiveId;
    const activeTab =
      state.focusedGroup === "left"
        ? state.leftTabs.find((tab) => tab.id === activeId) ?? null
        : state.rightTabs.find((tab) => tab.id === activeId) ?? null;

    setActiveExplorerPath(activeTab?.filePath ?? null);
  }, [
    setActiveExplorerPath,
    state.focusedGroup,
    state.leftActiveId,
    state.leftTabs,
    state.rightActiveId,
    state.rightTabs,
  ]);

  const focusEditorGroup = useCallback((group: EditorGroup) => {
    dispatch({ type: "FOCUS_EDITOR_GROUP", group });
  }, []);

  const selectTab = useCallback(
    (group: EditorGroup, id: string) => {
      const tab =
        group === "left"
          ? stateRef.current.leftTabs.find((t) => t.id === id)
          : stateRef.current.rightTabs.find((t) => t.id === id);
      dispatch({ type: "SELECT_TAB", group, id });
      const convId = tab?.conversationId;
      if (!convId) {
        return;
      }
      updateWorkspaceSession((current) => {
        const u = { ...(current.chat.unreadChatCompletionByConversationId ?? {}) };
        if (!u[convId]) {
          return current;
        }
        delete u[convId];
        return {
          ...current,
          chat: {
            ...current.chat,
            unreadChatCompletionByConversationId: u,
          },
        };
      });
    },
    [updateWorkspaceSession]
  );

  const requestCloseTab = useCallback(
    (group: EditorGroup, id: string) => {
      const tab = findTab(id);
      if (!tab) return;
      if (tab.composerDraftId && expandedComposerDraftId === tab.composerDraftId) {
        setExpandedComposerDraft(null);
      }
      if (!tab.dirty) {
        void closeTabs([tab], { type: "CLOSE_TAB", group, id });
        return;
      }

      const canSave = tabCanSave(tab);
      dismissByKind(WORKBENCH_NOTIFICATION_KIND.editorCloseConfirm);
      const nid = pushNotification({
        kind: WORKBENCH_NOTIFICATION_KIND.editorCloseConfirm,
        severity: "warning",
        title: "Save changes?",
        message: canSave
          ? `Your changes to "${tab.name}" will be lost if you close the tab without saving.`
          : `Close "${tab.name}" and discard unsaved changes?`,
        persistent: true,
        actions: [
          ...(canSave
            ? [
                {
                  id: "save",
                  label: "Save",
                  primary: true as const,
                  onClick: () => {
                    dismiss(nid);
                    void (async () => {
                      const ok = await saveTab(id, undefined, { quiet: true });
                      if (!ok) return;
                      await closeTabs([tab], { type: "CLOSE_TAB", group, id });
                    })();
                  },
                },
              ]
            : []),
          {
            id: "dont",
            label: "Don't Save",
            onClick: () => {
              dismiss(nid);
              void closeTabs([tab], { type: "CLOSE_TAB", group, id });
            },
          },
          {
            id: "cancel",
            label: "Cancel",
            onClick: () => dismiss(nid),
          },
        ],
      });
    },
    [
      dismiss,
      dismissByKind,
      expandedComposerDraftId,
      findTab,
      pushNotification,
      saveTab,
      setExpandedComposerDraft,
      closeTabs,
    ]
  );

  const requestCloseAllInGroup = useCallback(
    (group: EditorGroup) => {
      const tabs = group === "left" ? stateRef.current.leftTabs : stateRef.current.rightTabs;
      const dirty = tabs.filter((t) => t.dirty);
      if (dirty.length === 0) {
        void closeTabs(tabs, { type: "CLOSE_ALL_GROUP", group });
        return;
      }

      const savable = dirty.filter(tabCanSave);
      const canSaveAny = savable.length > 0;
      const label =
        dirty.length === 1
          ? `"${dirty[0]?.name ?? "file"}"`
          : `${dirty.length} files`;

      dismissByKind(WORKBENCH_NOTIFICATION_KIND.editorCloseConfirm);
      const nid = pushNotification({
        kind: WORKBENCH_NOTIFICATION_KIND.editorCloseConfirm,
        severity: "warning",
        title: "Save changes?",
        message: canSaveAny
          ? `Save changes to ${label} before closing all tabs in this group?`
          : "Close all tabs in this group and discard unsaved changes?",
        persistent: true,
        actions: [
          ...(canSaveAny
            ? [
                {
                  id: "save",
                  label: "Save All",
                  primary: true as const,
                  onClick: () => {
                    dismiss(nid);
                    void (async () => {
                      for (const t of savable) {
                        const ok = await saveTab(t.id, undefined, { quiet: true });
                        if (!ok) return;
                      }
                      await closeTabs(tabs, { type: "CLOSE_ALL_GROUP", group });
                    })();
                  },
                },
              ]
            : []),
          {
            id: "dont",
            label: "Don't Save",
            onClick: () => {
              dismiss(nid);
              void closeTabs(tabs, { type: "CLOSE_ALL_GROUP", group });
            },
          },
          {
            id: "cancel",
            label: "Cancel",
            onClick: () => dismiss(nid),
          },
        ],
      });
    },
    [dismiss, dismissByKind, pushNotification, saveTab, closeTabs]
  );

  const requestCloseOthersInGroup = useCallback(
    (group: EditorGroup) => {
      const tabs = group === "left" ? stateRef.current.leftTabs : stateRef.current.rightTabs;
      const activeId =
        group === "left" ? stateRef.current.leftActiveId : stateRef.current.rightActiveId;
      const toClose = tabs.filter((t) => t.id !== activeId);
      const dirty = toClose.filter((t) => t.dirty);
      if (dirty.length === 0) {
        void closeTabs(toClose, { type: "CLOSE_OTHERS_GROUP", group });
        return;
      }

      const savable = dirty.filter(tabCanSave);
      const canSaveAny = savable.length > 0;
      const label =
        dirty.length === 1
          ? `"${dirty[0]?.name ?? "file"}"`
          : `${dirty.length} files`;

      dismissByKind(WORKBENCH_NOTIFICATION_KIND.editorCloseConfirm);
      const nid = pushNotification({
        kind: WORKBENCH_NOTIFICATION_KIND.editorCloseConfirm,
        severity: "warning",
        title: "Save changes?",
        message: canSaveAny
          ? `Save changes to ${label} before closing the other tabs in this group?`
          : "Close other tabs and discard unsaved changes?",
        persistent: true,
        actions: [
          ...(canSaveAny
            ? [
                {
                  id: "save",
                  label: "Save All",
                  primary: true as const,
                  onClick: () => {
                    dismiss(nid);
                    void (async () => {
                      for (const t of savable) {
                        const ok = await saveTab(t.id, undefined, { quiet: true });
                        if (!ok) return;
                      }
                      await closeTabs(toClose, { type: "CLOSE_OTHERS_GROUP", group });
                    })();
                  },
                },
              ]
            : []),
          {
            id: "dont",
            label: "Don't Save",
            onClick: () => {
              dismiss(nid);
              void closeTabs(toClose, { type: "CLOSE_OTHERS_GROUP", group });
            },
          },
          {
            id: "cancel",
            label: "Cancel",
            onClick: () => dismiss(nid),
          },
        ],
      });
    },
    [dismiss, dismissByKind, pushNotification, saveTab, closeTabs]
  );

  useEffect(() => {
    bridgeRef.current = {
      dispatch,
      getState: () => stateRef.current,
      saveActiveTab: async () => {
        const snapshot = stateRef.current;
        const group = snapshot.focusedGroup;
        const activeId = group === "left" ? snapshot.leftActiveId : snapshot.rightActiveId;
        if (!activeId) {
          flashNotice("No active editor to save.", "info");
          return false;
        }
        return saveTab(activeId);
      },
      saveAllTabs,
      openTerminalTab,
      openBrowserTab,
      requestCloseTab,
      requestCloseAllInGroup,
      requestCloseOthersInGroup,
    };
    return () => {
      bridgeRef.current = null;
    };
  }, [
    bridgeRef,
    dispatch,
    flashNotice,
    openBrowserTab,
    openTerminalTab,
    requestCloseAllInGroup,
    requestCloseOthersInGroup,
    requestCloseTab,
    saveAllTabs,
    saveTab,
  ]);

  const moveTab = useCallback(
    (tabId: string, from: EditorGroup, to: EditorGroup) => {
      dispatch({ type: "MOVE_TAB", tabId, from, to });
    },
    []
  );

  const openConversationTab = useCallback(
    (conversationId: string, group?: EditorGroup) => {
      const title =
        stateRef.current.leftTabs.find((tab) => tab.conversationId === conversationId)?.name ??
        stateRef.current.rightTabs.find((tab) => tab.conversationId === conversationId)?.name ??
        workspaceSession.chat.tabs.find((tab) => tab.id === conversationId)?.title ??
        "Chat";
      dispatch({
        type: "OPEN_AGENT_CONVERSATION_TAB",
        conversationId,
        title,
        group,
      });
    },
    [workspaceSession.chat.tabs]
  );

  const setSplitMode = useCallback(
    (
      orientation: EditorSplitOrientation,
      focus: EditorGroup = stateRef.current.focusedGroup
    ) => {
      dispatch({ type: "ENABLE_SPLIT", orientation, focus });
    },
    []
  );

  const joinEditorGroups = useCallback(() => {
    dispatch({ type: "TOGGLE_SPLIT" });
  }, []);

  const moveTabToNewSplit = useCallback(
    (tabId: string, from: EditorGroup, orientation: EditorSplitOrientation) => {
      const targetGroup: EditorGroup = from === "left" ? "right" : "left";
      dispatch({ type: "ENABLE_SPLIT", orientation, focus: targetGroup });
      dispatch({ type: "MOVE_TAB", tabId, from, to: targetGroup });
    },
    []
  );

  const copyToClipboard = useCallback(
    async (text: string) => {
      try {
        await navigator.clipboard.writeText(text);
      } catch {
        flashNotice("Could not copy to clipboard.", "error");
      }
    },
    [flashNotice]
  );

  const openWorkspaceWindow = useCallback(
    (windowId: string) => {
      if (!activeWorkspaceId) {
        return;
      }
      const nextWindow = window.open(
        buildWorkspaceWindowUrl(window.location.origin, activeWorkspaceId, windowId),
        "_blank",
        "noopener,noreferrer"
      );
      if (!nextWindow) {
        flashNotice("Popup blocked while opening the workspace window.", "error");
        return;
      }
      nextWindow.focus();
    },
    [activeWorkspaceId, flashNotice]
  );

  const moveEditorTabToWorkspaceWindow = useCallback(
    async (group: EditorGroup, tabId: string, targetWindowId?: string) => {
      if (!activeWorkspaceId) {
        flashNotice("No active workspace.", "error");
        return;
      }
      const tab = findTab(tabId);
      if (!tab) {
        return;
      }

      let targetWindow =
        targetWindowId != null
          ? workspaceWindows.find((windowRecord) => windowRecord.id === targetWindowId) ?? null
          : null;
      if (!targetWindow) {
        targetWindow = await createWorkspaceWindow();
      }

      const targetSessionResult = await fetchWorkspaceWindowSession(
        activeWorkspaceId,
        targetWindow.id
      );
      const targetSession = normalizeWorkspaceWindowSession(targetSessionResult.session);
      const targetGroup: EditorGroup =
        targetSession.editor.split && targetSession.editor.focusedGroup === "right"
          ? "right"
          : "left";

      let nextLeftTabs = targetSession.editor.leftTabs.filter((candidate) => candidate.id !== tabId);
      let nextRightTabs = targetSession.editor.rightTabs.filter(
        (candidate) => candidate.id !== tabId
      );
      let nextLeftActiveId =
        nextLeftTabs.find((candidate) => candidate.id === targetSession.editor.leftActiveId)?.id ??
        nextLeftTabs[0]?.id ??
        null;
      let nextRightActiveId =
        nextRightTabs.find((candidate) => candidate.id === targetSession.editor.rightActiveId)?.id ??
        nextRightTabs[0]?.id ??
        null;

      if (targetGroup === "left") {
        nextLeftTabs = [...nextLeftTabs, tab];
        nextLeftActiveId = tabId;
      } else {
        nextRightTabs = [...nextRightTabs, tab];
        nextRightActiveId = tabId;
      }

      const viewState = viewStateByTabIdRef.current[tabId];
      const nextTargetSession = {
        ...targetSession,
        editor: {
          ...targetSession.editor,
          leftTabs: nextLeftTabs,
          rightTabs: nextRightTabs,
          leftActiveId: nextLeftActiveId,
          rightActiveId: nextRightActiveId,
          focusedGroup: targetGroup,
          viewStateByTabId:
            viewState === undefined
              ? targetSession.editor.viewStateByTabId
              : {
                  ...targetSession.editor.viewStateByTabId,
                  [tabId]: viewState,
                },
        },
      };

      await saveWorkspaceWindowSession(
        activeWorkspaceId,
        targetWindow.id,
        createPersistableWorkspaceSession(nextTargetSession)
      );

      if (tab.composerDraftId && expandedComposerDraftId === tab.composerDraftId) {
        setExpandedComposerDraft(null);
      }

      const nextViewStates = { ...viewStateByTabIdRef.current };
      delete nextViewStates[tabId];
      viewStateByTabIdRef.current = nextViewStates;
      dispatch({ type: "CLOSE_TAB", group, id: tabId });
      flashNotice(`Moved ${tab.name} to ${targetWindow.label}.`);
      openWorkspaceWindow(targetWindow.id);
    },
    [
      activeWorkspaceId,
      createWorkspaceWindow,
      expandedComposerDraftId,
      findTab,
      flashNotice,
      openWorkspaceWindow,
      setExpandedComposerDraft,
      workspaceWindows,
    ]
  );

  const handleEditorStripContextMenu = useCallback(
    (e: MouseEvent, group: EditorGroup) => {
      if (e.target !== e.currentTarget) return;
      e.preventDefault();
      const snapshot = stateRef.current;
      const tabs = group === "left" ? snapshot.leftTabs : snapshot.rightTabs;
      const hasTabs = tabs.length > 0;
      const splitItems: WorkbenchMenuItem[] = snapshot.split
        ? [
            {
              type: "item",
              id: "join-groups",
              label: "Join Editor Groups",
              onSelect: joinEditorGroups,
            },
            {
              type: "item",
              id: "split-right",
              label: "Use Side-by-side Layout",
              disabled: snapshot.splitOrientation === "horizontal",
              onSelect: () => setSplitMode("horizontal", group),
            },
            {
              type: "item",
              id: "split-down",
              label: "Use Stacked Layout",
              disabled: snapshot.splitOrientation === "vertical",
              onSelect: () => setSplitMode("vertical", group),
            },
          ]
        : [
            {
              type: "item",
              id: "split-right",
              label: "Split Editor Right",
              onSelect: () => setSplitMode("horizontal", group),
            },
            {
              type: "item",
              id: "split-down",
              label: "Split Editor Down",
              onSelect: () => setSplitMode("vertical", group),
            },
          ];
      openAt(e, [
        {
          type: "item",
          id: "close-all",
          label: "Close All",
          disabled: !hasTabs,
          onSelect: () => requestCloseAllInGroup(group),
        },
        {
          type: "item",
          id: "close-others",
          label: "Close Others",
          disabled: tabs.length <= 1,
          onSelect: () => requestCloseOthersInGroup(group),
        },
        { type: "sep" },
        ...splitItems,
      ]);
    },
    [
      joinEditorGroups,
      openAt,
      requestCloseAllInGroup,
      requestCloseOthersInGroup,
      setSplitMode,
    ]
  );

  const handleTabGroupContextMenu = useCallback(
    (e: MouseEvent, pane: EditorGroup, groupId: string) => {
      e.preventDefault();
      const snapshot = stateRef.current;
      const groupsKey = pane === "left" ? "leftTabGroups" : "rightTabGroups";
      const g = snapshot[groupsKey][groupId];
      if (!g) return;

      const colorItems: WorkbenchMenuItem[] = TAB_GROUP_COLOR_PRESET_IDS.map(
        (cid) => ({
          type: "item",
          id: `tab-group-color-${cid}`,
          label: cid.charAt(0).toUpperCase() + cid.slice(1),
          onSelect: () => {
            dispatch({
              type: "UPDATE_TAB_GROUP_META",
              pane,
              groupId,
              color: cid,
            });
          },
        })
      );

      openAt(e, [
        {
          type: "item",
          id: "tab-group-rename",
          label: "Rename…",
          onSelect: () => {
            queueMicrotask(() => {
              const snap = stateRef.current;
              const gr = snap[groupsKey][groupId];
              if (!gr) return;
              const t = window.prompt("Group name", gr.title);
              if (t == null || !t.trim()) return;
              dispatch({
                type: "UPDATE_TAB_GROUP_META",
                pane,
                groupId,
                title: t.trim(),
              });
            });
          },
        },
        {
          type: "item",
          id: "tab-group-custom-color",
          label: "Custom color…",
          onSelect: () => {
            queueMicrotask(() => {
              const snap = stateRef.current;
              const gr = snap[groupsKey][groupId];
              if (!gr) return;
              const c = window.prompt(
                "Hex color (#rrggbb)",
                resolveTabGroupColorHex(gr.color)
              );
              if (c == null || !/^#[0-9a-fA-F]{6}$/.test(c.trim())) return;
              dispatch({
                type: "UPDATE_TAB_GROUP_META",
                pane,
                groupId,
                color: c.trim(),
              });
            });
          },
        },
        { type: "sep" },
        ...colorItems,
        { type: "sep" },
        {
          type: "item",
          id: "tab-group-ungroup",
          label: "Ungroup All",
          onSelect: () => dispatch({ type: "UNGROUP_ALL", pane, groupId }),
        },
      ]);
    },
    [dispatch, openAt]
  );

  const handleEditorTabContextMenu = useCallback(
    (e: MouseEvent, group: EditorGroup, tabId: string) => {
      e.stopPropagation();
      const tab = findTab(tabId);
      if (!tab) return;
      const snapshot = stateRef.current;
      const tabsInGroup =
        group === "left" ? snapshot.leftTabs : snapshot.rightTabs;
      const idx = tabsInGroup.findIndex((t) => t.id === tabId);
      const root = workspaceInfo?.root ?? "";
      const fullPath =
        tab.filePath && root
          ? `${root.replace(/\\/g, "/")}/${tab.filePath}`
          : (tab.filePath ?? "");
      const otherGroup: EditorGroup = group === "left" ? "right" : "left";

      const items: WorkbenchMenuItem[] = [
        {
          type: "item",
          id: "close",
          label: "Close",
          onSelect: () => requestCloseTab(group, tabId),
        },
        {
          type: "item",
          id: "close-others",
          label: "Close Others",
          disabled: tabsInGroup.length <= 1,
          onSelect: () => {
            dispatch({ type: "SELECT_TAB", group, id: tabId });
            requestCloseOthersInGroup(group);
          },
        },
        {
          type: "item",
          id: "close-right",
          label: "Close to the Right",
          disabled: idx < 0 || idx >= tabsInGroup.length - 1,
          onSelect: () => {
            const rest = tabsInGroup.slice(idx + 1);
            for (const t of rest) {
              requestCloseTab(group, t.id);
            }
          },
        },
      ];

      if (tab.dirty && tabCanSave(tab)) {
        items.push({
          type: "item",
          id: "save",
          label: "Save",
          onSelect: () => void saveTab(tabId),
        });
      }

      const tabGroupMembershipId = (() => {
        const gk = group === "left" ? "leftTabGroups" : "rightTabGroups";
        for (const [gid, gr] of Object.entries(snapshot[gk])) {
          if (gr.tabIds.includes(tabId)) return gid;
        }
        return null;
      })();

      if (!tabGroupMembershipId) {
        items.push({
          type: "item",
          id: "new-tab-group",
          label: "New Tab Group",
          onSelect: () =>
            dispatch({ type: "CREATE_TAB_GROUP", pane: group, tabId }),
        });
      } else {
        items.push({
          type: "item",
          id: "remove-from-tab-group",
          label: "Remove from Tab Group",
          onSelect: () =>
            dispatch({
              type: "REMOVE_TAB_FROM_GROUP",
              pane: group,
              tabId,
            }),
        });
      }

      items.push({ type: "sep" });
      if (snapshot.split) {
        items.push(
          {
            type: "item",
            id: "move-other-group",
            label: "Move to Other Editor Group",
            onSelect: () => moveTab(tabId, group, otherGroup),
          },
          {
            type: "item",
            id: "split-right",
            label: "Use Side-by-side Layout",
            disabled: snapshot.splitOrientation === "horizontal",
            onSelect: () => setSplitMode("horizontal", otherGroup),
          },
          {
            type: "item",
            id: "split-down",
            label: "Use Stacked Layout",
            disabled: snapshot.splitOrientation === "vertical",
            onSelect: () => setSplitMode("vertical", otherGroup),
          },
          {
            type: "item",
            id: "join-groups",
            label: "Join Editor Groups",
            onSelect: joinEditorGroups,
          }
        );
      } else {
        items.push(
          {
            type: "item",
            id: "move-split-right",
            label: "Move to New Right Group",
            onSelect: () => moveTabToNewSplit(tabId, group, "horizontal"),
          },
          {
            type: "item",
            id: "move-split-down",
            label: "Move to New Bottom Group",
            onSelect: () => moveTabToNewSplit(tabId, group, "vertical"),
          }
        );
      }

      if (activeWorkspaceId) {
        const availableWindows = workspaceWindows.filter(
          (windowRecord) =>
            windowRecord.id !== activeWindowId && !windowRecord.closedAt
        );
        items.push({ type: "sep" });
        items.push({
          type: "item",
          id: "move-new-workspace-window",
          label: "Move to New Workspace Window",
          onSelect: () => {
            void moveEditorTabToWorkspaceWindow(group, tabId);
          },
        });
        for (const windowRecord of availableWindows) {
          items.push({
            type: "item",
            id: `move-workspace-window-${windowRecord.id}`,
            label: `Move to ${windowRecord.label}`,
            onSelect: () => {
              void moveEditorTabToWorkspaceWindow(group, tabId, windowRecord.id);
            },
          });
        }
      }

      if (tab.conversationId) {
        items.push({
          type: "item",
          id: "move-left",
          label: "Move Chat to Left Editor Group",
          disabled: group === "left",
          onSelect: () =>
            dispatch({
              type: "OPEN_AGENT_CONVERSATION_TAB",
              conversationId: tab.conversationId!,
              title: tab.name,
              group: "left",
            }),
        });
        items.push({
          type: "item",
          id: "move-right",
          label: "Move Chat to Right Editor Group",
          disabled: group === "right",
          onSelect: () =>
            dispatch({
              type: "OPEN_AGENT_CONVERSATION_TAB",
              conversationId: tab.conversationId!,
              title: tab.name,
              group: "right",
            }),
        });
      }

      if (tab.filePath) {
        items.push({ type: "sep" });
        items.push(
          {
            type: "item",
            id: "copy-rel",
            label: "Copy Relative Path",
            onSelect: () => void copyToClipboard(tab.filePath!),
          },
          {
            type: "item",
            id: "copy-full",
            label: "Copy Path",
            onSelect: () => void copyToClipboard(fullPath),
          }
        );
      }

      openAt(e, items);
    },
    [
      activeWindowId,
      activeWorkspaceId,
      copyToClipboard,
      dispatch,
      findTab,
      joinEditorGroups,
      moveTab,
      moveEditorTabToWorkspaceWindow,
      moveTabToNewSplit,
      openAt,
      requestCloseOthersInGroup,
      requestCloseTab,
      saveTab,
      setSplitMode,
      workspaceWindows,
      workspaceInfo?.root,
    ]
  );

  function renderCodeForTab(tab: EditorTab, group: EditorGroup) {
    if (tab.composerDraftId) {
      return (
        <ExpandedComposerView
          key={tab.id}
          draftId={tab.composerDraftId}
          title={tab.name}
          onMinimize={() => requestCloseTab(group, tab.id)}
          {...(hasExpandedComposerOverrides
            ? { setExpandedComposerDraft }
            : {})}
        />
      );
    }
    if (tab.conversationId) {
      return (
        <AgentConversationView
          key={tab.id}
          conversationId={tab.conversationId}
          {...(hasExpandedComposerOverrides
            ? {
                expandedComposerDraftId,
                setExpandedComposerDraft,
              }
            : {})}
        />
      );
    }
    if (tab.transcriptMessages && tab.transcriptMessages.length > 0) {
      return (
        <AgentTranscriptView
          key={tab.id}
          messages={tab.transcriptMessages}
          sessionId={tab.transcriptSessionId}
        />
      );
    }
    if (tab.browser) {
      return (
        <BrowserTab key={tab.id} tab={tab} dispatch={dispatch} editorGroup={group} />
      );
    }
    if (tab.language === "markdown" && tab.previewMode === "preview") {
      return <SimpleMarkdownPreview key={tab.id} source={tab.content} />;
    }
    if (tab.loading) {
      return (
        <div className="flex h-full items-center justify-center font-sans text-[13px] text-[var(--text-secondary)]">
          Loading {tab.name}...
        </div>
      );
    }
    if (tab.terminalId) {
      const terminalStillAvailable = terminals.some(
        (terminal) => terminal.id === tab.terminalId
      );
      if (!terminalStillAvailable) {
        return (
          <div className="flex h-full items-center justify-center px-6 text-center font-sans text-[13px] text-[var(--text-secondary)]">
            This terminal session is no longer running. Create a new terminal to continue.
          </div>
        );
      }
      return (
        <Terminal
          key={tab.id}
          terminalId={tab.terminalId}
          onAutoCloseAfterCleanExit={() => {
            const current = findTab(tab.id);
            if (!current) return;
            void closeTabs([current], { type: "CLOSE_TAB", group, id: tab.id });
          }}
        />
      );
    }
    if (
      tab.filePath &&
      tab.previewPath &&
      (tab.fileKind === "image" ||
        (tab.fileKind === "svg" && tab.previewMode === "preview"))
    ) {
      return (
        <FilePreview
          key={tab.id}
          filePath={tab.filePath}
          name={tab.name}
          previewPath={tab.previewPath}
          mimeType={tab.mimeType}
        />
      );
    }
    return (
      <div className="relative h-full">
        {tab.externalChange ? (
          <div className="absolute inset-x-3 top-3 z-10 rounded-[var(--radius-tab)] border border-[var(--border-card)] bg-[var(--bg-panel)] px-3 py-2 font-sans text-[12px] text-[var(--text-primary)]">
            This file changed on disk while you had unsaved edits. Save to keep your version, or reopen it from the explorer to discard local changes.
          </div>
        ) : null}
        {tab.fileContentTruncated && tab.filePath ? (
          <div
            className={`absolute inset-x-3 z-10 flex flex-wrap items-center gap-x-3 gap-y-1 rounded-[var(--radius-tab)] border border-[var(--border-card)] bg-[var(--bg-panel)] px-3 py-2 font-sans text-[12px] text-[var(--text-primary)] ${
              tab.externalChange ? "top-[72px]" : "top-3"
            }`}
          >
            <span className="text-[var(--text-secondary)]">
              Large file: loaded{" "}
              {Math.max(1, Math.round((tab.fileLoadedThroughByte ?? 0) / 1024))}{" "}
              KiB of{" "}
              {Math.max(1, Math.round((tab.fileTotalBytes ?? 0) / 1024))} KiB.
            </span>
            <button
              type="button"
              className="text-[var(--accent-fg)] underline decoration-dotted underline-offset-2 hover:text-[var(--text-primary)]"
              onClick={() => {
                void readFile(tab.filePath!, { full: true })
                  .then((result) => dispatch(fileContentLoadAction(tab.id, result)))
                  .catch((error) =>
                    flashNotice(
                      error instanceof Error
                        ? error.message
                        : "Failed to load the full file.",
                      "error"
                    )
                  );
              }}
            >
              Load full file
            </button>
          </div>
        ) : null}
        <CodeEditor
          key={tab.id}
          content={tab.content}
          language={tab.language}
          filePath={tab.filePath}
          initialViewState={viewStateByTabIdRef.current[tab.id]}
          onViewStateChange={(viewState) => {
            if (
              areViewStatesEqual(viewStateByTabIdRef.current[tab.id], viewState)
            ) {
              return;
            }
            const nextViewStateByTabId = {
              ...viewStateByTabIdRef.current,
              [tab.id]: viewState,
            };
            viewStateByTabIdRef.current = nextViewStateByTabId;
            updateEditorSession((current) => {
              if (
                areViewStatesEqual(current.viewStateByTabId[tab.id], viewState)
              ) {
                return current;
              }
              return {
                ...stateRef.current,
                viewStateByTabId: nextViewStateByTabId,
              };
            });
          }}
          onContentChange={(content) =>
            dispatch({ type: "UPDATE_TAB_CONTENT", tabId: tab.id, content })
          }
          onLiveContentChange={(content) => {
            liveTabContentRef.current.set(tab.id, content);
            if (tab.composerDraftId) {
              upsertComposerDraft(tab.composerDraftId, {
                title: tab.name,
                content,
              });
            }
          }}
          onSave={
            tab.composerDraftId
              ? undefined
              : (content) => saveTab(tab.id, content)
          }
        />
      </div>
    );
  }

  function emptyState(message: string) {
    return (
      <div className="flex h-full items-center justify-center px-6 text-center font-sans text-[13px] text-[var(--text-secondary)]">
        {message}
      </div>
    );
  }

  function renderEditorGroup(
    group: EditorGroup,
    options: {
      activeTab: EditorTab | null;
      activeTabId: string | null;
      tabs: EditorTab[];
      showSplitToolbar: boolean;
      emptyMessage: string;
    }
  ) {
    const padStripLeadingForWindowChrome =
      experimentalIpadWindowedTabInset &&
      !isMobile &&
      !primarySidebarVisible &&
      group === "left";
    const paneCloseSlotGroup: EditorGroup =
      !state.split || state.splitOrientation === "vertical" ? "left" : "right";
    const trailingSpacerWidthPx =
      reserveTrailingPaneCloseSlot && group === paneCloseSlotGroup ? 18 : 0;

    return (
      <div className="flex h-full min-h-0 min-w-0 flex-col">
        <EditorTabs
          group={group}
          tabs={options.tabs}
          stripItems={group === "left" ? state.leftStripItems : state.rightStripItems}
          tabGroups={group === "left" ? state.leftTabGroups : state.rightTabGroups}
          activeTabId={options.activeTabId}
          splitActive={state.split}
          splitOrientation={state.splitOrientation}
          showSplitToolbar={options.showSplitToolbar}
          padStripLeadingForWindowChrome={padStripLeadingForWindowChrome}
          onSelectTab={(id) => selectTab(group, id)}
          onCloseTab={(id) => requestCloseTab(group, id)}
          onSplitRight={() => setSplitMode("horizontal", group)}
          onSplitDown={() => setSplitMode("vertical", group)}
          onJoinGroups={joinEditorGroups}
          onCloseAllTabs={() => requestCloseAllInGroup(group)}
          onCloseOtherTabs={() => requestCloseOthersInGroup(group)}
          onMoveTabBetweenGroups={moveTab}
          onOpenConversationTab={openConversationTab}
          onTabContextMenu={(e, id) => handleEditorTabContextMenu(e, group, id)}
          onStripContextMenu={(e) => handleEditorStripContextMenu(e, group)}
          onToggleTabGroupCollapsed={(groupId) =>
            dispatch({ type: "TOGGLE_TAB_GROUP_COLLAPSED", pane: group, groupId })
          }
          onTabGroupContextMenu={(e, groupId) =>
            handleTabGroupContextMenu(e, group, groupId)
          }
          onAddTabToGroup={(tabId, groupId) =>
            dispatch({ type: "ADD_TAB_TO_GROUP", pane: group, tabId, groupId })
          }
          onMoveTabToStripIndex={(tabId, toIndex) =>
            dispatch({
              type: "MOVE_TAB_TO_STRIP_INDEX",
              pane: group,
              tabId,
              toIndex,
            })
          }
          agentTabIndicators={agentTabIndicators}
          trailingSpacerWidthPx={trailingSpacerWidthPx}
        />
        <div
          className="flex min-h-0 flex-1 flex-col overflow-hidden"
          onPointerDown={() => focusEditorGroup(group)}
          onDragOver={editorDragOverHandler}
          onDrop={editorDropHandler(group)}
        >
          {!options.activeTab ? (
            emptyState(options.emptyMessage)
          ) : (
            renderCodeForTab(options.activeTab, group)
          )}
        </div>
      </div>
    );
  }

  function editorDropHandler(targetGroup: EditorGroup) {
    return (e: DragEvent) => {
      const payload = parseTabDragPayload(e.dataTransfer.getData(TAB_DND_MIME));
      if (state.split && payload) {
        e.preventDefault();
        if (payload.group !== targetGroup) {
          moveTab(payload.tabId, payload.group, targetGroup);
        }
        return;
      }

      const chatPayload = parseChatTabDragPayload(
        e.dataTransfer.getData(CHAT_TAB_DND_MIME)
      );
      if (chatPayload) {
        e.preventDefault();
        openConversationTab(chatPayload.tabId, targetGroup);
      }
    };
  }

  function editorDragOverHandler(e: DragEvent) {
    const types = [...e.dataTransfer.types];
    if (types.includes(CHAT_TAB_DND_MIME)) {
      e.preventDefault();
      e.dataTransfer.dropEffect = "move";
      return;
    }
    if (!types.includes(TAB_DND_MIME)) return;
    const snap = stateRef.current;
    const allowTabDrag =
      snap.split ||
      snap.leftStripItems.some((it) => it.type === "group") ||
      snap.rightStripItems.some((it) => it.type === "group") ||
      snap.leftTabs.length + snap.rightTabs.length >= 2;
    if (!allowTabDrag) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = "move";
  }

  const leftActive =
    state.leftTabs.find((t) => t.id === state.leftActiveId) ?? null;
  const rightActive =
    state.rightTabs.find((t) => t.id === state.rightActiveId) ?? null;
  const splitLayout = state.splitLayout ?? DEFAULT_EDITOR_SPLIT_LAYOUT;

  if (!state.split) {
    return (
      <div className="flex h-full flex-col overflow-hidden bg-[var(--bg-main)]">
        {renderEditorGroup("left", {
          activeTab: leftActive,
          activeTabId: state.leftActiveId,
          tabs: state.leftTabs,
          showSplitToolbar: true,
          emptyMessage: "No files open",
        })}
      </div>
    );
  }

  return (
    <div className="flex h-full flex-col overflow-hidden bg-[var(--bg-main)]">
      <Group
        orientation={state.splitOrientation}
        id="editor-split-group"
        key={state.splitOrientation}
        className="min-h-0 min-w-0 flex-1"
        defaultLayout={splitLayout}
        onLayoutChanged={(layout) => {
          dispatch({ type: "SET_SPLIT_LAYOUT", layout });
        }}
      >
        <Panel
          id={EDITOR_SPLIT_PANEL_IDS.left}
          minSize={state.splitOrientation === "horizontal" ? "18%" : "15%"}
          className="min-h-0 min-w-0"
          style={{ overflow: "hidden" }}
        >
          {renderEditorGroup("left", {
            activeTab: leftActive,
            activeTabId: state.leftActiveId,
            tabs: state.leftTabs,
            showSplitToolbar: true,
            emptyMessage: "No file selected — open a tab above or move one here.",
          })}
        </Panel>
        <EditorSplitResizeHandle orientation={state.splitOrientation} />
        <Panel
          id={EDITOR_SPLIT_PANEL_IDS.right}
          minSize={state.splitOrientation === "horizontal" ? "18%" : "15%"}
          className="min-h-0 min-w-0"
          style={{ overflow: "hidden" }}
        >
          {renderEditorGroup("right", {
            activeTab: rightActive,
            activeTabId: state.rightActiveId,
            tabs: state.rightTabs,
            showSplitToolbar: false,
            emptyMessage: "Move or drop a tab here from the other editor group.",
          })}
        </Panel>
      </Group>
    </div>
  );
}
