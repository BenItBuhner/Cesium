import type {
  ChatTab,
  EditorTab,
  EditorMode,
  ModelInfo,
  QueuedChatPrompt,
} from "@/lib/types";
import type { AgentBackendId } from "@/lib/agent-types";
import type { AgentRailFilterToggleState } from "@/lib/agent-rail";
import {
  defaultAgentRailFilterToggles,
  normalizeAgentRailFilterToggles,
} from "@/lib/agent-rail";
import { normalizeAgentShellDesktopLayout } from "@/components/agent/agent-shell-layout";

export type SidebarView = "explorer" | "search" | "scm";
export type MobilePanel = "sidebar" | "editor" | "chat";
export const AGENT_NEW_CHAT_SESSION_ID = "new";

export type ExplorerSessionState = {
  view: SidebarView;
  searchQuery: string;
  expandedPaths: string[];
  scrollTop: number;
};

export type WorkbenchShellView = "agent" | "editor";

export type LayoutSessionState = {
  sidebarOpen: boolean;
  chatOpen: boolean;
  mobilePanel: MobilePanel;
  desktopLayout: Record<string, number> | null;
  /** Agent vs classic IDE layout; URL uses `?view=editor` when not default agent. */
  shellView: WorkbenchShellView;
};

export type EditorSplitOrientation = "horizontal" | "vertical";

export type EditorSessionState = {
  split: boolean;
  splitOrientation: EditorSplitOrientation;
  splitLayout: Record<string, number> | null;
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
  /**
   * Collapsed/expanded state for worked-session dropdowns.
   * Keys: `${conversationId}::${messageId}` → true = expanded.
   */
  workedSessionOpenByScopedId?: Record<string, boolean>;
  queuedPromptsByConversationId?: Record<string, QueuedChatPrompt[]>;
  /** Conversation completed (idle) since last viewed; key present means show unread dot. */
  unreadChatCompletionByConversationId?: Record<string, true>;
};

export type AgentSidePaneSessionState = {
  editor: EditorSessionState;
  rightPaneOpen: boolean;
  /** Conversation-scoped side pane width snapshot; the shared left rail width comes from `agentView.agentShellDesktopLayout`. */
  agentShellDesktopLayout: Record<string, number> | null;
  expandedComposerDraftId: string | null;
};

export type SettingsViewSessionState = {
  activeNav: string;
  searchQuery: string;
  scrollTop: number;
};

export type AgentViewSessionState = {
  leftRailCollapsed: boolean;
  rightPaneOpen: boolean;
  selectedConversationId: string | null;
  archivedConversationIds: string[];
  /** Cross-workspace agent chats pinned to the top of the agent rail (most recent first). */
  pinnedAgentConversationIds: string[];
  /** Agent rail filter checkboxes (multi-select, AND). Omitted keys mean false after normalize. */
  railFilterToggles?: AgentRailFilterToggleState;
  filterPreset: string;
  /** Shared agent shell layout snapshot. The left rail width stays global across chats. */
  agentShellDesktopLayout: Record<string, number> | null;
  /** Per-conversation right-side workbench state for the agent shell. */
  sidePaneSessionsByConversationId?: Record<string, AgentSidePaneSessionState>;
};

export type WorkspaceSessionState = {
  schemaVersion: 1;
  editor: EditorSessionState;
  chat: ChatSessionState;
  explorer: ExplorerSessionState;
  layout: LayoutSessionState;
  agentView: AgentViewSessionState;
  settingsView: SettingsViewSessionState;
};

export function createEmptyEditorSession(): EditorSessionState {
  return {
    split: false,
    splitOrientation: "horizontal",
    splitLayout: null,
    focusedGroup: "left",
    leftTabs: [],
    rightTabs: [],
    leftActiveId: null,
    rightActiveId: null,
    viewStateByTabId: {},
  };
}

export function createEmptyAgentSidePaneSession(): AgentSidePaneSessionState {
  return {
    editor: createEmptyEditorSession(),
    rightPaneOpen: false,
    agentShellDesktopLayout: null,
    expandedComposerDraftId: null,
  };
}

export function getAgentSidePaneSessionScopeId(
  selectedConversationId: string | null | undefined
): string {
  return typeof selectedConversationId === "string" && selectedConversationId.length > 0
    ? selectedConversationId
    : AGENT_NEW_CHAT_SESSION_ID;
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
      workedSessionOpenByScopedId: {},
      queuedPromptsByConversationId: {},
      unreadChatCompletionByConversationId: {},
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
      shellView: "agent",
    },
    agentView: {
      leftRailCollapsed: false,
      rightPaneOpen: false,
      selectedConversationId: null,
      archivedConversationIds: [],
      pinnedAgentConversationIds: [],
      railFilterToggles: defaultAgentRailFilterToggles(),
      filterPreset: "default",
      agentShellDesktopLayout: null,
      sidePaneSessionsByConversationId: {},
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
      loading: true,
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

function createPersistableEditorSession(session: EditorSessionState): EditorSessionState {
  return {
    ...session,
    leftTabs: session.leftTabs.map(createPersistableEditorTab),
    rightTabs: session.rightTabs.map(createPersistableEditorTab),
  };
}

function createPersistableAgentSidePaneSession(
  session: AgentSidePaneSessionState
): AgentSidePaneSessionState {
  return {
    ...session,
    editor: createPersistableEditorSession(session.editor),
  };
}

export function createPersistableWorkspaceSession(
  session: WorkspaceSessionState
): WorkspaceSessionState {
  return {
    schemaVersion: 1,
    editor: createPersistableEditorSession(session.editor),
    chat: session.chat,
    explorer: session.explorer,
    layout: session.layout,
    agentView: {
      ...session.agentView,
      sidePaneSessionsByConversationId: Object.fromEntries(
        Object.entries(session.agentView.sidePaneSessionsByConversationId ?? {}).map(
          ([scopeId, sidePaneSession]) => [
            scopeId,
            createPersistableAgentSidePaneSession(sidePaneSession),
          ]
        )
      ),
    },
    settingsView: session.settingsView,
  };
}

function normalizeEditorSession(
  raw: Partial<EditorSessionState> | null | undefined,
  defaults: EditorSessionState
): EditorSessionState {
  return {
    ...defaults,
    ...(raw ?? {}),
    leftTabs: Array.isArray(raw?.leftTabs) ? raw.leftTabs : defaults.leftTabs,
    rightTabs: Array.isArray(raw?.rightTabs) ? raw.rightTabs : defaults.rightTabs,
    viewStateByTabId:
      raw?.viewStateByTabId && typeof raw.viewStateByTabId === "object"
        ? raw.viewStateByTabId
        : defaults.viewStateByTabId,
  };
}

function normalizeAgentSidePaneSession(
  raw: Partial<AgentSidePaneSessionState> | null | undefined,
  defaults: AgentSidePaneSessionState
): AgentSidePaneSessionState {
  return {
    ...defaults,
    ...(raw ?? {}),
    editor: normalizeEditorSession(raw?.editor, defaults.editor),
    rightPaneOpen:
      typeof raw?.rightPaneOpen === "boolean"
        ? raw.rightPaneOpen
        : defaults.rightPaneOpen,
    agentShellDesktopLayout:
      normalizeAgentShellDesktopLayout(
        raw?.agentShellDesktopLayout ?? defaults.agentShellDesktopLayout
      ) ?? null,
    expandedComposerDraftId:
      typeof raw?.expandedComposerDraftId === "string" ||
      raw?.expandedComposerDraftId === null
        ? raw.expandedComposerDraftId
        : defaults.expandedComposerDraftId,
  };
}

function normalizeAgentSidePaneSessionMap(
  raw: unknown,
  fallback: Record<string, AgentSidePaneSessionState>
): Record<string, AgentSidePaneSessionState> {
  if (!raw || typeof raw !== "object") {
    return { ...fallback };
  }
  const entries: Array<[string, AgentSidePaneSessionState]> = [];
  for (const [scopeId, value] of Object.entries(raw)) {
    if (typeof scopeId !== "string" || scopeId.length === 0) {
      continue;
    }
    entries.push([
      scopeId,
      normalizeAgentSidePaneSession(
        value as Partial<AgentSidePaneSessionState>,
        fallback[scopeId] ?? createEmptyAgentSidePaneSession()
      ),
    ]);
  }
  return Object.fromEntries(entries);
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
  const normalizedChatBackendId =
    r.chat?.backendId === "cursor-acp" ||
    r.chat?.backendId === "opencode-acp" ||
    r.chat?.backendId === "codex-adapter" ||
    r.chat?.backendId === "claude-adapter"
      ? r.chat.backendId
      : current.chat.backendId;
  const importedUnsupportedBackend =
    r.chat?.backendId != null && normalizedChatBackendId !== r.chat.backendId;
  const normalizedSplitOrientation: EditorSplitOrientation =
    r.editor?.splitOrientation === "vertical" ? "vertical" : current.editor.splitOrientation;
  const normalizedSplitLayout =
    r.editor?.splitLayout && typeof r.editor.splitLayout === "object"
      ? Object.fromEntries(
          Object.entries(r.editor.splitLayout).filter(
            ([panelId, size]) =>
              typeof panelId === "string" &&
              panelId.length > 0 &&
              typeof size === "number" &&
              Number.isFinite(size)
          )
        )
      : current.editor.splitLayout;

  return {
    schemaVersion: 1,
    editor: normalizeEditorSession(
      {
        ...r.editor,
        splitOrientation: normalizedSplitOrientation,
        splitLayout: normalizedSplitLayout,
      },
      current.editor
    ),
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
      workedSessionOpenByScopedId:
        r.chat?.workedSessionOpenByScopedId &&
        typeof r.chat.workedSessionOpenByScopedId === "object"
          ? r.chat.workedSessionOpenByScopedId
          : current.chat.workedSessionOpenByScopedId ?? {},
      queuedPromptsByConversationId:
        r.chat?.queuedPromptsByConversationId &&
        typeof r.chat.queuedPromptsByConversationId === "object"
          ? r.chat.queuedPromptsByConversationId
          : current.chat.queuedPromptsByConversationId ?? {},
      unreadChatCompletionByConversationId:
        r.chat?.unreadChatCompletionByConversationId &&
        typeof r.chat.unreadChatCompletionByConversationId === "object"
          ? r.chat.unreadChatCompletionByConversationId
          : current.chat.unreadChatCompletionByConversationId ?? {},
      model: importedUnsupportedBackend ? current.chat.model : r.chat?.model ?? current.chat.model,
      mode: importedUnsupportedBackend ? current.chat.mode : r.chat?.mode ?? current.chat.mode,
      backendId: normalizedChatBackendId,
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
      shellView:
        r.layout?.shellView === "editor" || r.layout?.shellView === "agent"
          ? r.layout.shellView
          : current.layout.shellView ?? "agent",
      desktopLayout:
        r.layout?.desktopLayout && typeof r.layout.desktopLayout === "object"
          ? r.layout.desktopLayout
          : current.layout.desktopLayout,
    },
    agentView: {
      ...current.agentView,
      ...(r.agentView ?? {}),
      leftRailCollapsed:
        typeof r.agentView?.leftRailCollapsed === "boolean"
          ? r.agentView.leftRailCollapsed
          : current.agentView.leftRailCollapsed,
      rightPaneOpen:
        typeof r.agentView?.rightPaneOpen === "boolean"
          ? r.agentView.rightPaneOpen
          : current.agentView.rightPaneOpen,
      selectedConversationId:
        typeof r.agentView?.selectedConversationId === "string" ||
        r.agentView?.selectedConversationId === null
          ? r.agentView.selectedConversationId
          : current.agentView.selectedConversationId,
      archivedConversationIds: Array.isArray(r.agentView?.archivedConversationIds)
        ? r.agentView.archivedConversationIds.filter(
            (v): v is string => typeof v === "string" && v.length > 0
          )
        : current.agentView.archivedConversationIds ?? [],
      pinnedAgentConversationIds: Array.isArray(r.agentView?.pinnedAgentConversationIds)
        ? r.agentView.pinnedAgentConversationIds.filter(
            (v): v is string => typeof v === "string" && v.length > 0
          )
        : current.agentView.pinnedAgentConversationIds ?? [],
      railFilterToggles: normalizeAgentRailFilterToggles(
        r.agentView?.railFilterToggles ?? current.agentView.railFilterToggles,
        typeof r.agentView?.filterPreset === "string"
          ? r.agentView.filterPreset
          : current.agentView.filterPreset
      ),
      filterPreset:
        typeof r.agentView?.filterPreset === "string"
          ? r.agentView.filterPreset
          : current.agentView.filterPreset ?? "default",
      agentShellDesktopLayout:
        normalizeAgentShellDesktopLayout(
          r.agentView?.agentShellDesktopLayout ?? current.agentView.agentShellDesktopLayout
        ) ?? null,
      sidePaneSessionsByConversationId: normalizeAgentSidePaneSessionMap(
        r.agentView?.sidePaneSessionsByConversationId,
        current.agentView.sidePaneSessionsByConversationId ?? {}
      ),
    },
    settingsView: {
      ...current.settingsView,
      ...(r.settingsView ?? {}),
    },
  };
}
