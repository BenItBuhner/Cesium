import { normalizeBrowserTargetUrl } from "@/lib/browser-proxy-url";
import type { BrowserEngineKind } from "@/lib/browser-engine";
import type {
  BrowserControlLockState,
  BrowserControlViewport,
} from "@/lib/browser-control-types";
import type { ChatMessage, EditorTab, ExplorerOpenRequest } from "@/lib/types";
import type {
  EditorSplitOrientation,
  EditorStripItem,
  EditorTabGroupState,
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

/** UUID when available; otherwise works on non-secure origins (e.g. http://LAN:3000) where `randomUUID` is absent. */
function newIdSegment(): string {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return crypto.randomUUID();
  }
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 11)}`;
}

const DEFAULT_TAB_GROUP_TITLE = "Tab Group";

/**
 * "Tab Group" by default; when that name is already in use in this pane, append
 * the lowest free integer suffix ("Tab Group 2", "Tab Group 3", …). Any numeric
 * suffix the user happens to already have typed is respected — we only reserve
 * slots that look like `Tab Group`, `Tab Group 2`, `Tab Group 3`, ….
 */
function nextDefaultTabGroupTitle(
  groups: Record<string, EditorTabGroupState>
): string {
  const existing = new Set(Object.values(groups).map((g) => g.title));
  if (!existing.has(DEFAULT_TAB_GROUP_TITLE)) {
    return DEFAULT_TAB_GROUP_TITLE;
  }
  for (let n = 2; n < 10_000; n += 1) {
    const candidate = `${DEFAULT_TAB_GROUP_TITLE} ${n}`;
    if (!existing.has(candidate)) {
      return candidate;
    }
  }
  return `${DEFAULT_TAB_GROUP_TITLE} ${Date.now()}`;
}

export type EditorGroup = "left" | "right";

export interface EditorPanelState {
  split: boolean;
  splitOrientation: EditorSplitOrientation;
  splitLayout: Record<string, number> | null;
  /** Which editor column last received explicit focus (tab click or editor body pointer). */
  focusedGroup: EditorGroup;
  leftTabs: EditorTab[];
  rightTabs: EditorTab[];
  leftActiveId: string | null;
  rightActiveId: string | null;
  leftTabGroups: Record<string, EditorTabGroupState>;
  rightTabGroups: Record<string, EditorTabGroupState>;
  leftStripItems: EditorStripItem[];
  rightStripItems: EditorStripItem[];
}

export type EditorPanelAction =
  | { type: "SELECT_TAB"; group: EditorGroup; id: string }
  | { type: "CLOSE_TAB"; group: EditorGroup; id: string }
  | { type: "CLOSE_ALL_GROUP"; group: EditorGroup }
  | { type: "CLOSE_OTHERS_GROUP"; group: EditorGroup }
  | { type: "ENABLE_SPLIT"; orientation?: EditorSplitOrientation; focus?: EditorGroup }
  | { type: "TOGGLE_SPLIT" }
  | { type: "SET_SPLIT_ORIENTATION"; orientation: EditorSplitOrientation }
  | { type: "SET_SPLIT_LAYOUT"; layout: Record<string, number> | null }
  | { type: "MOVE_TAB"; tabId: string; from: EditorGroup; to: EditorGroup }
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
      conversationId?: string;
    }
  | { type: "OPEN_COMPOSER_DRAFT_TAB"; draftId: string; title: string; content: string }
  | {
      type: "OPEN_ORCHESTRATION_BOARD_TAB";
      boardId: string;
      title: string;
      group?: EditorGroup;
    }
  | { type: "OPEN_TERMINAL_TAB"; terminalId: string; name?: string }
  | {
      type: "OPEN_BROWSER_TAB";
      url: string;
      name?: string;
      tabId?: string;
      group?: EditorGroup;
      engine?: BrowserEngineKind;
      debugSessionId?: string | null;
      nativeSessionId?: string | null;
      controlSessionId?: string | null;
      lockState?: BrowserControlLockState;
      viewport?: BrowserControlViewport;
    }
  | {
      type: "OPEN_VSCODE_WEBVIEW_TAB";
      panelId: string;
      extensionId: string;
      viewType: string;
      title: string;
      html: string;
      options?: Record<string, unknown>;
      group?: EditorGroup;
    }
  | {
      type: "UPDATE_VSCODE_WEBVIEW_TAB";
      panelId: string;
      title?: string;
      html?: string;
      options?: Record<string, unknown>;
    }
  | {
      type: "UPDATE_BROWSER_TAB_URL";
      tabId: string;
      targetUrl: string;
      /** Optional page title from the live iframe; falls back to host-derived label. */
      name?: string;
    }
  | { type: "UPDATE_BROWSER_TAB_FAVICON"; tabId: string; faviconUrl: string | null }
  | {
      type: "UPDATE_BROWSER_TAB_META";
      tabId: string;
      engine?: BrowserEngineKind;
      designMode?: boolean;
      devtoolsOpen?: boolean;
      debugSessionId?: string | null;
      nativeSessionId?: string | null;
      devtoolsPath?: string | null;
      controlSessionId?: string | null;
      lockState?: BrowserControlLockState;
      viewport?: BrowserControlViewport;
    }
  | { type: "TOGGLE_FILE_PREVIEW" }
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
  | ({ type: "OPEN_EXPLORER_FILE" } & ExplorerOpenRequest)
  | { type: "CREATE_TAB_GROUP"; pane: EditorGroup; tabId: string }
  | { type: "REMOVE_TAB_FROM_GROUP"; pane: EditorGroup; tabId: string }
  | { type: "TOGGLE_TAB_GROUP_COLLAPSED"; pane: EditorGroup; groupId: string }
  | {
      type: "UPDATE_TAB_GROUP_META";
      pane: EditorGroup;
      groupId: string;
      title?: string;
      color?: string;
    }
  | { type: "UNGROUP_ALL"; pane: EditorGroup; groupId: string }
  | {
      type: "ADD_TAB_TO_GROUP";
      pane: EditorGroup;
      tabId: string;
      groupId: string;
    }
  | {
      type: "REORDER_STRIP";
      pane: EditorGroup;
      fromIndex: number;
      toIndex: number;
    }
  | {
      type: "MOVE_TAB_TO_STRIP_INDEX";
      pane: EditorGroup;
      tabId: string;
      toIndex: number;
    };

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

function normalizePaneStripAndGroups(
  tabs: EditorTab[],
  groups: Record<string, EditorTabGroupState>,
  strip: EditorStripItem[]
): { groups: Record<string, EditorTabGroupState>; strip: EditorStripItem[] } {
  const tabIds = new Set(tabs.map((t) => t.id));

  const nextGroups: Record<string, EditorTabGroupState> = {};
  for (const [id, g] of Object.entries(groups)) {
    const tabIdsInGroup = [...new Set(g.tabIds.filter((tid) => tabIds.has(tid)))];
    if (tabIdsInGroup.length === 0) continue;
    nextGroups[id] = { ...g, id, tabIds: tabIdsInGroup };
  }

  const groupedTabIds = new Set<string>();
  for (const g of Object.values(nextGroups)) {
    for (const tid of g.tabIds) groupedTabIds.add(tid);
  }

  const nextStrip: EditorStripItem[] = [];
  const seenStandalone = new Set<string>();
  const usedGroups = new Set<string>();

  for (const item of strip) {
    if (item.type === "group") {
      if (nextGroups[item.groupId]) {
        nextStrip.push(item);
        usedGroups.add(item.groupId);
      }
    } else {
      if (!tabIds.has(item.tabId)) continue;
      if (groupedTabIds.has(item.tabId)) continue;
      if (seenStandalone.has(item.tabId)) continue;
      seenStandalone.add(item.tabId);
      nextStrip.push(item);
    }
  }

  for (const gid of Object.keys(nextGroups)) {
    if (!usedGroups.has(gid)) {
      nextStrip.push({ type: "group", groupId: gid });
    }
  }

  for (const t of tabs) {
    if (groupedTabIds.has(t.id)) continue;
    if (!seenStandalone.has(t.id)) {
      nextStrip.push({ type: "tab", tabId: t.id });
      seenStandalone.add(t.id);
    }
  }

  return { groups: nextGroups, strip: nextStrip };
}

function dedupeEditorTabs(
  tabs: EditorTab[],
  seenTabIds: Set<string>,
  seenConversationIds: Set<string>
): EditorTab[] {
  const next: EditorTab[] = [];
  for (const tab of tabs) {
    if (seenTabIds.has(tab.id)) {
      continue;
    }
    if (tab.conversationId) {
      if (seenConversationIds.has(tab.conversationId)) {
        continue;
      }
      seenConversationIds.add(tab.conversationId);
    }
    seenTabIds.add(tab.id);
    next.push(tab);
  }
  return next;
}

function normalizeActiveTabId(
  activeId: string | null,
  tabs: EditorTab[]
): string | null {
  if (activeId && tabs.some((tab) => tab.id === activeId)) {
    return activeId;
  }
  return tabs[0]?.id ?? null;
}

export function normalizeEditorPanelState(state: EditorPanelState): EditorPanelState {
  const seenTabIds = new Set<string>();
  const seenConversationIds = new Set<string>();
  const leftTabs = dedupeEditorTabs(
    state.leftTabs,
    seenTabIds,
    seenConversationIds
  );
  const rightTabs = dedupeEditorTabs(
    state.rightTabs,
    seenTabIds,
    seenConversationIds
  );
  const left = normalizePaneStripAndGroups(
    leftTabs,
    state.leftTabGroups,
    state.leftStripItems
  );
  const right = normalizePaneStripAndGroups(
    rightTabs,
    state.rightTabGroups,
    state.rightStripItems
  );
  return {
    ...state,
    leftTabs,
    rightTabs,
    leftActiveId: normalizeActiveTabId(state.leftActiveId, leftTabs),
    rightActiveId: normalizeActiveTabId(state.rightActiveId, rightTabs),
    leftTabGroups: left.groups,
    leftStripItems: left.strip,
    rightTabGroups: right.groups,
    rightStripItems: right.strip,
  };
}

function removeTabIdFromPaneStrip(
  state: EditorPanelState,
  pane: EditorGroup,
  tabId: string
): EditorPanelState {
  const groupsKey = pane === "left" ? "leftTabGroups" : "rightTabGroups";
  const stripKey = pane === "left" ? "leftStripItems" : "rightStripItems";
  const groups: Record<string, EditorTabGroupState> = { ...state[groupsKey] };
  for (const [gid, g] of Object.entries(groups)) {
    if (!g.tabIds.includes(tabId)) continue;
    const tabIds = g.tabIds.filter((id) => id !== tabId);
    if (tabIds.length === 0) {
      delete groups[gid];
    } else {
      groups[gid] = { ...g, tabIds };
    }
  }
  let strip = state[stripKey].filter(
    (it) => !(it.type === "tab" && it.tabId === tabId)
  );
  strip = strip.filter((it) => it.type !== "group" || Boolean(groups[it.groupId]));
  return { ...state, [groupsKey]: groups, [stripKey]: strip };
}

function appendStandaloneTabToStrip(
  state: EditorPanelState,
  pane: EditorGroup,
  tabId: string
): EditorPanelState {
  const stripKey = pane === "left" ? "leftStripItems" : "rightStripItems";
  const strip = [...state[stripKey]];
  if (!strip.some((it) => it.type === "tab" && it.tabId === tabId)) {
    strip.push({ type: "tab", tabId });
  }
  return { ...state, [stripKey]: strip };
}

export function createInitialEditorState(tabs: EditorTab[]): EditorPanelState {
  const leftTabs = tabs.map(stripActive);
  const leftActiveId =
    tabs.find((t) => t.active)?.id ?? tabs[0]?.id ?? null;
  const leftStripItems: EditorStripItem[] = leftTabs.map((t) => ({
    type: "tab",
    tabId: t.id,
  }));
  return normalizeEditorPanelState({
    split: false,
    splitOrientation: "horizontal",
    splitLayout: null,
    focusedGroup: "left",
    leftTabs,
    rightTabs: [],
    leftActiveId,
    rightActiveId: null,
    leftTabGroups: {},
    rightTabGroups: {},
    leftStripItems,
    rightStripItems: [],
  });
}

function collapseEmptySplitIfNeeded(state: EditorPanelState): EditorPanelState {
  if (!state.split) {
    return state;
  }
  const leftCount = state.leftTabs.length;
  const rightCount = state.rightTabs.length;
  if (leftCount > 0 && rightCount > 0) {
    return state;
  }
  if (leftCount === 0 && rightCount === 0) {
    return {
      ...state,
      split: false,
      focusedGroup: "left",
      rightTabs: [],
      leftTabs: [],
      leftActiveId: null,
      rightActiveId: null,
      rightTabGroups: {},
      rightStripItems: [],
    };
  }
  if (leftCount === 0) {
    return {
      ...state,
      split: false,
      focusedGroup: "left",
      leftTabs: state.rightTabs,
      rightTabs: [],
      leftActiveId: state.rightActiveId ?? state.rightTabs[0]?.id ?? null,
      rightActiveId: null,
      leftTabGroups: state.rightTabGroups,
      rightTabGroups: {},
      leftStripItems: state.rightStripItems,
      rightStripItems: [],
    };
  }
  return {
    ...state,
    split: false,
    focusedGroup: "left",
    rightTabs: [],
    leftActiveId: state.leftActiveId ?? state.leftTabs[0]?.id ?? null,
    rightActiveId: null,
    rightTabGroups: {},
    rightStripItems: [],
  };
}

export function editorPanelReducer(
  state: EditorPanelState,
  action: EditorPanelAction
): EditorPanelState {
  const nextState = ((): EditorPanelState => {
  switch (action.type) {
    case "SELECT_TAB": {
      if (action.group === "left") {
        return {
          ...state,
          leftActiveId: action.id,
          focusedGroup: "left",
        };
      }
      return {
        ...state,
        rightActiveId: action.id,
        focusedGroup: "right",
      };
    }

    case "FOCUS_EDITOR_GROUP": {
      if (!state.split && action.group === "right") {
        return { ...state, focusedGroup: "left" };
      }
      return { ...state, focusedGroup: action.group };
    }

    case "CLOSE_TAB": {
      const key = action.group === "left" ? "leftTabs" : "rightTabs";
      const activeKey =
        action.group === "left" ? "leftActiveId" : "rightActiveId";
      const nextTabs = state[key].filter((t) => t.id !== action.id);
      let nextActive = state[activeKey];
      if (nextActive === action.id) {
        nextActive = nextTabs[0]?.id ?? null;
      }
      return collapseEmptySplitIfNeeded({
        ...state,
        [key]: nextTabs,
        [activeKey]: nextActive,
      });
    }

    case "CLOSE_ALL_GROUP": {
      if (action.group === "left") {
        return collapseEmptySplitIfNeeded({
          ...state,
          leftTabs: [],
          leftActiveId: null,
        });
      }
      return collapseEmptySplitIfNeeded({
        ...state,
        rightTabs: [],
        rightActiveId: null,
      });
    }

    case "CLOSE_OTHERS_GROUP": {
      const key = action.group === "left" ? "leftTabs" : "rightTabs";
      const activeKey =
        action.group === "left" ? "leftActiveId" : "rightActiveId";
      const activeId = state[activeKey];
      const keep = state[key].find((t) => t.id === activeId);
      if (!keep) return state;
      return { ...state, [key]: [keep], [activeKey]: activeId };
    }

    case "ENABLE_SPLIT": {
      const nextOrientation = action.orientation ?? state.splitOrientation;
      const nextFocus =
        action.focus ??
        (state.split ? state.focusedGroup : state.rightTabs.length > 0 ? "right" : "left");
      if (state.split) {
        return {
          ...state,
          splitOrientation: nextOrientation,
          focusedGroup: nextFocus,
        };
      }
      return {
        ...state,
        split: true,
        splitOrientation: nextOrientation,
        focusedGroup: nextFocus,
        rightTabs: [],
        rightActiveId: null,
        rightTabGroups: {},
        rightStripItems: [],
      };
    }

    case "TOGGLE_SPLIT": {
      if (state.split) {
        const seen = new Set(state.leftTabs.map((t) => t.id));
        const merged = [
          ...state.leftTabs,
          ...state.rightTabs.filter((t) => !seen.has(t.id)),
        ];
        const leftActiveId =
          state.leftActiveId ??
          merged[0]?.id ??
          state.rightActiveId ??
          null;
        return {
          split: false,
          splitOrientation: state.splitOrientation,
          splitLayout: state.splitLayout,
          focusedGroup: "left",
          leftTabs: merged,
          rightTabs: [],
          leftActiveId,
          rightActiveId: null,
          leftTabGroups: { ...state.leftTabGroups, ...state.rightTabGroups },
          rightTabGroups: {},
          leftStripItems: [...state.leftStripItems, ...state.rightStripItems],
          rightStripItems: [],
        };
      }
      return {
        ...state,
        split: true,
        splitOrientation: state.splitOrientation,
        rightTabs: [],
        rightActiveId: null,
        rightTabGroups: {},
        rightStripItems: [],
      };
    }

    case "OPEN_AGENT_CONVERSATION_TAB": {
      const tabId = `conversation:${action.conversationId}`;
      const name = truncateTabName(action.title);
      const shouldSplitForRight = action.group === "right" && !state.split;
      const splitState = shouldSplitForRight
        ? {
            ...state,
            split: true,
            rightTabs: state.rightTabs,
            rightActiveId: state.rightActiveId,
          }
        : state;
      const existingLeft = state.leftTabs.find(
        (tab) => tab.conversationId === action.conversationId
      );
      const existingRight = state.rightTabs.find(
        (tab) => tab.conversationId === action.conversationId
      );

      if (!state.split && existingLeft && action.group !== "right") {
        return {
          ...state,
          focusedGroup: "left",
          leftActiveId: existingLeft.id,
          leftTabs: state.leftTabs.map((tab) =>
            tab.id === existingLeft.id ? { ...tab, name } : tab
          ),
        };
      }

      const requestedGroup = action.group;
      const targetGroup =
        requestedGroup ??
        (splitState.split && splitState.focusedGroup === "right" ? "right" : "left");

      if (targetGroup === "left" && existingLeft) {
        return {
          ...state,
          focusedGroup: "left",
          leftActiveId: existingLeft.id,
          leftTabs: state.leftTabs.map((tab) =>
            tab.id === existingLeft.id ? { ...tab, name } : tab
          ),
        };
      }

      if (targetGroup === "right" && existingRight) {
        return {
          ...state,
          focusedGroup: "right",
          rightActiveId: existingRight.id,
          rightTabs: state.rightTabs.map((tab) =>
            tab.id === existingRight.id ? { ...tab, name } : tab
          ),
        };
      }

      if (existingLeft && targetGroup === "right" && splitState.split) {
        const movedTab = { ...existingLeft, name };
        const nextLeftTabs = splitState.leftTabs.filter((tab) => tab.id !== existingLeft.id);
        return {
          ...splitState,
          focusedGroup: "right",
          leftTabs: nextLeftTabs,
          rightTabs: [...splitState.rightTabs, movedTab],
          leftActiveId:
            splitState.leftActiveId === existingLeft.id
              ? nextLeftTabs[0]?.id ?? null
              : splitState.leftActiveId,
          rightActiveId: existingLeft.id,
        };
      }

      if (existingRight && targetGroup === "left") {
        const movedTab = { ...existingRight, name };
        const nextRightTabs = state.rightTabs.filter((tab) => tab.id !== existingRight.id);
        return {
          ...state,
          focusedGroup: "left",
          leftTabs: [...state.leftTabs, movedTab],
          rightTabs: nextRightTabs,
          leftActiveId: existingRight.id,
          rightActiveId:
            state.rightActiveId === existingRight.id
              ? nextRightTabs[0]?.id ?? null
              : state.rightActiveId,
        };
      }

      if (!splitState.split && existingRight) {
        const nextRightTabs = splitState.rightTabs.filter((tab) => tab.id !== existingRight.id);
        return {
          ...splitState,
          focusedGroup: "left",
          leftTabs: [...splitState.leftTabs, { ...existingRight, name }],
          rightTabs: nextRightTabs,
          leftActiveId: existingRight.id,
          rightActiveId:
            splitState.rightActiveId === existingRight.id
              ? nextRightTabs[0]?.id ?? null
              : splitState.rightActiveId,
        };
      }

      const tab: EditorTab = {
        id: tabId,
        name,
        language: "markdown",
        icon: "agent",
        content: "",
        conversationId: action.conversationId,
        fileKind: "text",
        previewMode: "source",
      };

      if (!splitState.split || targetGroup === "left") {
        return {
          ...splitState,
          focusedGroup: "left",
          leftTabs: [...splitState.leftTabs, tab],
          leftActiveId: tabId,
        };
      }

      return {
        ...splitState,
        focusedGroup: "right",
        rightTabs: [...splitState.rightTabs, tab],
        rightActiveId: tabId,
      };
    }

    case "SET_SPLIT_ORIENTATION": {
      return {
        ...state,
        splitOrientation: action.orientation,
      };
    }

    case "SET_SPLIT_LAYOUT": {
      return {
        ...state,
        splitLayout: action.layout,
      };
    }

    case "OPEN_TRANSCRIPT_TAB": {
      const resolvedSessionId = action.sessionId ?? inferTranscriptSessionId(action.messages);
      const existingLeft =
        resolvedSessionId != null
          ? state.leftTabs.find((tab) => tab.transcriptSessionId === resolvedSessionId)
          : undefined;
      const existingRight =
        resolvedSessionId != null
          ? state.rightTabs.find((tab) => tab.transcriptSessionId === resolvedSessionId)
          : undefined;
      const id = `subagent-${Date.now().toString(36)}`;
      const name = truncateTabName(action.title);
      if (existingLeft) {
        return {
          ...state,
          focusedGroup: "left",
          leftActiveId: existingLeft.id,
          leftTabs: state.leftTabs.map((tab) =>
            tab.id === existingLeft.id
              ? {
                  ...tab,
                  name,
                  transcriptMessages: action.messages,
                  transcriptSessionId: resolvedSessionId,
                  transcriptLiveConversationId: action.conversationId,
                }
              : tab
          ),
        };
      }
      if (existingRight) {
        return {
          ...state,
          focusedGroup: "right",
          rightActiveId: existingRight.id,
          rightTabs: state.rightTabs.map((tab) =>
            tab.id === existingRight.id
              ? {
                  ...tab,
                  name,
                  transcriptMessages: action.messages,
                  transcriptSessionId: resolvedSessionId,
                  transcriptLiveConversationId: action.conversationId,
                }
              : tab
          ),
        };
      }
      const tab: EditorTab = {
        id,
        name,
        language: "markdown",
        icon: "subagent",
        content: "",
        fileKind: "text",
        previewMode: "source",
        transcriptMessages: action.messages,
        transcriptSessionId: resolvedSessionId,
        transcriptLiveConversationId: action.conversationId,
      };
      return {
        ...state,
        leftTabs: [...state.leftTabs, tab],
        leftActiveId: id,
      };
    }

    case "OPEN_COMPOSER_DRAFT_TAB": {
      const tabId = `composer-draft:${action.draftId}`;
      const existingLeft = state.leftTabs.find((tab) => tab.id === tabId);
      const existingRight = state.rightTabs.find((tab) => tab.id === tabId);
      const name = truncateTabName(action.title);
      if (existingLeft) {
        return {
          ...state,
          focusedGroup: "left",
          leftActiveId: tabId,
          leftTabs: state.leftTabs.map((tab) =>
            tab.id === tabId
              ? {
                  ...tab,
                  name,
                  content: action.content,
                  savedContent: action.content,
                  dirty: false,
                }
              : tab
          ),
        };
      }
      if (existingRight) {
        return {
          ...state,
          focusedGroup: "right",
          rightActiveId: tabId,
          rightTabs: state.rightTabs.map((tab) =>
            tab.id === tabId
              ? {
                  ...tab,
                  name,
                  content: action.content,
                  savedContent: action.content,
                  dirty: false,
                }
              : tab
          ),
        };
      }
      const tab: EditorTab = {
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
      };
      if (!state.split || state.focusedGroup === "left") {
        return {
          ...state,
          focusedGroup: "left",
          leftTabs: [...state.leftTabs, tab],
          leftActiveId: tabId,
        };
      }
      return {
        ...state,
        focusedGroup: "right",
        rightTabs: [...state.rightTabs, tab],
        rightActiveId: tabId,
      };
    }

    case "OPEN_ORCHESTRATION_BOARD_TAB": {
      const tabId = `orchestration:${action.boardId}`;
      const existingLeft = state.leftTabs.find((tab) => tab.id === tabId);
      const existingRight = state.rightTabs.find((tab) => tab.id === tabId);
      const name = truncateTabName(action.title);
      if (existingLeft && action.group !== "right") {
        return {
          ...state,
          focusedGroup: "left",
          leftActiveId: tabId,
          leftTabs: state.leftTabs.map((tab) =>
            tab.id === tabId ? { ...tab, name } : tab
          ),
        };
      }
      if (existingRight && action.group !== "left") {
        return {
          ...state,
          focusedGroup: "right",
          rightActiveId: tabId,
          rightTabs: state.rightTabs.map((tab) =>
            tab.id === tabId ? { ...tab, name } : tab
          ),
        };
      }
      const tab: EditorTab = {
        id: tabId,
        name,
        language: "json",
        icon: "kanban",
        content: "",
        orchestrationBoard: { boardId: action.boardId },
      };
      const targetGroup =
        action.group ?? (state.split && state.focusedGroup === "right" ? "right" : "left");
      if (targetGroup === "right") {
        const splitState = state.split ? state : { ...state, split: true };
        return {
          ...splitState,
          focusedGroup: "right",
          rightTabs: [...splitState.rightTabs, tab],
          rightActiveId: tabId,
        };
      }
      return {
        ...state,
        focusedGroup: "left",
        leftTabs: [...state.leftTabs, tab],
        leftActiveId: tabId,
      };
    }

    case "OPEN_TERMINAL_TAB": {
      const tabId = `terminal:${action.terminalId}`;
      const existingLeft = state.leftTabs.find((tab) => tab.id === tabId);
      const existingRight = state.rightTabs.find((tab) => tab.id === tabId);
      if (existingLeft) {
        return { ...state, leftActiveId: tabId, focusedGroup: "left" };
      }
      if (existingRight) {
        return { ...state, rightActiveId: tabId, focusedGroup: "right" };
      }

      const tab: EditorTab = {
        id: tabId,
        name: action.name ?? "Terminal",
        language: "shell",
        icon: "terminal",
        content: "",
        terminalId: action.terminalId,
      };

      if (!state.split || state.focusedGroup === "left") {
        return {
          ...state,
          focusedGroup: "left",
          leftTabs: [...state.leftTabs, tab],
          leftActiveId: tabId,
        };
      }

      return {
        ...state,
        focusedGroup: "right",
        rightTabs: [...state.rightTabs, tab],
        rightActiveId: tabId,
      };
    }

    case "OPEN_BROWSER_TAB": {
      const tabId = action.tabId ?? `browser:${newIdSegment()}`;
      const targetUrl = normalizeBrowserTargetUrl(action.url).href;
      const tab: EditorTab = {
        id: tabId,
        name: action.name ?? tabTitleFromUrl(targetUrl),
        language: "html",
        icon: "browser",
        content: "",
        browser: {
          targetUrl,
          engine: action.engine ?? "proxy",
          designMode: false,
          devtoolsOpen: false,
          debugSessionId: action.debugSessionId ?? null,
          nativeSessionId: action.nativeSessionId ?? null,
          devtoolsPath: null,
          controlSessionId: action.controlSessionId ?? null,
          lockState: action.lockState,
          viewport: action.viewport,
        },
      };

      const targetGroup = action.group ?? state.focusedGroup;
      if (!state.split || targetGroup === "left") {
        return {
          ...state,
          focusedGroup: "left",
          leftTabs: [...state.leftTabs, tab],
          leftActiveId: tabId,
        };
      }

      return {
        ...state,
        focusedGroup: "right",
        rightTabs: [...state.rightTabs, tab],
        rightActiveId: tabId,
      };
    }

    case "OPEN_VSCODE_WEBVIEW_TAB": {
      const tabId = action.panelId;
      const name = truncateTabName(action.title);
      const patch = (tab: EditorTab): EditorTab =>
        tab.id === tabId
          ? {
              ...tab,
              name,
              vscodeWebview: {
                panelId: action.panelId,
                extensionId: action.extensionId,
                viewType: action.viewType,
                html: action.html,
                options: action.options,
              },
            }
          : tab;
      const existingLeft = state.leftTabs.some((tab) => tab.id === tabId);
      if (existingLeft && action.group !== "right") {
        return {
          ...state,
          focusedGroup: "left",
          leftActiveId: tabId,
          leftTabs: state.leftTabs.map(patch),
        };
      }
      const existingRight = state.rightTabs.some((tab) => tab.id === tabId);
      if (existingRight && action.group !== "left") {
        return {
          ...state,
          focusedGroup: "right",
          rightActiveId: tabId,
          rightTabs: state.rightTabs.map(patch),
        };
      }
      const tab: EditorTab = {
        id: tabId,
        name,
        language: "html",
        icon: "browser",
        content: action.html,
        vscodeWebview: {
          panelId: action.panelId,
          extensionId: action.extensionId,
          viewType: action.viewType,
          html: action.html,
          options: action.options,
        },
      };
      const targetGroup = action.group ?? state.focusedGroup;
      if (!state.split || targetGroup === "left") {
        return {
          ...state,
          focusedGroup: "left",
          leftTabs: [...state.leftTabs, tab],
          leftActiveId: tabId,
        };
      }
      return {
        ...state,
        focusedGroup: "right",
        rightTabs: [...state.rightTabs, tab],
        rightActiveId: tabId,
      };
    }

    case "UPDATE_VSCODE_WEBVIEW_TAB": {
      const patch = (tabs: EditorTab[]) =>
        tabs.map((tab) => {
          if (tab.id !== action.panelId || !tab.vscodeWebview) {
            return tab;
          }
          const name = action.title ? truncateTabName(action.title) : tab.name;
          const html = action.html ?? tab.vscodeWebview.html;
          return {
            ...tab,
            name,
            content: html,
            vscodeWebview: {
              ...tab.vscodeWebview,
              html,
              ...(action.options ? { options: action.options } : {}),
            },
          };
        });
      return {
        ...state,
        leftTabs: patch(state.leftTabs),
        rightTabs: patch(state.rightTabs),
      };
    }

    case "UPDATE_BROWSER_TAB_URL": {
      const nextUrl = normalizeBrowserTargetUrl(action.targetUrl).href;
      // Keep any attached DevTools session alive across URL changes — the
      // BrowserTab component drives the Chromium page via CDP (`page.goto`)
      // and the DevTools frontend stays attached to the same target, so
      // wiping `devtoolsOpen/debugSessionId/devtoolsPath` here would tear
      // down the console on every address-bar navigation. Fresh tabs start
      // clean via `OPEN_BROWSER_TAB` instead.
      const incomingName = action.name?.trim();
      const patch = (tabs: EditorTab[]) =>
        tabs.map((t) => {
          if (t.id !== action.tabId || !t.browser) return t;
          const urlChanged = t.browser.targetUrl !== nextUrl;
          // Name resolution precedence:
          //   1. an explicit non-empty `action.name` always wins (live
          //      document.title from the iframe);
          //   2. when the URL itself changed, fall back to the host-derived
          //      label (fresh tab / address-bar nav to a new site);
          //   3. when it's a same-URL refresh from a nav message that didn't
          //      include a title, keep whatever label we already showed —
          //      otherwise SPA transitions that briefly null out
          //      document.title would flash the tab back to the hostname.
          const resolvedName = incomingName
            ? incomingName
            : urlChanged
              ? tabTitleFromUrl(nextUrl)
              : t.name;
          return {
            ...t,
            browser: {
              ...t.browser,
              targetUrl: nextUrl,
              // Only clear the favicon when the URL itself changed. If the
              // iframe is just reporting a new page title for the SAME URL,
              // preserve the existing icon instead of flashing back to the
              // generic globe.
              faviconUrl: urlChanged ? undefined : t.browser.faviconUrl,
            },
            name: resolvedName,
          };
        });
      return {
        ...state,
        leftTabs: patch(state.leftTabs),
        rightTabs: patch(state.rightTabs),
      };
    }

    case "UPDATE_BROWSER_TAB_FAVICON": {
      const patch = (tabs: EditorTab[]) =>
        tabs.map((t) =>
          t.id === action.tabId && t.browser
            ? {
                ...t,
                browser: {
                  ...t.browser,
                  faviconUrl: action.faviconUrl ?? undefined,
                },
              }
            : t
        );
      return {
        ...state,
        leftTabs: patch(state.leftTabs),
        rightTabs: patch(state.rightTabs),
      };
    }

    case "UPDATE_BROWSER_TAB_META": {
      const { tabId, engine, designMode, devtoolsOpen, debugSessionId, nativeSessionId, devtoolsPath } =
        action;
      const patch = (tabs: EditorTab[]) =>
        tabs.map((t) => {
          if (t.id !== tabId || !t.browser) return t;
          const nextBrowser = { ...t.browser };
          if (engine !== undefined) nextBrowser.engine = engine;
          if (designMode !== undefined) nextBrowser.designMode = designMode;
          if (devtoolsOpen !== undefined) nextBrowser.devtoolsOpen = devtoolsOpen;
          if (debugSessionId !== undefined) nextBrowser.debugSessionId = debugSessionId;
          if (nativeSessionId !== undefined) nextBrowser.nativeSessionId = nativeSessionId;
          if (devtoolsPath !== undefined) nextBrowser.devtoolsPath = devtoolsPath;
          if (action.controlSessionId !== undefined) nextBrowser.controlSessionId = action.controlSessionId;
          if (action.lockState !== undefined) nextBrowser.lockState = action.lockState;
          if (action.viewport !== undefined) nextBrowser.viewport = action.viewport;
          return { ...t, browser: nextBrowser };
        });
      return {
        ...state,
        leftTabs: patch(state.leftTabs),
        rightTabs: patch(state.rightTabs),
      };
    }

    case "TOGGLE_FILE_PREVIEW": {
      const group = state.focusedGroup;
      const tabs = group === "left" ? state.leftTabs : state.rightTabs;
      const activeId =
        group === "left" ? state.leftActiveId : state.rightActiveId;
      const tab = tabs.find((t) => t.id === activeId);
      if (!tab || (tab.transcriptMessages && tab.transcriptMessages.length > 0)) {
        return state;
      }

      const canPreview =
        tab.language === "markdown" ||
        tab.fileKind === "svg";
      if (!canPreview) {
        return state;
      }

      const nextPreviewMode: EditorTab["previewMode"] =
        tab.previewMode === "preview" ? "source" : "preview";
      const next = tabs.map((t) =>
        t.id === activeId
          ? {
              ...t,
              previewMode: nextPreviewMode,
            }
          : t
      );
      if (group === "left") return { ...state, leftTabs: next };
      return { ...state, rightTabs: next };
    }

    case "OPEN_EXPLORER_FILE": {
      const tabId = `explorer:${action.path}`;
      const existingLeft = state.leftTabs.find((t) => t.id === tabId);
      const existingRight = state.rightTabs.find((t) => t.id === tabId);
      if (existingLeft) {
        return { ...state, leftActiveId: tabId, focusedGroup: "left" };
      }
      if (existingRight) {
        return { ...state, rightActiveId: tabId, focusedGroup: "right" };
      }
      const tab: EditorTab = {
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
      };
      if (!state.split) {
        return {
          ...state,
          focusedGroup: "left",
          leftTabs: [...state.leftTabs, tab],
          leftActiveId: tabId,
        };
      }
      if (state.focusedGroup === "left") {
        return {
          ...state,
          leftTabs: [...state.leftTabs, tab],
          leftActiveId: tabId,
        };
      }
      return {
        ...state,
        rightTabs: [...state.rightTabs, tab],
        rightActiveId: tabId,
      };
    }

    case "LOAD_FILE_CONTENT": {
      const updateTab = (tab: EditorTab): EditorTab =>
        tab.id === action.tabId
          ? {
              ...tab,
              content: action.content,
              language: action.language,
              fileKind: action.fileKind,
              mimeType: action.mimeType,
              previewPath: action.previewPath,
              previewMode:
                tab.previewMode ??
                (action.fileKind === "image" ? "preview" : "source"),
              loading: false,
              dirty: false,
              savedContent: action.content,
              externalChange: false,
              fileContentTruncated: action.fileContentTruncated,
              fileTotalBytes: action.fileTotalBytes,
              fileLoadedThroughByte: action.fileLoadedThroughByte,
            }
          : tab;
      return {
        ...state,
        leftTabs: state.leftTabs.map(updateTab),
        rightTabs: state.rightTabs.map(updateTab),
      };
    }

    case "UPDATE_TAB_CONTENT": {
      const updateTab = (tab: EditorTab): EditorTab =>
        tab.id === action.tabId
          ? {
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
            }
          : tab;
      return {
        ...state,
        leftTabs: state.leftTabs.map(updateTab),
        rightTabs: state.rightTabs.map(updateTab),
      };
    }

    case "MARK_SAVED": {
      const updateTab = (tab: EditorTab): EditorTab =>
        tab.id === action.tabId
          ? {
              ...tab,
              content: action.content,
              savedContent: action.content,
              dirty: false,
              externalChange: false,
            }
          : tab;
      return {
        ...state,
        leftTabs: state.leftTabs.map(updateTab),
        rightTabs: state.rightTabs.map(updateTab),
      };
    }

    case "FILE_CHANGED_ON_DISK": {
      const updateTab = (tab: EditorTab): EditorTab =>
        tab.filePath === action.path
          ? {
              ...tab,
              externalChange: tab.dirty ? true : false,
            }
          : tab;
      return {
        ...state,
        leftTabs: state.leftTabs.map(updateTab),
        rightTabs: state.rightTabs.map(updateTab),
      };
    }

    case "CLEAR_EXTERNAL_CHANGE": {
      const updateTab = (tab: EditorTab): EditorTab =>
        tab.id === action.tabId
          ? {
              ...tab,
              externalChange: false,
            }
          : tab;
      return {
        ...state,
        leftTabs: state.leftTabs.map(updateTab),
        rightTabs: state.rightTabs.map(updateTab),
      };
    }

    case "MOVE_TAB": {
      const { tabId, from, to } = action;
      if (from === to) return state;
      const srcKey = from === "left" ? "leftTabs" : "rightTabs";
      const dstKey = to === "left" ? "leftTabs" : "rightTabs";
      const src = state[srcKey];
      const dst = state[dstKey];
      const tab = src.find((t) => t.id === tabId);
      if (!tab) return state;
      let next = removeTabIdFromPaneStrip(state, from, tabId);
      const newSrc = next[srcKey].filter((t) => t.id !== tabId);
      const newDst = [...next[dstKey], tab];
      let leftActiveId = next.leftActiveId;
      let rightActiveId = next.rightActiveId;
      if (from === "left") {
        if (leftActiveId === tabId) {
          leftActiveId = newSrc[0]?.id ?? null;
        }
      } else if (rightActiveId === tabId) {
        rightActiveId = newSrc[0]?.id ?? null;
      }
      if (to === "left") {
        leftActiveId = tabId;
      } else {
        rightActiveId = tabId;
      }
      next = {
        ...next,
        [srcKey]: newSrc,
        [dstKey]: newDst,
        leftActiveId,
        rightActiveId,
        focusedGroup: to,
      };
      next = appendStandaloneTabToStrip(next, to, tabId);
      return next;
    }

    case "CREATE_TAB_GROUP": {
      const { pane, tabId } = action;
      const tabsKey = pane === "left" ? "leftTabs" : "rightTabs";
      if (!state[tabsKey].some((t) => t.id === tabId)) return state;
      const next = removeTabIdFromPaneStrip(state, pane, tabId);
      const groupsKey = pane === "left" ? "leftTabGroups" : "rightTabGroups";
      const stripKey = pane === "left" ? "leftStripItems" : "rightStripItems";
      const gid = `tg-${newIdSegment()}`;
      const title = nextDefaultTabGroupTitle(next[groupsKey]);
      const groups = {
        ...next[groupsKey],
        [gid]: {
          id: gid,
          title,
          color: "blue",
          collapsed: false,
          tabIds: [tabId],
        } satisfies EditorTabGroupState,
      };
      const strip = [...next[stripKey], { type: "group" as const, groupId: gid }];
      return { ...next, [groupsKey]: groups, [stripKey]: strip };
    }

    case "REMOVE_TAB_FROM_GROUP": {
      const { pane, tabId } = action;
      const tabsKey = pane === "left" ? "leftTabs" : "rightTabs";
      if (!state[tabsKey].some((t) => t.id === tabId)) return state;
      const groupsKey = pane === "left" ? "leftTabGroups" : "rightTabGroups";
      const stripKey = pane === "left" ? "leftStripItems" : "rightStripItems";
      let groupId: string | null = null;
      let g: EditorTabGroupState | null = null;
      for (const [gid, gr] of Object.entries(state[groupsKey])) {
        if (gr.tabIds.includes(tabId)) {
          groupId = gid;
          g = gr;
          break;
        }
      }
      if (!groupId || !g) return state;
      const stripIdx = state[stripKey].findIndex(
        (it) => it.type === "group" && it.groupId === groupId
      );
      const newTabIds = g.tabIds.filter((id) => id !== tabId);
      const groups = { ...state[groupsKey] };
      let strip = [...state[stripKey]];
      if (newTabIds.length === 0) {
        delete groups[groupId];
        strip = strip.filter((it) => !(it.type === "group" && it.groupId === groupId));
        const insertAt = stripIdx >= 0 ? stripIdx : strip.length;
        strip.splice(insertAt, 0, { type: "tab", tabId });
      } else {
        groups[groupId] = { ...g, tabIds: newTabIds };
        const insertAt = stripIdx >= 0 ? stripIdx + 1 : strip.length;
        strip.splice(insertAt, 0, { type: "tab", tabId });
      }
      return { ...state, [groupsKey]: groups, [stripKey]: strip };
    }

    case "TOGGLE_TAB_GROUP_COLLAPSED": {
      const { pane, groupId } = action;
      const groupsKey = pane === "left" ? "leftTabGroups" : "rightTabGroups";
      const g = state[groupsKey][groupId];
      if (!g) return state;
      return {
        ...state,
        [groupsKey]: {
          ...state[groupsKey],
          [groupId]: { ...g, collapsed: !g.collapsed },
        },
      };
    }

    case "UPDATE_TAB_GROUP_META": {
      const { pane, groupId, title, color } = action;
      const groupsKey = pane === "left" ? "leftTabGroups" : "rightTabGroups";
      const g = state[groupsKey][groupId];
      if (!g) return state;
      return {
        ...state,
        [groupsKey]: {
          ...state[groupsKey],
          [groupId]: {
            ...g,
            ...(title !== undefined ? { title } : {}),
            ...(color !== undefined ? { color } : {}),
          },
        },
      };
    }

    case "UNGROUP_ALL": {
      const { pane, groupId } = action;
      const groupsKey = pane === "left" ? "leftTabGroups" : "rightTabGroups";
      const stripKey = pane === "left" ? "leftStripItems" : "rightStripItems";
      const g = state[groupsKey][groupId];
      if (!g) return state;
      const stripIdx = state[stripKey].findIndex(
        (it) => it.type === "group" && it.groupId === groupId
      );
      const groups = { ...state[groupsKey] };
      delete groups[groupId];
      let strip = state[stripKey].filter(
        (it) => !(it.type === "group" && it.groupId === groupId)
      );
      const at = stripIdx >= 0 ? stripIdx : strip.length;
      const toInsert: EditorStripItem[] = g.tabIds.map((tabId) => ({
        type: "tab",
        tabId,
      }));
      strip = [...strip.slice(0, at), ...toInsert, ...strip.slice(at)];
      return { ...state, [groupsKey]: groups, [stripKey]: strip };
    }

    case "ADD_TAB_TO_GROUP": {
      const { pane, tabId, groupId } = action;
      const tabsKey = pane === "left" ? "leftTabs" : "rightTabs";
      const groupsKey = pane === "left" ? "leftTabGroups" : "rightTabGroups";
      const stripKey = pane === "left" ? "leftStripItems" : "rightStripItems";
      if (!state[tabsKey].some((t) => t.id === tabId)) return state;
      const target = state[groupsKey][groupId];
      if (!target) return state;
      let next = removeTabIdFromPaneStrip(state, pane, tabId);
      const g = next[groupsKey][groupId];
      if (!g) return state;
      const tabIds = g.tabIds.includes(tabId) ? g.tabIds : [...g.tabIds, tabId];
      next = {
        ...next,
        [groupsKey]: { ...next[groupsKey], [groupId]: { ...g, tabIds } },
      };
      const strip = [...next[stripKey]];
      if (!strip.some((it) => it.type === "group" && it.groupId === groupId)) {
        strip.push({ type: "group", groupId });
      }
      return { ...next, [stripKey]: strip };
    }

    case "REORDER_STRIP": {
      const { pane, fromIndex, toIndex } = action;
      const stripKey = pane === "left" ? "leftStripItems" : "rightStripItems";
      const strip = [...state[stripKey]];
      if (
        fromIndex < 0 ||
        fromIndex >= strip.length ||
        toIndex < 0 ||
        toIndex >= strip.length ||
        fromIndex === toIndex
      ) {
        return state;
      }
      const [moved] = strip.splice(fromIndex, 1);
      strip.splice(toIndex, 0, moved);
      return { ...state, [stripKey]: strip };
    }

    case "MOVE_TAB_TO_STRIP_INDEX": {
      const { pane, tabId, toIndex } = action;
      const tabsKey = pane === "left" ? "leftTabs" : "rightTabs";
      if (!state[tabsKey].some((t) => t.id === tabId)) return state;
      const next = removeTabIdFromPaneStrip(state, pane, tabId);
      const stripKey = pane === "left" ? "leftStripItems" : "rightStripItems";
      const strip = [...next[stripKey]];
      const clamped = Math.max(0, Math.min(toIndex, strip.length));
      strip.splice(clamped, 0, { type: "tab", tabId });
      return { ...next, [stripKey]: strip };
    }

    default:
      return state;
  }
  })();
  return normalizeEditorPanelState(nextState);
}

const TAB_GROUP_COLOR_HEX: Record<string, string> = {
  blue: "#3b82f6",
  green: "#22c55e",
  violet: "#8b5cf6",
  amber: "#f59e0b",
  rose: "#f43f5e",
  cyan: "#06b6d4",
  orange: "#f97316",
  slate: "#64748b",
};

export const TAB_GROUP_COLOR_PRESET_IDS = Object.keys(TAB_GROUP_COLOR_HEX);

export function resolveTabGroupColorHex(color: string): string {
  if (color.startsWith("#") && /^#[0-9a-fA-F]{6}$/.test(color)) {
    return color;
  }
  return TAB_GROUP_COLOR_HEX[color] ?? TAB_GROUP_COLOR_HEX.blue;
}

export const TAB_DND_MIME = "application/x-opencursor-editor-tab";

export function parseTabDragPayload(
  data: string | undefined
): {
  tabId: string;
  group: EditorGroup;
  fromGroupId?: string | null;
  stripIndex?: number | null;
} | null {
  if (!data) return null;
  try {
    const o = JSON.parse(data) as {
      tabId?: string;
      group?: string;
      fromGroupId?: string | null;
      stripIndex?: number | null;
    };
    if (
      o.tabId &&
      (o.group === "left" || o.group === "right")
    ) {
      return {
        tabId: o.tabId,
        group: o.group,
        fromGroupId:
          typeof o.fromGroupId === "string"
            ? o.fromGroupId
            : o.fromGroupId === null
              ? null
              : undefined,
        stripIndex:
          typeof o.stripIndex === "number"
            ? o.stripIndex
            : o.stripIndex === null
              ? null
              : undefined,
      };
    }
  } catch {
    /* ignore */
  }
  return null;
}
