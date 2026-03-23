"use client";

import { useReducer, useCallback, useEffect, useRef, type DragEvent } from "react";
import { EditorTabs } from "./EditorTabs";
import { CodeEditor } from "./CodeEditor";
import { SimpleMarkdownPreview } from "./SimpleMarkdownPreview";
import { AgentTranscriptView } from "./AgentTranscriptView";
import { useEditorBridgeRef } from "@/components/ide/EditorBridgeContext";
import {
  useOpenInEditor,
  type OpenTranscriptPayload,
} from "./OpenInEditorContext";
import type { ExplorerOpenRequest } from "@/lib/types";
import { editorTabs as initialTabs } from "@/lib/mock-data";
import type { EditorTab } from "@/lib/types";
import {
  createInitialEditorState,
  editorPanelReducer,
  type EditorGroup,
  TAB_DND_MIME,
  parseTabDragPayload,
} from "./editor-panel-state";

export function EditorPanel() {
  const [state, dispatch] = useReducer(
    editorPanelReducer,
    initialTabs,
    createInitialEditorState
  );

  const stateRef = useRef(state);
  stateRef.current = state;
  const bridgeRef = useEditorBridgeRef();
  useEffect(() => {
    bridgeRef.current = {
      dispatch,
      getState: () => stateRef.current,
    };
    return () => {
      bridgeRef.current = null;
    };
  }, [bridgeRef, dispatch]);

  const { registerOpenTranscript, registerOpenExplorerFile } = useOpenInEditor();

  useEffect(() => {
    const onTranscript = (payload: OpenTranscriptPayload) => {
      dispatch({
        type: "OPEN_TRANSCRIPT_TAB",
        title: payload.title,
        messages: payload.messages,
      });
    };
    const onExplorer = (payload: ExplorerOpenRequest) => {
      dispatch({ type: "OPEN_EXPLORER_FILE", ...payload });
    };
    registerOpenTranscript(onTranscript);
    registerOpenExplorerFile(onExplorer);
    return () => {
      registerOpenTranscript(null);
      registerOpenExplorerFile(null);
    };
  }, [registerOpenTranscript, registerOpenExplorerFile]);

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

  function renderCodeForTab(tab: EditorTab) {
    if (tab.transcriptMessages && tab.transcriptMessages.length > 0) {
      return (
        <AgentTranscriptView
          key={tab.id}
          messages={tab.transcriptMessages}
        />
      );
    }
    if (tab.language === "markdown" && tab.markdownPreview) {
      return <SimpleMarkdownPreview key={tab.id} source={tab.content} />;
    }
    return (
      <CodeEditor
        key={tab.id}
        content={tab.content}
        language={tab.language}
        terminal={tab.icon === "terminal"}
      />
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
            renderCodeForTab(leftActive)
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
              renderCodeForTab(leftActive)
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
              renderCodeForTab(rightActive)
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
