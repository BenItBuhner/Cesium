import type { ChatTab, EditorTab, EditorMode, ModelInfo } from "@cesium/core";
import {
  DEFAULT_COMPOSER_STATUS_BAR_VISIBILITY,
  normalizeComposerStatusBarVisibility,
  type ComposerStatusBarVisibility,
} from "./composer-status-bar";
import type { AgentBackendId } from "@cesium/core";
import { isActiveAgentBackendId } from "@cesium/core";
import type { AgentRailFilterToggleState } from "./agent-rail";
import {
  defaultAgentRailFilterToggles,
  normalizeAgentRailFilterToggles,
} from "./agent-rail";
import { normalizeAgentShellDesktopLayout } from "./agent-shell-layout";
import { clientKeyValueStore } from "./platform";

export type SidebarView = "explorer" | "search" | "scm" | "extensions";
export type MobilePanel = "sidebar" | "editor" | "chat";
export const AGENT_NEW_CHAT_SESSION_ID = "new";

export type ExplorerSessionState = {
  view: SidebarView;
  searchQuery: string;
  expandedPaths: string[];
  scrollTop: number;
};

/** Agent shell vs full-screen settings; `/agent` uses `?view=settings` when not default agent. */
export type WorkbenchShellView = "agent" | "settings";

/** Last non-settings shell; used when closing the settings overlay. */
export type WorkbenchShellNonSettingsView = "agent";

export type LayoutSessionState = {
  sidebarOpen: boolean;
  chatOpen: boolean;
  mobilePanel: MobilePanel;
  desktopLayout: Record<string, number> | null;
  shellView: WorkbenchShellView;
  /** Shell to restore when leaving `settings` (ignored when not on settings). */
  priorShellView: WorkbenchShellNonSettingsView;
};

/** Legacy in-editor Settings tab id (removed; settings open as full shell). */
export const WORKBENCH_LEGACY_SETTINGS_TAB_ID = "workbench.settings" as const;

export type EditorSplitOrientation = "horizontal" | "vertical";

/** Single row in the editor tab strip (left or right pane). */
export type EditorStripItem =
  | { type: "tab"; tabId: string }
  | { type: "group"; groupId: string };

/** Tab group metadata; membership is `tabIds` (no duplicate field on `EditorTab`). */
export type EditorTabGroupState = {
  id: string;
  title: string;
  /** Preset name (`blue`, `green`, …) or `#rrggbb`. */
  color: string;
  collapsed: boolean;
  tabIds: string[];
};

export type EditorPaneId = string;

export type EditorPaneState = {
  id: EditorPaneId;
  tabs: EditorTab[];
  activeId: string | null;
  tabGroups: Record<string, EditorTabGroupState>;
  stripItems: EditorStripItem[];
};

export type EditorLayoutNode =
  | { id: string; type: "leaf"; paneId: EditorPaneId }
  | {
      id: string;
      type: "split";
      orientation: EditorSplitOrientation;
      children: string[];
      layout: Record<string, number> | null;
    };

export type EditorSessionState = {
  split: boolean;
  splitOrientation: EditorSplitOrientation;
  splitLayout: Record<string, number> | null;
  focusedGroup: "left" | "right";
  leftTabs: EditorTab[];
  rightTabs: EditorTab[];
  leftActiveId: string | null;
  rightActiveId: string | null;
  /** Per-pane tab groups (VS Code–style). */
  leftTabGroups: Record<string, EditorTabGroupState>;
  rightTabGroups: Record<string, EditorTabGroupState>;
  leftStripItems: EditorStripItem[];
  rightStripItems: EditorStripItem[];
  viewStateByTabId: Record<string, unknown>;
};

/** Scroll offset persisted for a chat tab. Missing key = open at bottom (latest messages). */
export function getPersistedChatScrollTop(
  map: Record<string, number>,
  tabId: string
): number | undefined {
  return Object.hasOwn(map, tabId) ? map[tabId] : undefined;
}

/** Matches {@link getWorkspaceSessionScopeId} in WorkspaceContext (workspace + optional window). */
export function getWorkspaceChatScrollScopeId(
  workspaceId: string,
  windowId: string | null | undefined
): string {
  return windowId ? `${workspaceId}:window:${windowId}` : workspaceId;
}

/**
 * Message-anchored scroll: `delta = scrollTop - messageRowTopInScrollContent`.
 * Stable when older history is prepended (both terms shift equally).
 */
export type ChatScrollAnchor = {
  messageId: string;
  delta: number;
};

function isChatScrollAnchor(raw: unknown): raw is ChatScrollAnchor {
  if (!raw || typeof raw !== "object") {
    return false;
  }
  const o = raw as Record<string, unknown>;
  return (
    typeof o.messageId === "string" &&
    o.messageId.length > 0 &&
    typeof o.delta === "number" &&
    Number.isFinite(o.delta)
  );
}

export type ChatScrollOverlayEntry =
  | { pinBottom: true; at: number }
  | { y: number; at: number; anchor?: ChatScrollAnchor };

const CHAT_SCROLL_OVERLAY_MAX_KEYS = 400;

function chatScrollOverlayStorageKey(
  serverStorageKey: string,
  workspaceScopeId: string
): string {
  return `opencursor.chat-scroll-overlay.${serverStorageKey}.${workspaceScopeId}`;
}

function readChatScrollOverlayBucketRaw(
  serverStorageKey: string,
  workspaceScopeId: string
): Record<string, ChatScrollOverlayEntry> {
  try {
    const raw = clientKeyValueStore().getItem(
      chatScrollOverlayStorageKey(serverStorageKey, workspaceScopeId)
    );
    if (!raw) {
      return {};
    }
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== "object") {
      return {};
    }
    return parsed as Record<string, ChatScrollOverlayEntry>;
  } catch {
    return {};
  }
}

function pruneChatScrollOverlayBucket(
  bucket: Record<string, ChatScrollOverlayEntry>
): Record<string, ChatScrollOverlayEntry> {
  const ids = Object.keys(bucket);
  if (ids.length <= CHAT_SCROLL_OVERLAY_MAX_KEYS) {
    return bucket;
  }
  const sorted = ids.sort(
    (a, b) => (bucket[b]!.at ?? 0) - (bucket[a]!.at ?? 0)
  );
  const next: Record<string, ChatScrollOverlayEntry> = {};
  for (const id of sorted.slice(0, CHAT_SCROLL_OVERLAY_MAX_KEYS)) {
    next[id] = bucket[id]!;
  }
  return next;
}

/**
 * Immediate, durable scroll position (localStorage). Survives rapid tab switches before the
 * debounced workspace session save hits the server.
 */
export function writeChatScrollOverlayEntry(
  serverStorageKey: string,
  workspaceScopeId: string,
  conversationId: string,
  entry: ChatScrollOverlayEntry
): void {
  if (!conversationId) {
    return;
  }
  try {
    const key = chatScrollOverlayStorageKey(serverStorageKey, workspaceScopeId);
    let bucket = readChatScrollOverlayBucketRaw(serverStorageKey, workspaceScopeId);
    bucket = pruneChatScrollOverlayBucket(bucket);
    bucket[conversationId] = entry;
    clientKeyValueStore().setItem(key, JSON.stringify(bucket));
  } catch {
    /* quota / private mode */
  }
}

export type ResolvedChatScroll =
  | { mode: "bottom" }
  | { mode: "restore"; scrollTop?: number; anchor?: ChatScrollAnchor };

function normalizeScrollAnchorMap(
  raw: unknown,
  fallback: Record<string, ChatScrollAnchor>
): Record<string, ChatScrollAnchor> {
  if (!raw || typeof raw !== "object") {
    return { ...fallback };
  }
  const next: Record<string, ChatScrollAnchor> = { ...fallback };
  for (const [tabId, v] of Object.entries(raw)) {
    if (!tabId || !isChatScrollAnchor(v)) {
      continue;
    }
    next[tabId] = v;
  }
  return next;
}

/**
 * Overlay (per-device) wins for immediacy; session maps sync to the server for cross-device restore.
 */
export function resolvePersistedChatScroll(
  sessionMap: Record<string, number>,
  sessionAnchors: Record<string, ChatScrollAnchor>,
  conversationId: string | null | undefined,
  workspaceId: string | null | undefined,
  windowId: string | null | undefined,
  serverStorageKey: string
): ResolvedChatScroll {
  if (!conversationId || !workspaceId) {
    return { mode: "bottom" };
  }
  const scope = getWorkspaceChatScrollScopeId(workspaceId, windowId);
  const row = readChatScrollOverlayBucketRaw(serverStorageKey, scope)[conversationId];
  if (row && "pinBottom" in row && row.pinBottom) {
    return { mode: "bottom" };
  }
  if (row && "y" in row && typeof row.y === "number" && Number.isFinite(row.y)) {
    const anchor =
      "anchor" in row && row.anchor && isChatScrollAnchor(row.anchor) ? row.anchor : undefined;
    return { mode: "restore", scrollTop: row.y, anchor };
  }
  const top = getPersistedChatScrollTop(sessionMap, conversationId);
  const anchor = sessionAnchors[conversationId];
  if (top !== undefined) {
    return { mode: "restore", scrollTop: top, anchor };
  }
  if (anchor) {
    return { mode: "restore", anchor };
  }
  return { mode: "bottom" };
}

/** @deprecated Prefer {@link resolvePersistedChatScroll} for anchor-aware restore. */
export function resolvePersistedChatScrollTop(
  sessionMap: Record<string, number>,
  conversationId: string | null | undefined,
  workspaceId: string | null | undefined,
  windowId: string | null | undefined,
  serverStorageKey: string
): number | undefined {
  const r = resolvePersistedChatScroll(
    sessionMap,
    {},
    conversationId,
    workspaceId,
    windowId,
    serverStorageKey
  );
  if (r.mode === "bottom") {
    return undefined;
  }
  return r.scrollTop;
}

export function persistChatScrollOverlay(
  workspaceId: string,
  windowId: string | null | undefined,
  serverStorageKey: string,
  conversationId: string,
  scrollTop: number,
  meta: { pinnedToBottom: boolean; anchor?: ChatScrollAnchor | null }
): void {
  if (!workspaceId || !conversationId) {
    return;
  }
  const scope = getWorkspaceChatScrollScopeId(workspaceId, windowId);
  writeChatScrollOverlayEntry(
    serverStorageKey,
    scope,
    conversationId,
    meta.pinnedToBottom
      ? { pinBottom: true, at: Date.now() }
      : {
          y: scrollTop,
          at: Date.now(),
          ...(meta.anchor ? { anchor: meta.anchor } : {}),
        }
  );
}

export type ChatSessionState = {
  tabs: ChatTab[];
  mode: EditorMode;
  model: ModelInfo;
  backendId: AgentBackendId;
  scrollTopByTabId: Record<string, number>;
  /** Message-anchored scroll (syncs across devices via workspace session). */
  scrollAnchorByTabId?: Record<string, ChatScrollAnchor>;
  hiddenConversationIds: string[];
  editingQueuedPromptIdByConversationId?: Record<string, string>;
  /**
   * Collapsed/expanded state for worked-session dropdowns.
   * Keys: `${conversationId}::${messageId}` → true = expanded.
   */
  workedSessionOpenByScopedId?: Record<string, boolean>;
  /**
   * When true, the follow-up message queue (composer dock) is collapsed for that
   * conversation. Omitted = expanded. Syncs via workspace session.
   */
  composerQueueDockCollapsedByConversationId?: Record<string, true>;
  /** Dismissed completion error cards keyed by completionErrorDismissKey. */
  dismissedCompletionErrorKeyByConversationId?: Record<string, string>;
  /** Dismissed plan review cards keyed by latest plan_file event id. */
  dismissedPlanEventByConversationId?: Record<string, string>;
  /** Conversation completed (idle) since last viewed; key present means show unread dot. */
  unreadChatCompletionByConversationId?: Record<string, true>;
  /** Composer footer: repo / branch / Burn progress / context visibility toggles. */
  composerStatusBarVisibility?: ComposerStatusBarVisibility;
};

export type AgentSidePaneSessionState = {
  editor: EditorSessionState;
  rightPaneOpen: boolean;
  /** Conversation-scoped side pane width snapshot; the shared left rail width comes from `agentView.agentShellDesktopLayout`. */
  agentShellDesktopLayout: Record<string, number> | null;
  expandedComposerDraftId: string | null;
};

export type SettingsPanelSearchFocus =
  | { kind: "models"; query: string; backendId?: string }
  | { kind: "keyboardShortcuts"; query: string }
  | { kind: "scroll"; navId: string; rowId: string };

export type SettingsViewSessionState = {
  activeNav: string;
  searchQuery: string;
  scrollTop: number;
  /** When set with activeNav "agents", shows that harness's settings subpage (hidden from main nav). */
  agentsHarnessId?: string | null;
  /** When true with activeNav "plugins", shows MCP servers subpage (hidden from main nav). */
  mcpsOpen?: boolean | null;
  /** One-shot navigation target from global settings search (consumed by the destination panel). */
  panelSearchFocus?: SettingsPanelSearchFocus | null;
};

/** Normalize settings nav; migrates legacy `mcps` / `tools` top-level nav to Plugins subpage. */
export function normalizeSettingsViewSession(
  raw: Partial<SettingsViewSessionState> | undefined,
  fallback: SettingsViewSessionState
): SettingsViewSessionState {
  const activeNavRaw =
    typeof raw?.activeNav === "string" && raw.activeNav.length > 0
      ? raw.activeNav
      : fallback.activeNav;
  const legacyMcpNav = activeNavRaw === "mcps" || activeNavRaw === "tools";
  const activeNav = legacyMcpNav ? "plugins" : activeNavRaw;
  const mcpsOpenRaw =
    raw?.mcpsOpen === true || legacyMcpNav
      ? true
      : raw?.mcpsOpen === false
        ? false
        : fallback.mcpsOpen === true;
  const mcpsOpen = activeNav === "plugins" && mcpsOpenRaw ? true : false;
  return {
    activeNav,
    searchQuery:
      typeof raw?.searchQuery === "string" ? raw.searchQuery : fallback.searchQuery,
    scrollTop:
      typeof raw?.scrollTop === "number" && Number.isFinite(raw.scrollTop)
        ? raw.scrollTop
        : fallback.scrollTop,
    agentsHarnessId:
      activeNav === "agents"
        ? typeof raw?.agentsHarnessId === "string"
          ? raw.agentsHarnessId
          : raw?.agentsHarnessId === null
            ? null
            : fallback.agentsHarnessId ?? null
        : null,
    mcpsOpen,
    panelSearchFocus:
      raw?.panelSearchFocus === null
        ? null
        : raw?.panelSearchFocus && typeof raw.panelSearchFocus === "object"
          ? raw.panelSearchFocus
          : fallback.panelSearchFocus ?? null,
  };
}

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
    leftTabGroups: {},
    rightTabGroups: {},
    leftStripItems: [],
    rightStripItems: [],
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
      backendId: "cesium-agent",
      scrollTopByTabId: {},
      scrollAnchorByTabId: {},
      hiddenConversationIds: [],
      editingQueuedPromptIdByConversationId: {},
      workedSessionOpenByScopedId: {},
      composerQueueDockCollapsedByConversationId: {},
      dismissedCompletionErrorKeyByConversationId: {},
      dismissedPlanEventByConversationId: {},
      unreadChatCompletionByConversationId: {},
      composerStatusBarVisibility: { ...DEFAULT_COMPOSER_STATUS_BAR_VISIBILITY },
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
      priorShellView: "agent",
    },
    agentView: {
      leftRailCollapsed: false,
      rightPaneOpen: false,
      selectedConversationId: AGENT_NEW_CHAT_SESSION_ID,
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
      browser: {
        ...tab.browser,
        devtoolsOpen: false,
        debugSessionId: null,
        devtoolsPath: null,
      },
    };
  }

  if (tab.id === WORKBENCH_LEGACY_SETTINGS_TAB_ID) {
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

function normalizeEditorTabGroupsRecord(
  raw: unknown,
  defaults: Record<string, EditorTabGroupState>
): Record<string, EditorTabGroupState> {
  if (!raw || typeof raw !== "object") {
    return { ...defaults };
  }
  const next: Record<string, EditorTabGroupState> = {};
  for (const [id, g] of Object.entries(raw)) {
    if (!g || typeof g !== "object") continue;
    const o = g as Record<string, unknown>;
    const tabIds = Array.isArray(o.tabIds)
      ? o.tabIds.filter((x): x is string => typeof x === "string")
      : [];
    if (tabIds.length === 0) continue;
    const title = typeof o.title === "string" ? o.title : "New group";
    const color = typeof o.color === "string" ? o.color : "blue";
    const collapsed = o.collapsed === true;
    next[id] = {
      id: typeof o.id === "string" ? o.id : id,
      title,
      color,
      collapsed,
      tabIds,
    };
  }
  return Object.keys(next).length > 0 ? next : { ...defaults };
}

function stripLegacySettingsEditorTab(session: EditorSessionState): EditorSessionState {
  const LEGACY = WORKBENCH_LEGACY_SETTINGS_TAB_ID;
  const pruneTabs = (tabs: EditorTab[]) => tabs.filter((t) => t.id !== LEGACY);
  const leftTabs = pruneTabs(session.leftTabs);
  const rightTabs = pruneTabs(session.rightTabs);

  const pruneGroups = (
    groups: Record<string, EditorTabGroupState>
  ): Record<string, EditorTabGroupState> => {
    const next: Record<string, EditorTabGroupState> = {};
    for (const [id, g] of Object.entries(groups)) {
      const tabIds = g.tabIds.filter((tid) => tid !== LEGACY);
      if (tabIds.length > 0) {
        next[id] = { ...g, tabIds };
      }
    }
    return next;
  };
  const leftTabGroups = pruneGroups(session.leftTabGroups);
  const rightTabGroups = pruneGroups(session.rightTabGroups);

  const pruneStrip = (
    items: EditorStripItem[],
    groups: Record<string, EditorTabGroupState>
  ): EditorStripItem[] =>
    items.filter((item) => {
      if (item.type === "tab") {
        return item.tabId !== LEGACY;
      }
      return item.groupId in groups;
    });

  const leftStripItems = pruneStrip(session.leftStripItems, leftTabGroups);
  const rightStripItems = pruneStrip(session.rightStripItems, rightTabGroups);

  const fixActive = (activeId: string | null, tabs: EditorTab[]): string | null => {
    if (activeId === LEGACY) {
      return tabs[0]?.id ?? null;
    }
    if (activeId && !tabs.some((t) => t.id === activeId)) {
      return tabs[0]?.id ?? null;
    }
    return activeId;
  };
  const leftActiveId = fixActive(session.leftActiveId, leftTabs);
  const rightActiveId = fixActive(session.rightActiveId, rightTabs);

  const viewStateByTabId = { ...session.viewStateByTabId };
  delete viewStateByTabId[LEGACY];

  return {
    ...session,
    leftTabs,
    rightTabs,
    leftTabGroups,
    rightTabGroups,
    leftStripItems,
    rightStripItems,
    leftActiveId,
    rightActiveId,
    viewStateByTabId,
  };
}

function normalizeEditorStripItems(
  raw: unknown,
  defaults: EditorStripItem[]
): EditorStripItem[] {
  if (!Array.isArray(raw)) {
    return [...defaults];
  }
  const out: EditorStripItem[] = [];
  for (const item of raw) {
    if (!item || typeof item !== "object") continue;
    const o = item as Record<string, unknown>;
    if (o.type === "tab" && typeof o.tabId === "string") {
      out.push({ type: "tab", tabId: o.tabId });
    } else if (o.type === "group" && typeof o.groupId === "string") {
      out.push({ type: "group", groupId: o.groupId });
    }
  }
  return out.length > 0 ? out : [...defaults];
}

function normalizeEditorSession(
  raw: Partial<EditorSessionState> | null | undefined,
  defaults: EditorSessionState
): EditorSessionState {
  const leftTabs = Array.isArray(raw?.leftTabs) ? raw.leftTabs : defaults.leftTabs;
  const rightTabs = Array.isArray(raw?.rightTabs) ? raw.rightTabs : defaults.rightTabs;
  const leftTabGroups = normalizeEditorTabGroupsRecord(
    raw?.leftTabGroups,
    defaults.leftTabGroups
  );
  const rightTabGroups = normalizeEditorTabGroupsRecord(
    raw?.rightTabGroups,
    defaults.rightTabGroups
  );
  let leftStripItems = normalizeEditorStripItems(
    raw?.leftStripItems,
    defaults.leftStripItems
  );
  let rightStripItems = normalizeEditorStripItems(
    raw?.rightStripItems,
    defaults.rightStripItems
  );
  if (
    leftStripItems.length === 0 &&
    leftTabs.length > 0 &&
    Object.keys(leftTabGroups).length === 0
  ) {
    leftStripItems = leftTabs.map((t) => ({ type: "tab" as const, tabId: t.id }));
  }
  if (
    rightStripItems.length === 0 &&
    rightTabs.length > 0 &&
    Object.keys(rightTabGroups).length === 0
  ) {
    rightStripItems = rightTabs.map((t) => ({ type: "tab" as const, tabId: t.id }));
  }
  return stripLegacySettingsEditorTab({
    ...defaults,
    ...(raw ?? {}),
    leftTabs,
    rightTabs,
    leftTabGroups,
    rightTabGroups,
    leftStripItems,
    rightStripItems,
    viewStateByTabId:
      raw?.viewStateByTabId && typeof raw.viewStateByTabId === "object"
        ? raw.viewStateByTabId
        : defaults.viewStateByTabId,
  });
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
  const importedChatBackendRaw = r.chat?.backendId;
  const legacyChatBackendRemap: Record<string, AgentBackendId> = {
    "claude-adapter": "claude-code-sdk",
    "cursor-acp": "cursor-sdk",
    "opencode-acp": "opencode-server",
    "codex-adapter": "codex-app-server",
    "gemini-acp": "google-antigravity-cli",
  };
  const importedChatBackendRawMapped =
    typeof importedChatBackendRaw === "string"
      ? legacyChatBackendRemap[importedChatBackendRaw] ?? importedChatBackendRaw
      : importedChatBackendRaw;
  const importedChatBackendCoerced: AgentBackendId =
    (importedChatBackendRawMapped as AgentBackendId | undefined) ?? current.chat.backendId;
  const normalizedChatBackendId = isActiveAgentBackendId(importedChatBackendCoerced)
    ? importedChatBackendCoerced
    : current.chat.backendId;
  const importedUnsupportedBackend =
    importedChatBackendRaw != null &&
    normalizedChatBackendId !== importedChatBackendCoerced;
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
      scrollAnchorByTabId: normalizeScrollAnchorMap(
        r.chat?.scrollAnchorByTabId,
        current.chat.scrollAnchorByTabId ?? {}
      ),
      hiddenConversationIds: Array.isArray(r.chat?.hiddenConversationIds)
        ? r.chat.hiddenConversationIds.filter(
            (value): value is string => typeof value === "string" && value.length > 0
          )
        : current.chat.hiddenConversationIds,
      editingQueuedPromptIdByConversationId:
        r.chat?.editingQueuedPromptIdByConversationId &&
        typeof r.chat.editingQueuedPromptIdByConversationId === "object"
          ? r.chat.editingQueuedPromptIdByConversationId
          : current.chat.editingQueuedPromptIdByConversationId ?? {},
      workedSessionOpenByScopedId:
        r.chat?.workedSessionOpenByScopedId &&
        typeof r.chat.workedSessionOpenByScopedId === "object"
          ? r.chat.workedSessionOpenByScopedId
          : current.chat.workedSessionOpenByScopedId ?? {},
      composerQueueDockCollapsedByConversationId:
        r.chat?.composerQueueDockCollapsedByConversationId &&
        typeof r.chat.composerQueueDockCollapsedByConversationId === "object"
          ? r.chat.composerQueueDockCollapsedByConversationId
          : current.chat.composerQueueDockCollapsedByConversationId ?? {},
      dismissedCompletionErrorKeyByConversationId:
        r.chat?.dismissedCompletionErrorKeyByConversationId &&
        typeof r.chat.dismissedCompletionErrorKeyByConversationId === "object"
          ? r.chat.dismissedCompletionErrorKeyByConversationId
          : current.chat.dismissedCompletionErrorKeyByConversationId ?? {},
      dismissedPlanEventByConversationId:
        r.chat?.dismissedPlanEventByConversationId &&
        typeof r.chat.dismissedPlanEventByConversationId === "object"
          ? r.chat.dismissedPlanEventByConversationId
          : current.chat.dismissedPlanEventByConversationId ?? {},
      unreadChatCompletionByConversationId:
        r.chat?.unreadChatCompletionByConversationId &&
        typeof r.chat.unreadChatCompletionByConversationId === "object"
          ? r.chat.unreadChatCompletionByConversationId
          : current.chat.unreadChatCompletionByConversationId ?? {},
      composerStatusBarVisibility: normalizeComposerStatusBarVisibility(
        r.chat?.composerStatusBarVisibility ?? current.chat.composerStatusBarVisibility
      ),
      model: importedUnsupportedBackend ? current.chat.model : r.chat?.model ?? current.chat.model,
      mode: importedUnsupportedBackend ? current.chat.mode : r.chat?.mode ?? current.chat.mode,
      backendId: normalizedChatBackendId,
    },
    explorer: {
      ...current.explorer,
      ...(r.explorer ?? {}),
      view:
        r.explorer?.view === "explorer" ||
        r.explorer?.view === "search" ||
        r.explorer?.view === "scm" ||
        r.explorer?.view === "extensions"
          ? r.explorer.view
          : current.explorer.view,
      expandedPaths: Array.isArray(r.explorer?.expandedPaths)
        ? r.explorer.expandedPaths
        : current.explorer.expandedPaths,
    },
    layout: {
      ...current.layout,
      ...(r.layout ?? {}),
      shellView:
        r.layout?.shellView === "settings"
          ? "settings"
          : "agent",
      priorShellView: "agent",
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
    settingsView: normalizeSettingsViewSession(r.settingsView, current.settingsView),
  };
}
