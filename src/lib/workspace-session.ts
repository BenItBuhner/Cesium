import type {
  ChatMessage,
  ChatTab,
  EditorTab,
  EditorMode,
  ModelInfo,
} from "@/lib/types";

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
  messagesByTabId: Record<string, ChatMessage[]>;
  mode: EditorMode;
  model: ModelInfo;
  scrollTopByTabId: Record<string, number>;
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
  initialMessagesByTabId: Record<string, ChatMessage[]>,
  initialModel: ModelInfo
): WorkspaceSessionState {
  return {
    schemaVersion: 1,
    editor: createEmptyEditorSession(),
    chat: {
      tabs: initialChatTabs,
      messagesByTabId: initialMessagesByTabId,
      mode: "agent",
      model: initialModel,
      scrollTopByTabId: {},
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
