import { normalizeBrowserTargetUrl } from "@/lib/browser-proxy-url";
import type { ChatMessage, EditorTab, ExplorerOpenRequest } from "@/lib/types";
import type { EditorSplitOrientation } from "@/lib/workspace-session";

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

/** Stable id for the in-editor Settings view (command palette, Ctrl+,). */
export const SETTINGS_EDITOR_TAB_ID = "workbench.settings";

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
    }
  | { type: "OPEN_COMPOSER_DRAFT_TAB"; draftId: string; title: string; content: string }
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
  const leftActiveId =
    tabs.find((t) => t.active)?.id ?? tabs[0]?.id ?? null;
  return {
    split: false,
    splitOrientation: "horizontal",
    splitLayout: null,
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
        };
      }
      return {
        ...state,
        split: true,
        splitOrientation: state.splitOrientation,
        rightTabs: [],
        rightActiveId: null,
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
      const tabId = `browser:${newIdSegment()}`;
      const targetUrl = normalizeBrowserTargetUrl(action.url).href;
      const tab: EditorTab = {
        id: tabId,
        name: action.name ?? tabTitleFromUrl(targetUrl),
        language: "html",
        icon: "browser",
        content: "",
        browser: { targetUrl },
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

    case "UPDATE_BROWSER_TAB_URL": {
      const nextUrl = normalizeBrowserTargetUrl(action.targetUrl).href;
      const patch = (tabs: EditorTab[]) =>
        tabs.map((t) =>
          t.id === action.tabId && t.browser
            ? {
                ...t,
                browser: { targetUrl: nextUrl, faviconUrl: undefined },
                name: tabTitleFromUrl(nextUrl),
              }
            : t
        );
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
