"use client";

import {
  useReducer,
  useCallback,
  useEffect,
  useRef,
  type DragEvent,
  type MouseEvent,
} from "react";
import { EditorTabs } from "./EditorTabs";
import { CodeEditor } from "./CodeEditor";
import { Terminal } from "./Terminal";
import { SimpleMarkdownPreview } from "./SimpleMarkdownPreview";
import { FilePreview } from "./FilePreview";
import { AgentTranscriptView } from "./AgentTranscriptView";
import { AgentConversationView } from "./AgentConversationView";
import { SettingsEditorView } from "./SettingsEditorView";
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
import type { EditorTab } from "@/lib/types";
import {
  SETTINGS_EDITOR_TAB_ID,
  editorPanelReducer,
  type EditorPanelAction,
  type EditorGroup,
  TAB_DND_MIME,
  parseTabDragPayload,
} from "./editor-panel-state";
import { createTerminal, deleteTerminal, readFile, writeFile } from "@/lib/server-api";
import { useWorkspace } from "@/contexts/WorkspaceContext";
import { useWorkbenchNotifications } from "@/components/notifications/WorkbenchNotificationProvider";
import { WORKBENCH_NOTIFICATION_KIND } from "@/components/notifications/workbench-notification-types";

function tabCanSave(tab: EditorTab): boolean {
  return Boolean(tab.filePath && tab.fileKind && tab.fileKind !== "image");
}

function isUnknownTerminalError(error: unknown): boolean {
  return error instanceof Error && error.message.includes("Unknown terminal");
}

function createEditorStateFromSession(session: {
  split: boolean;
  focusedGroup: EditorGroup;
  leftTabs: EditorTab[];
  rightTabs: EditorTab[];
  leftActiveId: string | null;
  rightActiveId: string | null;
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
  return {
    split: session.split,
    focusedGroup: session.focusedGroup,
    leftTabs: session.leftTabs.map(normalizeTranscriptTab),
    rightTabs: session.rightTabs.map(normalizeTranscriptTab),
    leftActiveId: session.leftActiveId,
    rightActiveId: session.rightActiveId,
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

export function EditorPanel() {
  const {
    registerOpenTranscript,
    registerOpenComposerDraft,
    registerOpenAgentConversation,
    registerOpenExplorerFile,
    composerDrafts,
    upsertComposerDraft,
    setActiveExplorerPath,
    expandedComposerDraftId,
    setExpandedComposerDraft,
  } = useOpenInEditor();
  const {
    fsResyncToken,
    lastFileChange,
    refreshTerminals,
    terminals,
    workspaceInfo,
    workspaceSession,
    updateWorkspaceSession,
  } = useWorkspace();
  const { openAt } = useWorkbenchContextMenu();
  const { pushNotification, dismiss, dismissByKind } = useWorkbenchNotifications();
  const liveTabContentRef = useRef<Map<string, string>>(new Map());
  const viewStateByTabIdRef = useRef<Record<string, unknown>>(
    workspaceSession.editor.viewStateByTabId
  );
  const handledDiskChangeAtRef = useRef<number | null>(null);
  const handledFsResyncTokenRef = useRef<number | null>(null);
  const [state, dispatch] = useReducer(
    editorPanelReducer,
    workspaceSession.editor,
    createEditorStateFromSession
  );

  const stateRef = useRef(state);
  const bridgeRef = useEditorBridgeRef();

  useEffect(() => {
    stateRef.current = state;
  }, [state]);

  useEffect(() => {
    updateWorkspaceSession((current) => ({
      ...current,
      editor: {
        ...state,
        viewStateByTabId: viewStateByTabIdRef.current,
      },
    }));
  }, [state, updateWorkspaceSession]);

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
        dispatch({
          type: "LOAD_FILE_CONTENT",
          tabId,
          content: result.content,
          language: result.language,
          fileKind: result.fileKind,
          mimeType: result.mimeType,
          previewPath: result.previewPath,
        });
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
        dispatch({
          type: "LOAD_FILE_CONTENT",
          tabId: matchingTab.id,
          content: result.content,
          language: result.language,
          fileKind: result.fileKind,
          mimeType: result.mimeType,
          previewPath: result.previewPath,
        });
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
          dispatch({
            type: "LOAD_FILE_CONTENT",
            tabId: tab.id,
            content: result.content,
            language: result.language,
            fileKind: result.fileKind,
            mimeType: result.mimeType,
            previewPath: result.previewPath,
          });
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

  const selectTab = useCallback((group: EditorGroup, id: string) => {
    dispatch({ type: "SELECT_TAB", group, id });
  }, []);

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

  const handleEditorStripContextMenu = useCallback(
    (e: MouseEvent, group: EditorGroup) => {
      if (e.target !== e.currentTarget) return;
      e.preventDefault();
      const tabs =
        group === "left" ? stateRef.current.leftTabs : stateRef.current.rightTabs;
      const hasTabs = tabs.length > 0;
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
        {
          type: "item",
          id: "split",
          label: "Split Editor",
          onSelect: () => dispatch({ type: "TOGGLE_SPLIT" }),
        },
      ]);
    },
    [dispatch, openAt, requestCloseAllInGroup, requestCloseOthersInGroup]
  );

  const handleEditorTabContextMenu = useCallback(
    (e: MouseEvent, group: EditorGroup, tabId: string) => {
      e.stopPropagation();
      const tab = findTab(tabId);
      if (!tab) return;
      const tabsInGroup =
        group === "left" ? stateRef.current.leftTabs : stateRef.current.rightTabs;
      const idx = tabsInGroup.findIndex((t) => t.id === tabId);
      const root = workspaceInfo?.root ?? "";
      const fullPath =
        tab.filePath && root
          ? `${root.replace(/\\/g, "/")}/${tab.filePath}`
          : (tab.filePath ?? "");

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

      items.push({ type: "sep" });
      items.push({
        type: "item",
        id: "split",
        label: "Split Editor",
        onSelect: () => dispatch({ type: "TOGGLE_SPLIT" }),
      });

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
      copyToClipboard,
      dispatch,
      findTab,
      openAt,
      requestCloseOthersInGroup,
      requestCloseTab,
      saveTab,
      workspaceInfo?.root,
    ]
  );

  function renderCodeForTab(tab: EditorTab, group: EditorGroup) {
    if (tab.id === SETTINGS_EDITOR_TAB_ID) {
      return <SettingsEditorView key={tab.id} />;
    }
    if (tab.composerDraftId) {
      return (
        <ExpandedComposerView
          key={tab.id}
          draftId={tab.composerDraftId}
          title={tab.name}
          onMinimize={() => requestCloseTab(group, tab.id)}
        />
      );
    }
    if (tab.conversationId) {
      return (
        <AgentConversationView
          key={tab.id}
          conversationId={tab.conversationId}
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
      return <Terminal key={tab.id} terminalId={tab.terminalId} />;
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
            updateWorkspaceSession((current) => {
              if (
                areViewStatesEqual(
                  current.editor.viewStateByTabId[tab.id],
                  viewState
                )
              ) {
                return current;
              }
              return {
                ...current,
                editor: {
                  ...stateRef.current,
                  viewStateByTabId: nextViewStateByTabId,
                },
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
    if (!state.split) return;
    if (!types.includes(TAB_DND_MIME)) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = "move";
  }

  const leftActive =
    state.leftTabs.find((t) => t.id === state.leftActiveId) ?? null;
  const rightActive =
    state.rightTabs.find((t) => t.id === state.rightActiveId) ?? null;

  if (!state.split) {
    return (
      <div className="flex h-full flex-col overflow-hidden bg-[var(--bg-main)]">
        <EditorTabs
          group="left"
          tabs={state.leftTabs}
          activeTabId={state.leftActiveId}
          splitActive={false}
          showSplitToolbar
          onSelectTab={(id) => selectTab("left", id)}
          onCloseTab={(id) => requestCloseTab("left", id)}
          onToggleSplit={() => dispatch({ type: "TOGGLE_SPLIT" })}
          onCloseAllTabs={() => requestCloseAllInGroup("left")}
          onCloseOtherTabs={() => requestCloseOthersInGroup("left")}
          onMoveTabBetweenGroups={moveTab}
          onOpenConversationTab={openConversationTab}
          onTabContextMenu={(e, id) => handleEditorTabContextMenu(e, "left", id)}
          onStripContextMenu={(e) => handleEditorStripContextMenu(e, "left")}
        />
        <div
          className="min-h-0 flex-1 overflow-hidden"
          onPointerDown={() => focusEditorGroup("left")}
          onDragOver={editorDragOverHandler}
          onDrop={editorDropHandler("left")}
        >
          {!leftActive ? (
            emptyState("No files open")
          ) : (
            renderCodeForTab(leftActive, "left")
          )}
        </div>
      </div>
    );
  }

  return (
    <div className="flex h-full flex-col overflow-hidden bg-[var(--bg-main)]">
      <div className="flex min-h-0 min-w-0 flex-1 flex-row">
        <div className="flex min-h-0 min-w-0 flex-1 flex-col border-r border-[var(--border-subtle)]">
          <EditorTabs
            group="left"
            tabs={state.leftTabs}
            activeTabId={state.leftActiveId}
            splitActive
            showSplitToolbar
            onSelectTab={(id) => selectTab("left", id)}
            onCloseTab={(id) => requestCloseTab("left", id)}
            onToggleSplit={() => dispatch({ type: "TOGGLE_SPLIT" })}
            onCloseAllTabs={() => requestCloseAllInGroup("left")}
            onCloseOtherTabs={() => requestCloseOthersInGroup("left")}
            onMoveTabBetweenGroups={moveTab}
          onOpenConversationTab={openConversationTab}
            onTabContextMenu={(e, id) => handleEditorTabContextMenu(e, "left", id)}
            onStripContextMenu={(e) => handleEditorStripContextMenu(e, "left")}
          />
          <div
            className="min-h-0 flex-1 overflow-hidden"
            onPointerDown={() => focusEditorGroup("left")}
            onDragOver={editorDragOverHandler}
            onDrop={editorDropHandler("left")}
          >
            {!leftActive ? (
              emptyState("No file selected — open a tab above or drop one here.")
            ) : (
              renderCodeForTab(leftActive, "left")
            )}
          </div>
        </div>

        <div className="flex min-h-0 min-w-0 flex-1 flex-col">
          <EditorTabs
            group="right"
            tabs={state.rightTabs}
            activeTabId={state.rightActiveId}
            splitActive
            showSplitToolbar={false}
            onSelectTab={(id) => selectTab("right", id)}
            onCloseTab={(id) => requestCloseTab("right", id)}
            onToggleSplit={() => dispatch({ type: "TOGGLE_SPLIT" })}
            onCloseAllTabs={() => requestCloseAllInGroup("right")}
            onCloseOtherTabs={() => requestCloseOthersInGroup("right")}
            onMoveTabBetweenGroups={moveTab}
            onOpenConversationTab={openConversationTab}
            onTabContextMenu={(e, id) => handleEditorTabContextMenu(e, "right", id)}
            onStripContextMenu={(e) => handleEditorStripContextMenu(e, "right")}
          />
          <div
            className="min-h-0 flex-1 overflow-hidden"
            onPointerDown={() => focusEditorGroup("right")}
            onDragOver={editorDragOverHandler}
            onDrop={editorDropHandler("right")}
          >
            {!rightActive ? (
              emptyState(
                "Drop a tab from the left group here, or drag a tab onto the row above."
              )
            ) : (
              renderCodeForTab(rightActive, "right")
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
