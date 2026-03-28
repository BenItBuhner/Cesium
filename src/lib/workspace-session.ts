import type {
  ChatTab,
  EditorTab,
  EditorMode,
  ModelInfo,
} from "@/lib/types";
import type { AgentBackendId } from "@/lib/agent-types";

export type SidebarView = "explorer" | "search" | "scm";
export type MobilePanel = "sidebar" | "editor" | "chat";

export type ExplorerSessionState = {
  view: SidebarView;
  searchQuery: string;
  expandedPaths: string[];
  scrollTop: number;
};

export type LayoutSessionState = {
  sidebarOpen: boolean;
  chatOpen: boolean;
  mobilePanel: MobilePanel;
  desktopLayout: Record<string, number> | null;
};

export type EditorSessionState = {
  split: boolean;
  focusedGroup: "left" | "right";
  leftTabs: EditorTab[];
  rightTabs: EditorTab[];
  leftActiveId: string | null;
  rightActiveId: string | null;
  viewStateByTabId: Record<string, unknown>;
};

export type ChatSessionState = {
  tabs: ChatTab[];
  mode: EditorMode;
  model: ModelInfo;
  backendId: AgentBackendId;
  scrollTopByTabId: Record<string, number>;
  hiddenConversationIds: string[];
};

export type SettingsViewSessionState = {
  activeNav: string;
  searchQuery: string;
  scrollTop: number;
};

export type WorkspaceSessionState = {
  schemaVersion: 1;
  editor: EditorSessionState;
  chat: ChatSessionState;
  explorer: ExplorerSessionState;
  layout: LayoutSessionState;
  settingsView: SettingsViewSessionState;
};

export function createEmptyEditorSession(): EditorSessionState {
  return {
    split: false,
    focusedGroup: "left",
    leftTabs: [],
    rightTabs: [],
    leftActiveId: null,
    rightActiveId: null,
    viewStateByTabId: {},
  };
}

export function createDefaultWorkspaceSession(
  initialChatTabs: ChatTab[],
  initialModel: ModelInfo
): WorkspaceSessionState {
  return {
    schemaVersion: 1,
    editor: createEmptyEditorSession(),
    chat: {
      tabs: initialChatTabs,
      mode: "agent",
      model: initialModel,
      backendId: "cursor-acp",
      scrollTopByTabId: {},
      hiddenConversationIds: [],
    },
    explorer: {
      view: "explorer",
      searchQuery: "",
      expandedPaths: [],
      scrollTop: 0,
    },
    layout: {
      sidebarOpen: true,
      chatOpen: true,
      mobilePanel: "editor",
      desktopLayout: null,
    },
    settingsView: {
      activeNav: "general",
      searchQuery: "",
      scrollTop: 0,
    },
  };
}

function createPersistableEditorTab(tab: EditorTab): EditorTab {
  if (tab.filePath && !tab.dirty) {
    return {
      ...tab,
      content: "",
      savedContent: undefined,
      loading: false,
    };
  }

  if (tab.terminalId) {
    return {
      id: tab.id,
      name: tab.name,
      language: tab.language,
      icon: tab.icon,
      content: "",
      terminalId: tab.terminalId,
    };
  }

  if (tab.browser) {
    return {
      id: tab.id,
      name: tab.name,
      language: tab.language,
      icon: tab.icon,
      content: "",
      browser: tab.browser,
    };
  }

  if (tab.id === "workbench.settings") {
    return {
      id: tab.id,
      name: tab.name,
      language: tab.language,
      icon: tab.icon,
      content: "",
    };
  }

  return tab;
}

export function createPersistableWorkspaceSession(
  session: WorkspaceSessionState
): WorkspaceSessionState {
  return {
    schemaVersion: 1,
    editor: {
      ...session.editor,
      leftTabs: session.editor.leftTabs.map(createPersistableEditorTab),
      rightTabs: session.editor.rightTabs.map(createPersistableEditorTab),
    },
    chat: session.chat,
    explorer: session.explorer,
    layout: session.layout,
    settingsView: session.settingsView,
  };
}

/** Merge an imported session snapshot onto the current workspace session. */
export function mergeWorkspaceSessionFromImport(
  current: WorkspaceSessionState,
  imported: unknown
): WorkspaceSessionState {
  if (!imported || typeof imported !== "object") {
    return current;
  }
  const r = imported as Partial<WorkspaceSessionState>;
  if (r.schemaVersion !== 1) {
    return current;
  }

  return {
    schemaVersion: 1,
    editor: {
      ...current.editor,
      ...(r.editor ?? {}),
      leftTabs: Array.isArray(r.editor?.leftTabs) ? r.editor.leftTabs : current.editor.leftTabs,
      rightTabs: Array.isArray(r.editor?.rightTabs) ? r.editor.rightTabs : current.editor.rightTabs,
      viewStateByTabId:
        r.editor?.viewStateByTabId && typeof r.editor.viewStateByTabId === "object"
          ? r.editor.viewStateByTabId
          : current.editor.viewStateByTabId,
    },
    chat: {
      ...current.chat,
      ...(r.chat ?? {}),
      tabs: Array.isArray(r.chat?.tabs) && r.chat.tabs.length > 0 ? r.chat.tabs : current.chat.tabs,
      scrollTopByTabId:
        r.chat?.scrollTopByTabId && typeof r.chat.scrollTopByTabId === "object"
          ? r.chat.scrollTopByTabId
          : current.chat.scrollTopByTabId,
      hiddenConversationIds: Array.isArray(r.chat?.hiddenConversationIds)
        ? r.chat.hiddenConversationIds.filter(
            (value): value is string => typeof value === "string" && value.length > 0
          )
        : current.chat.hiddenConversationIds,
      model: r.chat?.model ?? current.chat.model,
      mode: r.chat?.mode ?? current.chat.mode,
      backendId:
        r.chat?.backendId === "cursor-acp" ||
        r.chat?.backendId === "opencode-acp" ||
        r.chat?.backendId === "codex-adapter" ||
        r.chat?.backendId === "claude-adapter"
          ? r.chat.backendId
          : current.chat.backendId,
    },
    explorer: {
      ...current.explorer,
      ...(r.explorer ?? {}),
      expandedPaths: Array.isArray(r.explorer?.expandedPaths)
        ? r.explorer.expandedPaths
        : current.explorer.expandedPaths,
    },
    layout: {
      ...current.layout,
      ...(r.layout ?? {}),
      desktopLayout:
        r.layout?.desktopLayout && typeof r.layout.desktopLayout === "object"
          ? r.layout.desktopLayout
          : current.layout.desktopLayout,
    },
    settingsView: {
      ...current.settingsView,
      ...(r.settingsView ?? {}),
    },
  };
}
