"use client";

import {
  useReducer,
  useCallback,
  useEffect,
  useRef,
  useState,
  type DragEvent,
} from "react";
import { EditorTabs } from "./EditorTabs";
import { CodeEditor } from "./CodeEditor";
import { Terminal } from "./Terminal";
import { SimpleMarkdownPreview } from "./SimpleMarkdownPreview";
import { FilePreview } from "./FilePreview";
import { AgentTranscriptView } from "./AgentTranscriptView";
import { SettingsEditorView } from "./SettingsEditorView";
import { BrowserTab } from "./BrowserTab";
import { useEditorBridgeRef } from "@/components/ide/EditorBridgeContext";
import {
  useOpenInEditor,
  type OpenTranscriptPayload,
} from "./OpenInEditorContext";
import type { ExplorerOpenRequest } from "@/lib/types";
import type { EditorTab } from "@/lib/types";
import {
  SETTINGS_EDITOR_TAB_ID,
  createInitialEditorState,
  editorPanelReducer,
  type EditorGroup,
  TAB_DND_MIME,
  parseTabDragPayload,
} from "./editor-panel-state";
import { createTerminal, readFile, writeFile } from "@/lib/server-api";
import { useWorkspace } from "@/contexts/WorkspaceContext";

export function EditorPanel() {
  const {
    registerOpenTranscript,
    registerOpenExplorerFile,
    setActiveExplorerPath,
  } = useOpenInEditor();
  const { lastFileChange, refreshTerminals } = useWorkspace();
  const [notice, setNotice] = useState<string | null>(null);
  const [state, dispatch] = useReducer(
    editorPanelReducer,
    [],
    createInitialEditorState
  );

  const stateRef = useRef(state);
  const bridgeRef = useEditorBridgeRef();

  useEffect(() => {
    stateRef.current = state;
  }, [state]);

  const flashNotice = useCallback((message: string) => {
    setNotice(message);
    window.setTimeout(() => setNotice(null), 2400);
  }, []);

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
    async (tabId: string, nextContent?: string) => {
      const tab = findTab(tabId);
      if (!tab?.filePath || tab.fileKind === "image") {
        return false;
      }

      const contentToSave = nextContent ?? tab.content;
      try {
        await writeFile(tab.filePath, contentToSave);
        dispatch({ type: "MARK_SAVED", tabId, content: contentToSave });
        flashNotice(`Saved ${tab.name}`);
        return true;
      } catch (error) {
        flashNotice(
          error instanceof Error
            ? `Failed to save ${tab.name}: ${error.message}`
            : `Failed to save ${tab.name}.`
        );
        return false;
      }
    },
    [findTab, flashNotice]
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

  useEffect(() => {
    bridgeRef.current = {
      dispatch,
      getState: () => stateRef.current,
      saveActiveTab: async () => {
        const snapshot = stateRef.current;
        const group = snapshot.focusedGroup;
        const activeId = group === "left" ? snapshot.leftActiveId : snapshot.rightActiveId;
        if (!activeId) {
          flashNotice("No active editor to save.");
          return false;
        }
        return saveTab(activeId);
      },
      openTerminalTab,
      openBrowserTab,
    };
    return () => {
      bridgeRef.current = null;
    };
  }, [bridgeRef, dispatch, flashNotice, openBrowserTab, openTerminalTab, saveTab]);

  useEffect(() => {
    const onTranscript = (payload: OpenTranscriptPayload) => {
      dispatch({
        type: "OPEN_TRANSCRIPT_TAB",
        title: payload.title,
        messages: payload.messages,
      });
    };
    const onExplorer = (payload: ExplorerOpenRequest) => {
      void loadExplorerFile(payload);
    };
    registerOpenTranscript(onTranscript);
    registerOpenExplorerFile(onExplorer);
    return () => {
      registerOpenTranscript(null);
      registerOpenExplorerFile(null);
    };
  }, [loadExplorerFile, registerOpenTranscript, registerOpenExplorerFile]);

  useEffect(() => {
    if (!lastFileChange) return;

    const matchingTab = [
      ...state.leftTabs,
      ...state.rightTabs,
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
  }, [lastFileChange, state.leftTabs, state.rightTabs]);

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

  const closeTab = useCallback((group: EditorGroup, id: string) => {
    dispatch({ type: "CLOSE_TAB", group, id });
  }, []);

  const moveTab = useCallback(
    (tabId: string, from: EditorGroup, to: EditorGroup) => {
      dispatch({ type: "MOVE_TAB", tabId, from, to });
    },
    []
  );

  function renderCodeForTab(tab: EditorTab, group: EditorGroup) {
    if (tab.id === SETTINGS_EDITOR_TAB_ID) {
      return <SettingsEditorView key={tab.id} />;
    }
    if (tab.transcriptMessages && tab.transcriptMessages.length > 0) {
      return (
        <AgentTranscriptView
          key={tab.id}
          messages={tab.transcriptMessages}
        />
      );
    }
    if (tab.browser) {
      return <BrowserTab key={tab.id} tab={tab} dispatch={dispatch} />;
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
          onContentChange={(content) =>
            dispatch({ type: "UPDATE_TAB_CONTENT", tabId: tab.id, content })
          }
          onSave={(content) => saveTab(tab.id, content)}
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
      if (!state.split) return;
      e.preventDefault();
      const payload = parseTabDragPayload(e.dataTransfer.getData(TAB_DND_MIME));
      if (!payload || payload.group === targetGroup) return;
      moveTab(payload.tabId, payload.group, targetGroup);
    };
  }

  function editorDragOverHandler(e: DragEvent) {
    if (!state.split) return;
    if (![...e.dataTransfer.types].includes(TAB_DND_MIME)) return;
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
        {notice ? (
          <div className="border-b border-[var(--border-subtle)] px-3 py-2 font-sans text-[12px] text-[var(--text-secondary)]">
            {notice}
          </div>
        ) : null}
        <EditorTabs
          group="left"
          tabs={state.leftTabs}
          activeTabId={state.leftActiveId}
          splitActive={false}
          showSplitToolbar
          onSelectTab={(id) => selectTab("left", id)}
          onCloseTab={(id) => closeTab("left", id)}
          onToggleSplit={() => dispatch({ type: "TOGGLE_SPLIT" })}
          onCloseAllTabs={() => dispatch({ type: "CLOSE_ALL_GROUP", group: "left" })}
          onCloseOtherTabs={() =>
            dispatch({ type: "CLOSE_OTHERS_GROUP", group: "left" })
          }
          onMoveTabBetweenGroups={moveTab}
        />
        <div
          className="min-h-0 flex-1 overflow-hidden"
          onPointerDown={() => focusEditorGroup("left")}
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
      {notice ? (
        <div className="border-b border-[var(--border-subtle)] px-3 py-2 font-sans text-[12px] text-[var(--text-secondary)]">
          {notice}
        </div>
      ) : null}
      <div className="flex min-h-0 min-w-0 flex-1 flex-row">
        <div className="flex min-h-0 min-w-0 flex-1 flex-col border-r border-[var(--border-subtle)]">
          <EditorTabs
            group="left"
            tabs={state.leftTabs}
            activeTabId={state.leftActiveId}
            splitActive
            showSplitToolbar
            onSelectTab={(id) => selectTab("left", id)}
            onCloseTab={(id) => closeTab("left", id)}
            onToggleSplit={() => dispatch({ type: "TOGGLE_SPLIT" })}
            onCloseAllTabs={() =>
              dispatch({ type: "CLOSE_ALL_GROUP", group: "left" })
            }
            onCloseOtherTabs={() =>
              dispatch({ type: "CLOSE_OTHERS_GROUP", group: "left" })
            }
            onMoveTabBetweenGroups={moveTab}
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
            onCloseTab={(id) => closeTab("right", id)}
            onToggleSplit={() => dispatch({ type: "TOGGLE_SPLIT" })}
            onCloseAllTabs={() =>
              dispatch({ type: "CLOSE_ALL_GROUP", group: "right" })
            }
            onCloseOtherTabs={() =>
              dispatch({ type: "CLOSE_OTHERS_GROUP", group: "right" })
            }
            onMoveTabBetweenGroups={moveTab}
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
