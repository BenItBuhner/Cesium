import { normalizeBrowserTargetUrl } from "@/lib/browser-proxy-url";
import {
  findEditorPaneIdByConversationId,
  findEditorPaneIdByTabId,
  getAllEditorTabs,
  getEditorNodePanelId,
  getEditorPaneIds,
} from "@/lib/editor-session-state";
import type { ChatMessage, EditorTab, ExplorerOpenRequest } from "@/lib/types";
import type {
  EditorPaneId,
  EditorPaneNode,
  EditorPaneTabsState,
  EditorSessionState,
  EditorSplitOrientation,
} from "@/lib/workspace-session";

function inferTranscriptSessionId(messages: ChatMessage[] | undefined): string | undefined {
  for (const message of messages ?? []) {
    const match = message.id.match(/(ses_[A-Za-z0-9]+)/);
    if (match?.[1]) {
      return match[1];
    }
  }
  return undefined;
}

function tabTitleFromUrl(url: string): string {
  try {
    const u = new URL(url);
    const path = u.pathname === "/" ? "" : u.pathname;
    const combined = `${u.host}${path}${u.search}`;
    return combined.length > 42 ? `${combined.slice(0, 39)}…` : combined;
  } catch {
    return "Browser";
  }
}

function newIdSegment(): string {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return crypto.randomUUID();
  }
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 11)}`;
}

function createPaneId(prefix = "pane"): EditorPaneId {
  return `${prefix}-${newIdSegment()}`;
}

function createSplitNodeId(): string {
  return `split-${newIdSegment()}`;
}

function createEmptyPaneState(): EditorPaneTabsState {
  return {
    tabs: [],
    activeId: null,
  };
}

/** Stable id for the in-editor Settings view (command palette, Ctrl+,). */
export const SETTINGS_EDITOR_TAB_ID = "workbench.settings";

export type EditorGroup = EditorPaneId;

export type EditorPanelState = EditorSessionState;

export type EditorPanelAction =
  | { type: "SELECT_TAB"; group: EditorGroup; id: string }
  | { type: "CLOSE_TAB"; group: EditorGroup; id: string }
  | { type: "CLOSE_ALL_GROUP"; group: EditorGroup }
  | { type: "CLOSE_OTHERS_GROUP"; group: EditorGroup }
  | { type: "ENABLE_SPLIT"; orientation?: EditorSplitOrientation; focus?: EditorGroup }
  | { type: "TOGGLE_SPLIT" }
  | { type: "SET_SPLIT_ORIENTATION"; orientation: EditorSplitOrientation }
  | { type: "SET_SPLIT_LAYOUT"; nodeId: string; layout: Record<string, number> | null }
  | { type: "MOVE_TAB"; tabId: string; from: EditorGroup; to: EditorGroup }
  | {
      type: "MOVE_TAB_TO_NEW_SPLIT";
      tabId: string;
      from: EditorGroup;
      orientation: EditorSplitOrientation;
      targetPaneId?: EditorGroup;
    }
  | { type: "FOCUS_EDITOR_GROUP"; group: EditorGroup }
  | {
      type: "OPEN_AGENT_CONVERSATION_TAB";
      conversationId: string;
      title: string;
      group?: EditorGroup;
    }
  | {
      type: "OPEN_TRANSCRIPT_TAB";
      title: string;
      messages: ChatMessage[];
      sessionId?: string;
      group?: EditorGroup;
    }
  | {
      type: "OPEN_COMPOSER_DRAFT_TAB";
      draftId: string;
      title: string;
      content: string;
      group?: EditorGroup;
    }
  | { type: "OPEN_TERMINAL_TAB"; terminalId: string; name?: string }
  | { type: "OPEN_BROWSER_TAB"; url: string; name?: string }
  | { type: "UPDATE_BROWSER_TAB_URL"; tabId: string; targetUrl: string }
  | { type: "UPDATE_BROWSER_TAB_FAVICON"; tabId: string; faviconUrl: string | null }
  | { type: "TOGGLE_FILE_PREVIEW" }
  | { type: "OPEN_SETTINGS_TAB" }
  | {
      type: "LOAD_FILE_CONTENT";
      tabId: string;
      content: string;
      language: string;
      fileKind: EditorTab["fileKind"];
      mimeType?: string;
      previewPath?: string;
      fileContentTruncated?: boolean;
      fileTotalBytes?: number;
      fileLoadedThroughByte?: number;
    }
  | { type: "UPDATE_TAB_CONTENT"; tabId: string; content: string }
  | { type: "MARK_SAVED"; tabId: string; content: string }
  | { type: "FILE_CHANGED_ON_DISK"; path: string }
  | { type: "CLEAR_EXTERNAL_CHANGE"; tabId: string }
  | ({ type: "OPEN_EXPLORER_FILE" } & ExplorerOpenRequest);

function stripActive(tab: EditorTab): EditorTab {
  // eslint-disable-next-line @typescript-eslint/no-unused-vars -- omit `active` from stored tab shape
  const { active, ...rest } = tab;
  if (rest.transcriptMessages?.length && !rest.transcriptSessionId) {
    return {
      ...rest,
      transcriptSessionId: inferTranscriptSessionId(rest.transcriptMessages),
    };
  }
  return rest;
}

function truncateTabName(title: string): string {
  return title.length > 40 ? `${title.slice(0, 37)}…` : title;
}

export function createInitialEditorState(tabs: EditorTab[]): EditorPanelState {
  const leftTabs = tabs.map(stripActive);
  const activeId = tabs.find((tab) => tab.active)?.id ?? tabs[0]?.id ?? null;
  return {
    root: { type: "leaf", paneId: "left" },
    panesById: {
      left: {
        tabs: leftTabs,
        activeId,
      },
    },
    focusedPaneId: "left",
    viewStateByTabId: {},
  };
}

function getPaneEntry(state: EditorPanelState, paneId: EditorPaneId): EditorPaneTabsState {
  return state.panesById[paneId] ?? createEmptyPaneState();
}

function replacePaneWithSplit(
  node: EditorPaneNode,
  paneId: EditorPaneId,
  orientation: EditorSplitOrientation,
  newPaneId: EditorPaneId
): { nextNode: EditorPaneNode; didSplit: boolean } {
  if (node.type === "leaf") {
    if (node.paneId !== paneId) {
      return { nextNode: node, didSplit: false };
    }
    const first: EditorPaneNode = node;
    const second: EditorPaneNode = { type: "leaf", paneId: newPaneId };
    return {
      didSplit: true,
      nextNode: {
        type: "split",
        nodeId: createSplitNodeId(),
        orientation,
        layout: {
          [getEditorNodePanelId(first)]: 50,
          [getEditorNodePanelId(second)]: 50,
        },
        first,
        second,
      },
    };
  }

  const first = replacePaneWithSplit(node.first, paneId, orientation, newPaneId);
  if (first.didSplit) {
    return {
      didSplit: true,
      nextNode: {
        ...node,
        first: first.nextNode,
      },
    };
  }

  const second = replacePaneWithSplit(node.second, paneId, orientation, newPaneId);
  if (second.didSplit) {
    return {
      didSplit: true,
      nextNode: {
        ...node,
        second: second.nextNode,
      },
    };
  }

  return { nextNode: node, didSplit: false };
}

function removePaneNode(node: EditorPaneNode, paneId: EditorPaneId): EditorPaneNode | null {
  if (node.type === "leaf") {
    return node.paneId === paneId ? null : node;
  }

  const first = removePaneNode(node.first, paneId);
  const second = removePaneNode(node.second, paneId);
  if (first && second) {
    return {
      ...node,
      first,
      second,
    };
  }
  return first ?? second;
}

function updateSplitNode(
  node: EditorPaneNode,
  nodeId: string,
  updater: (current: Extract<EditorPaneNode, { type: "split" }>) => EditorPaneNode
): { nextNode: EditorPaneNode; changed: boolean } {
  if (node.type === "leaf") {
    return { nextNode: node, changed: false };
  }
  if (node.nodeId === nodeId) {
    return {
      nextNode: updater(node),
      changed: true,
    };
  }
  const first = updateSplitNode(node.first, nodeId, updater);
  if (first.changed) {
    return {
      changed: true,
      nextNode: {
        ...node,
        first: first.nextNode,
      },
    };
  }
  const second = updateSplitNode(node.second, nodeId, updater);
  if (second.changed) {
    return {
      changed: true,
      nextNode: {
        ...node,
        second: second.nextNode,
      },
    };
  }
  return { nextNode: node, changed: false };
}

function removeEmptyPanesIfNeeded(state: EditorPanelState): EditorPanelState {
  let nextState = state;
  let paneIds = getEditorPaneIds(nextState);
  while (paneIds.length > 1) {
    const emptyPaneId = paneIds.find((paneId) => getPaneEntry(nextState, paneId).tabs.length === 0);
    if (!emptyPaneId) {
      break;
    }
    const nextRoot = removePaneNode(nextState.root, emptyPaneId);
    if (!nextRoot) {
      break;
    }
    const nextPanesById = { ...nextState.panesById };
    delete nextPanesById[emptyPaneId];
    const remainingPaneIds = getEditorPaneIds({
      ...nextState,
      root: nextRoot,
      panesById: nextPanesById,
    });
    nextState = {
      ...nextState,
      root: nextRoot,
      panesById: nextPanesById,
      focusedPaneId: remainingPaneIds.includes(nextState.focusedPaneId)
        ? nextState.focusedPaneId
        : remainingPaneIds[0] ?? paneIds[0]!,
    };
    paneIds = remainingPaneIds;
  }
  return nextState;
}

function updatePaneTabs(
  state: EditorPanelState,
  paneId: EditorPaneId,
  updater: (current: EditorPaneTabsState) => EditorPaneTabsState
): EditorPanelState {
  const current = getPaneEntry(state, paneId);
  const next = updater(current);
  if (next === current) {
    return state;
  }
  return {
    ...state,
    panesById: {
      ...state.panesById,
      [paneId]: next,
    },
  };
}

function mapTabsAcrossPanes(
  state: EditorPanelState,
  mapper: (tab: EditorTab) => EditorTab
): EditorPanelState {
  let changed = false;
  const nextPanesById = Object.fromEntries(
    getEditorPaneIds(state).map((paneId) => {
      const pane = getPaneEntry(state, paneId);
      const nextTabs = pane.tabs.map((tab) => {
        const nextTab = mapper(tab);
        if (nextTab !== tab) {
          changed = true;
        }
        return nextTab;
      });
      return [
        paneId,
        changed && nextTabs !== pane.tabs ? { ...pane, tabs: nextTabs } : { ...pane, tabs: nextTabs },
      ];
    })
  );
  return changed
    ? {
        ...state,
        panesById: nextPanesById,
      }
    : state;
}

function focusTabInPane(
  state: EditorPanelState,
  paneId: EditorPaneId,
  tabId: string
): EditorPanelState {
  return {
    ...updatePaneTabs(state, paneId, (pane) =>
      pane.activeId === tabId ? pane : { ...pane, activeId: tabId }
    ),
    focusedPaneId: paneId,
  };
}

function addTabToPane(
  state: EditorPanelState,
  paneId: EditorPaneId,
  tab: EditorTab
): EditorPanelState {
  return {
    ...updatePaneTabs(state, paneId, (pane) => ({
      ...pane,
      tabs: [...pane.tabs, tab],
      activeId: tab.id,
    })),
    focusedPaneId: paneId,
  };
}

function ensurePaneForTarget(
  state: EditorPanelState,
  requestedPaneId: EditorPaneId | undefined,
  orientation: EditorSplitOrientation = "horizontal"
): { state: EditorPanelState; paneId: EditorPaneId } {
  const fallbackPaneId = state.panesById[state.focusedPaneId]
    ? state.focusedPaneId
    : getEditorPaneIds(state)[0] ?? "left";
  if (!requestedPaneId) {
    return { state, paneId: fallbackPaneId };
  }
  if (state.panesById[requestedPaneId]) {
    return { state, paneId: requestedPaneId };
  }
  const { nextNode, didSplit } = replacePaneWithSplit(
    state.root,
    fallbackPaneId,
    orientation,
    requestedPaneId
  );
  if (!didSplit) {
    return { state, paneId: fallbackPaneId };
  }
  return {
    paneId: requestedPaneId,
    state: {
      ...state,
      root: nextNode,
      panesById: {
        ...state.panesById,
        [requestedPaneId]: createEmptyPaneState(),
      },
      focusedPaneId: requestedPaneId,
    },
  };
}

function joinAllPanes(state: EditorPanelState): EditorPanelState {
  const paneIds = getEditorPaneIds(state);
  if (paneIds.length <= 1) {
    return state;
  }
  const seen = new Set<string>();
  const mergedTabs = getAllEditorTabs(state).filter((tab) => {
    if (seen.has(tab.id)) {
      return false;
    }
    seen.add(tab.id);
    return true;
  });
  const primaryPaneId = paneIds[0]!;
  const focusedPane = getPaneEntry(state, state.focusedPaneId);
  const activeId =
    focusedPane.activeId && mergedTabs.some((tab) => tab.id === focusedPane.activeId)
      ? focusedPane.activeId
      : mergedTabs[0]?.id ?? null;
  return {
    ...state,
    root: { type: "leaf", paneId: primaryPaneId },
    panesById: {
      [primaryPaneId]: {
        tabs: mergedTabs,
        activeId,
      },
    },
    focusedPaneId: primaryPaneId,
  };
}

function moveTabBetweenPanes(
  state: EditorPanelState,
  tabId: string,
  from: EditorPaneId,
  to: EditorPaneId
): EditorPanelState {
  if (from === to || !state.panesById[from] || !state.panesById[to]) {
    return state;
  }
  const source = getPaneEntry(state, from);
  const target = getPaneEntry(state, to);
  const tab = source.tabs.find((candidate) => candidate.id === tabId);
  if (!tab) {
    return state;
  }
  const nextSourceTabs = source.tabs.filter((candidate) => candidate.id !== tabId);
  const nextTargetTabs = [...target.tabs.filter((candidate) => candidate.id !== tabId), tab];
  return {
    ...state,
    panesById: {
      ...state.panesById,
      [from]: {
        tabs: nextSourceTabs,
        activeId:
          source.activeId === tabId ? nextSourceTabs[0]?.id ?? null : source.activeId,
      },
      [to]: {
        tabs: nextTargetTabs,
        activeId: tabId,
      },
    },
    focusedPaneId: to,
  };
}

function updateTabById(
  state: EditorPanelState,
  tabId: string,
  updater: (tab: EditorTab) => EditorTab
): EditorPanelState {
  return mapTabsAcrossPanes(state, (tab) => (tab.id === tabId ? updater(tab) : tab));
}

function openTabInRequestedPane(
  state: EditorPanelState,
  tab: EditorTab,
  requestedPaneId?: EditorPaneId,
  splitOrientation: EditorSplitOrientation = "horizontal"
): EditorPanelState {
  const { state: nextState, paneId } = ensurePaneForTarget(
    state,
    requestedPaneId,
    splitOrientation
  );
  return addTabToPane(nextState, paneId, tab);
}

export function editorPanelReducer(
  state: EditorPanelState,
  action: EditorPanelAction
): EditorPanelState {
  switch (action.type) {
    case "SELECT_TAB":
      return focusTabInPane(state, action.group, action.id);

    case "FOCUS_EDITOR_GROUP":
      return state.focusedPaneId === action.group
        ? state
        : { ...state, focusedPaneId: action.group };

    case "CLOSE_TAB": {
      const pane = getPaneEntry(state, action.group);
      const nextTabs = pane.tabs.filter((tab) => tab.id !== action.id);
      const nextState = updatePaneTabs(state, action.group, () => ({
        tabs: nextTabs,
        activeId: pane.activeId === action.id ? nextTabs[0]?.id ?? null : pane.activeId,
      }));
      return removeEmptyPanesIfNeeded(nextState);
    }

    case "CLOSE_ALL_GROUP":
      return removeEmptyPanesIfNeeded(
        updatePaneTabs(state, action.group, () => createEmptyPaneState())
      );

    case "CLOSE_OTHERS_GROUP": {
      const pane = getPaneEntry(state, action.group);
      const keep = pane.tabs.find((tab) => tab.id === pane.activeId);
      if (!keep) {
        return state;
      }
      return updatePaneTabs(state, action.group, () => ({
        tabs: [keep],
        activeId: keep.id,
      }));
    }

    case "ENABLE_SPLIT": {
      const sourcePaneId =
        (action.focus && state.panesById[action.focus] && action.focus) ||
        state.focusedPaneId ||
        getEditorPaneIds(state)[0];
      if (!sourcePaneId) {
        return state;
      }
      const targetPaneId =
        action.focus && action.focus !== sourcePaneId ? action.focus : createPaneId();
      const { nextNode, didSplit } = replacePaneWithSplit(
        state.root,
        sourcePaneId,
        action.orientation ?? "horizontal",
        targetPaneId
      );
      if (!didSplit) {
        return state;
      }
      return {
        ...state,
        root: nextNode,
        panesById: {
          ...state.panesById,
          [targetPaneId]: state.panesById[targetPaneId] ?? createEmptyPaneState(),
        },
        focusedPaneId:
          action.focus && action.focus !== sourcePaneId ? targetPaneId : sourcePaneId,
      };
    }

    case "MOVE_TAB_TO_NEW_SPLIT": {
      const targetPaneId = action.targetPaneId ?? createPaneId();
      const { nextNode, didSplit } = replacePaneWithSplit(
        state.root,
        action.from,
        action.orientation,
        targetPaneId
      );
      if (!didSplit) {
        return state;
      }
      const expandedState: EditorPanelState = {
        ...state,
        root: nextNode,
        panesById: {
          ...state.panesById,
          [targetPaneId]: state.panesById[targetPaneId] ?? createEmptyPaneState(),
        },
        focusedPaneId: targetPaneId,
      };
      return moveTabBetweenPanes(expandedState, action.tabId, action.from, targetPaneId);
    }

    case "TOGGLE_SPLIT":
      return joinAllPanes(state);

    case "SET_SPLIT_ORIENTATION": {
      if (state.root.type !== "split") {
        return state;
      }
      return {
        ...state,
        root: {
          ...state.root,
          orientation: action.orientation,
        },
      };
    }

    case "SET_SPLIT_LAYOUT": {
      const updated = updateSplitNode(state.root, action.nodeId, (splitNode) => ({
        ...splitNode,
        layout: action.layout,
      }));
      return updated.changed
        ? {
            ...state,
            root: updated.nextNode,
          }
        : state;
    }

    case "OPEN_AGENT_CONVERSATION_TAB": {
      const tabId = `conversation:${action.conversationId}`;
      const existingPaneId = findEditorPaneIdByConversationId(state, action.conversationId);
      const desiredTitle = truncateTabName(action.title);
      const target = ensurePaneForTarget(
        state,
        action.group,
        action.group === "right" ? "horizontal" : "horizontal"
      );
      if (existingPaneId) {
        const existingPane = getPaneEntry(target.state, existingPaneId);
        const existingTab = existingPane.tabs.find(
          (tab) => tab.conversationId === action.conversationId
        );
        if (!existingTab) {
          return target.state;
        }
        let nextState = updateTabById(target.state, existingTab.id, (tab) =>
          tab.name === desiredTitle ? tab : { ...tab, name: desiredTitle }
        );
        if (existingPaneId !== target.paneId) {
          nextState = moveTabBetweenPanes(nextState, existingTab.id, existingPaneId, target.paneId);
        }
        return focusTabInPane(nextState, existingPaneId !== target.paneId ? target.paneId : existingPaneId, existingTab.id);
      }
      return addTabToPane(target.state, target.paneId, {
        id: tabId,
        name: desiredTitle,
        language: "markdown",
        icon: "agent",
        content: "",
        conversationId: action.conversationId,
        fileKind: "text",
        previewMode: "source",
      });
    }

    case "OPEN_TRANSCRIPT_TAB": {
      const resolvedSessionId = action.sessionId ?? inferTranscriptSessionId(action.messages);
      const existingTab = getAllEditorTabs(state).find(
        (tab) => resolvedSessionId != null && tab.transcriptSessionId === resolvedSessionId
      );
      const name = truncateTabName(action.title);
      if (existingTab) {
        const paneId = findEditorPaneIdByTabId(state, existingTab.id);
        if (!paneId) {
          return state;
        }
        return focusTabInPane(
          updateTabById(state, existingTab.id, (tab) => ({
            ...tab,
            name,
            transcriptMessages: action.messages,
            transcriptSessionId: resolvedSessionId,
          })),
          paneId,
          existingTab.id
        );
      }
      const id = `subagent-${Date.now().toString(36)}`;
      return openTabInRequestedPane(state, {
        id,
        name,
        language: "markdown",
        icon: "subagent",
        content: "",
        fileKind: "text",
        previewMode: "source",
        transcriptMessages: action.messages,
        transcriptSessionId: resolvedSessionId,
      }, action.group);
    }

    case "OPEN_COMPOSER_DRAFT_TAB": {
      const tabId = `composer-draft:${action.draftId}`;
      const existingPaneId = findEditorPaneIdByTabId(state, tabId);
      const name = truncateTabName(action.title);
      if (existingPaneId) {
        return focusTabInPane(
          updateTabById(state, tabId, (tab) => ({
            ...tab,
            name,
            content: action.content,
            savedContent: action.content,
            dirty: false,
          })),
          existingPaneId,
          tabId
        );
      }
      return openTabInRequestedPane(
        state,
        {
          id: tabId,
          name,
          language: "plaintext",
          icon: "default",
          content: action.content,
          composerDraftId: action.draftId,
          fileKind: "text",
          previewMode: "source",
          dirty: false,
          savedContent: action.content,
        },
        action.group
      );
    }

    case "OPEN_TERMINAL_TAB": {
      const tabId = `terminal:${action.terminalId}`;
      const existingPaneId = findEditorPaneIdByTabId(state, tabId);
      if (existingPaneId) {
        return focusTabInPane(state, existingPaneId, tabId);
      }
      return openTabInRequestedPane(state, {
        id: tabId,
        name: action.name ?? "Terminal",
        language: "shell",
        icon: "terminal",
        content: "",
        terminalId: action.terminalId,
      });
    }

    case "OPEN_BROWSER_TAB": {
      const tabId = `browser:${newIdSegment()}`;
      const targetUrl = normalizeBrowserTargetUrl(action.url).href;
      return openTabInRequestedPane(state, {
        id: tabId,
        name: action.name ?? tabTitleFromUrl(targetUrl),
        language: "html",
        icon: "browser",
        content: "",
        browser: { targetUrl },
      });
    }

    case "UPDATE_BROWSER_TAB_URL": {
      const nextUrl = normalizeBrowserTargetUrl(action.targetUrl).href;
      return updateTabById(state, action.tabId, (tab) =>
        tab.browser
          ? {
              ...tab,
              browser: { targetUrl: nextUrl, faviconUrl: undefined },
              name: tabTitleFromUrl(nextUrl),
            }
          : tab
      );
    }

    case "UPDATE_BROWSER_TAB_FAVICON":
      return updateTabById(state, action.tabId, (tab) =>
        tab.browser
          ? {
              ...tab,
              browser: {
                ...tab.browser,
                faviconUrl: action.faviconUrl ?? undefined,
              },
            }
          : tab
      );

    case "TOGGLE_FILE_PREVIEW": {
      const pane = getPaneEntry(state, state.focusedPaneId);
      const activeTab = pane.tabs.find((tab) => tab.id === pane.activeId);
      if (!activeTab || (activeTab.transcriptMessages && activeTab.transcriptMessages.length > 0)) {
        return state;
      }
      const canPreview = activeTab.language === "markdown" || activeTab.fileKind === "svg";
      if (!canPreview) {
        return state;
      }
      return updateTabById(state, activeTab.id, (tab) => ({
        ...tab,
        previewMode: tab.previewMode === "preview" ? "source" : "preview",
      }));
    }

    case "OPEN_EXPLORER_FILE": {
      const tabId = `explorer:${action.path}`;
      const existingPaneId = findEditorPaneIdByTabId(state, tabId);
      if (existingPaneId) {
        return focusTabInPane(state, existingPaneId, tabId);
      }
      return openTabInRequestedPane(state, {
        id: tabId,
        name: action.name,
        language: action.language,
        icon: action.icon,
        content: action.content ?? "",
        filePath: action.path,
        loading: action.content == null,
        dirty: false,
        savedContent: action.content,
        externalChange: false,
      });
    }

    case "LOAD_FILE_CONTENT":
      return updateTabById(state, action.tabId, (tab) => ({
        ...tab,
        content: action.content,
        language: action.language,
        fileKind: action.fileKind,
        mimeType: action.mimeType,
        previewPath: action.previewPath,
        previewMode: tab.previewMode ?? (action.fileKind === "image" ? "preview" : "source"),
        loading: false,
        dirty: false,
        savedContent: action.content,
        externalChange: false,
        fileContentTruncated: action.fileContentTruncated,
        fileTotalBytes: action.fileTotalBytes,
        fileLoadedThroughByte: action.fileLoadedThroughByte,
      }));

    case "UPDATE_TAB_CONTENT":
      return updateTabById(state, action.tabId, (tab) => ({
        ...tab,
        content: action.content,
        ...(tab.composerDraftId
          ? {
              savedContent: action.content,
              dirty: false,
            }
          : {
              dirty: action.content !== (tab.savedContent ?? ""),
            }),
      }));

    case "MARK_SAVED":
      return updateTabById(state, action.tabId, (tab) => ({
        ...tab,
        content: action.content,
        savedContent: action.content,
        dirty: false,
        externalChange: false,
      }));

    case "FILE_CHANGED_ON_DISK":
      return mapTabsAcrossPanes(state, (tab) =>
        tab.filePath === action.path
          ? {
              ...tab,
              externalChange: tab.dirty ? true : false,
            }
          : tab
      );

    case "CLEAR_EXTERNAL_CHANGE":
      return updateTabById(state, action.tabId, (tab) => ({
        ...tab,
        externalChange: false,
      }));

    case "OPEN_SETTINGS_TAB": {
      const tabId = SETTINGS_EDITOR_TAB_ID;
      const existingPaneId = findEditorPaneIdByTabId(state, tabId);
      if (existingPaneId) {
        return focusTabInPane(state, existingPaneId, tabId);
      }
      return openTabInRequestedPane(state, {
        id: tabId,
        name: "Settings",
        language: "plaintext",
        icon: "settings",
        content: "",
      });
    }

    case "MOVE_TAB":
      return moveTabBetweenPanes(state, action.tabId, action.from, action.to);

    default:
      return state;
  }
}

export const TAB_DND_MIME = "application/x-opencursor-editor-tab";

export function parseTabDragPayload(
  data: string | undefined
): { tabId: string; group: EditorGroup } | null {
  if (!data) {
    return null;
  }
  try {
    const payload = JSON.parse(data) as { tabId?: string; group?: string };
    if (
      typeof payload.tabId === "string" &&
      payload.tabId.length > 0 &&
      typeof payload.group === "string" &&
      payload.group.length > 0
    ) {
      return { tabId: payload.tabId, group: payload.group };
    }
  } catch {
    /* ignore */
  }
  return null;
}
