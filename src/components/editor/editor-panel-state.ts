import type { ChatMessage, EditorTab, ExplorerOpenRequest } from "@/lib/types";

/** Stable id for the in-editor Settings view (command palette, Ctrl+,). */
export const SETTINGS_EDITOR_TAB_ID = "workbench.settings";

export type EditorGroup = "left" | "right";

export interface EditorPanelState {
  split: boolean;
  /** Which editor column last received explicit focus (tab click or editor body pointer). */
  focusedGroup: EditorGroup;
  leftTabs: EditorTab[];
  rightTabs: EditorTab[];
  leftActiveId: string | null;
  rightActiveId: string | null;
}

export type EditorPanelAction =
  | { type: "SELECT_TAB"; group: EditorGroup; id: string }
  | { type: "CLOSE_TAB"; group: EditorGroup; id: string }
  | { type: "CLOSE_ALL_GROUP"; group: EditorGroup }
  | { type: "CLOSE_OTHERS_GROUP"; group: EditorGroup }
  | { type: "TOGGLE_SPLIT" }
  | { type: "MOVE_TAB"; tabId: string; from: EditorGroup; to: EditorGroup }
  | { type: "FOCUS_EDITOR_GROUP"; group: EditorGroup }
  | { type: "OPEN_TRANSCRIPT_TAB"; title: string; messages: ChatMessage[] }
  | { type: "TOGGLE_MARKDOWN_PREVIEW" }
  | { type: "OPEN_SETTINGS_TAB" }
  | ({ type: "OPEN_EXPLORER_FILE" } & ExplorerOpenRequest);

function stripActive(tab: EditorTab): EditorTab {
  const { active: _a, ...rest } = tab;
  return rest;
}

export function createInitialEditorState(tabs: EditorTab[]): EditorPanelState {
  const leftTabs = tabs.map(stripActive);
  const leftActiveId =
    tabs.find((t) => t.active)?.id ?? tabs[0]?.id ?? null;
  return {
    split: false,
    focusedGroup: "left",
    leftTabs,
    rightTabs: [],
    leftActiveId,
    rightActiveId: null,
  };
}

export function editorPanelReducer(
  state: EditorPanelState,
  action: EditorPanelAction
): EditorPanelState {
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
      return { ...state, [key]: nextTabs, [activeKey]: nextActive };
    }

    case "CLOSE_ALL_GROUP": {
      if (action.group === "left") {
        return { ...state, leftTabs: [], leftActiveId: null };
      }
      return { ...state, rightTabs: [], rightActiveId: null };
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
          focusedGroup: "left",
          leftTabs: merged,
          rightTabs: [],
          leftActiveId,
          rightActiveId: null,
        };
      }
      return {
        ...state,
        split: true,
        rightTabs: [],
        rightActiveId: null,
      };
    }

    case "OPEN_TRANSCRIPT_TAB": {
      const id = `subagent-${Date.now().toString(36)}`;
      const name =
        action.title.length > 40
          ? `${action.title.slice(0, 37)}…`
          : action.title;
      const tab: EditorTab = {
        id,
        name,
        language: "markdown",
        icon: "markdown",
        content: "",
        transcriptMessages: action.messages,
      };
      return {
        ...state,
        leftTabs: [...state.leftTabs, tab],
        leftActiveId: id,
      };
    }

    case "TOGGLE_MARKDOWN_PREVIEW": {
      const group = state.focusedGroup;
      const tabs = group === "left" ? state.leftTabs : state.rightTabs;
      const activeId =
        group === "left" ? state.leftActiveId : state.rightActiveId;
      const tab = tabs.find((t) => t.id === activeId);
      if (
        !tab ||
        tab.language !== "markdown" ||
        (tab.transcriptMessages && tab.transcriptMessages.length > 0)
      ) {
        return state;
      }
      const next = tabs.map((t) =>
        t.id === activeId
          ? { ...t, markdownPreview: !t.markdownPreview }
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
        content: action.content,
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

    case "OPEN_SETTINGS_TAB": {
      const tabId = SETTINGS_EDITOR_TAB_ID;
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
        name: "Settings",
        language: "plaintext",
        icon: "settings",
        content: "",
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

    case "MOVE_TAB": {
      const { tabId, from, to } = action;
      if (from === to) return state;
      const srcKey = from === "left" ? "leftTabs" : "rightTabs";
      const dstKey = to === "left" ? "leftTabs" : "rightTabs";
      const src = state[srcKey];
      const dst = state[dstKey];
      const tab = src.find((t) => t.id === tabId);
      if (!tab) return state;
      const newSrc = src.filter((t) => t.id !== tabId);
      const newDst = [...dst, tab];
      let leftActiveId = state.leftActiveId;
      let rightActiveId = state.rightActiveId;
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
      return {
        ...state,
        [srcKey]: newSrc,
        [dstKey]: newDst,
        leftActiveId,
        rightActiveId,
        focusedGroup: to,
      };
    }

    default:
      return state;
  }
}

export const TAB_DND_MIME = "application/x-opencursor-editor-tab";

export function parseTabDragPayload(
  data: string | undefined
): { tabId: string; group: EditorGroup } | null {
  if (!data) return null;
  try {
    const o = JSON.parse(data) as { tabId?: string; group?: string };
    if (
      o.tabId &&
      (o.group === "left" || o.group === "right")
    ) {
      return { tabId: o.tabId, group: o.group };
    }
  } catch {
    /* ignore */
  }
  return null;
}
