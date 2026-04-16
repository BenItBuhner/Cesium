"use client";

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
  type Dispatch,
  type ReactNode,
  type SetStateAction,
} from "react";
import { useViewport } from "@/hooks/useViewport";
import type {
  AgentBackendInfo,
  AgentConversationGroup,
  AgentRailConversationSummary,
} from "@/lib/agent-types";
import type { ChatMessage } from "@/lib/types";
import { listCrossWorkspaceAgentConversations } from "@/lib/server-api";
import {
  AGENT_SHELL_DEFAULT_LAYOUT,
  AGENT_SHELL_PANEL_IDS,
  composeAgentShellDesktopLayout,
  extractAgentSidePaneScopedLayout,
  isAgentSidePaneScopedLayout,
  normalizeAgentShellDesktopLayout,
} from "@/components/agent/agent-shell-layout";
import {
  defaultAgentRailFilterToggles,
  isAgentRailFilterActive,
  matchesAgentRailMultiFilter,
  normalizeAgentRailFilterToggles,
  type AgentRailFilterToggleKey,
  type AgentRailFilterToggleState,
} from "@/lib/agent-rail";
import {
  getGlobalPinnedAgentConversationIdsSnapshot,
  migrateGlobalPinnedAgentConversationIdsIfNeeded,
  subscribeGlobalPinnedAgentConversationIds,
  writeGlobalPinnedAgentConversationIds,
} from "@/lib/agent-rail-pins";
import { buildServerScopedStorageKey } from "@/lib/server-connections";
import { useServerConnections } from "@/components/server/ServerConnectionsProvider";
import { useWorkspace } from "@/contexts/WorkspaceContext";
import {
  AGENT_NEW_CHAT_SESSION_ID,
  createEmptyAgentSidePaneSession,
  getAgentSidePaneSessionScopeId,
  type WorkspaceSessionState,
  type AgentSidePaneSessionState,
  type EditorSessionState,
} from "@/lib/workspace-session";

export type AgentCenterStableConversationView = {
  conversationId: string;
  messages: ChatMessage[];
  conversationBusy: boolean;
  hasOlderHistory: boolean;
  loadingOlderHistory: boolean;
  initialScrollTop: number;
};

type WorkspaceRailArchiveSnapshot = {
  archivedConversationIds: string[];
};

type AgentShellWindowSnapshot = {
  leftRailCollapsed?: boolean;
  agentShellDesktopLayout?: Record<string, number> | null;
};

type AgentShellStateContextValue = {
  leftRailCollapsed: boolean;
  setLeftRailCollapsed: (collapsed: boolean) => void;
  toggleLeftRailCollapsed: () => void;
  rightPaneOpen: boolean;
  setRightPaneOpen: (open: boolean) => void;
  toggleRightPaneOpen: () => void;
  sidePaneScopeId: string;
  sidePaneEditorSession: EditorSessionState;
  updateSidePaneEditorSession: (
    updater: (current: EditorSessionState) => EditorSessionState
  ) => void;
  agentShellDesktopLayout: Record<string, number> | null;
  setAgentShellDesktopLayout: (layout: Record<string, number> | null) => void;
  expandedComposerDraftId: string | null;
  setExpandedComposerDraft: (draftId: string | null) => void;
  selectedConversationId: string | null;
  conversationSelectionPending: boolean;
  stableConversationView: AgentCenterStableConversationView | null;
  setStableConversationView: Dispatch<SetStateAction<AgentCenterStableConversationView | null>>;
  isDraftConversationSelected: boolean;
  setSelectedConversationId: (conversationId: string | null) => void;
  startNewConversation: () => void;
  openConversationSummary: (summary: AgentRailConversationSummary) => Promise<void>;
  groups: AgentConversationGroup[];
  backends: AgentBackendInfo[];
  activeWorkspaceGroup: AgentConversationGroup | null;
  selectedConversationSummary: AgentRailConversationSummary | null;
  railLoading: boolean;
  railRefreshing: boolean;
  refreshConversationGroups: () => Promise<void>;
  archiveConversation: (conversationId: string) => void;
  unarchiveConversation: (conversationId: string) => void;
  pinnedRailConversations: AgentRailConversationSummary[];
  pinConversation: (conversationId: string) => void;
  unpinConversation: (conversationId: string) => void;
  railFilterToggles: AgentRailFilterToggleState;
  railFilterActive: boolean;
  setRailFilterToggle: (key: AgentRailFilterToggleKey, value: boolean) => void;
  clearRailFilters: () => void;
  isMobile: boolean;
};

const AgentShellStateContext =
  createContext<AgentShellStateContextValue | null>(null);

function getWorkspaceSessionBackupKey(
  serverId: string,
  workspaceId: string,
  windowId: string | null
): string {
  const sessionScopeId = windowId ? `${workspaceId}:window:${windowId}` : workspaceId;
  return buildServerScopedStorageKey("opencursor.workspace-session.", {
    serverBaseUrl: serverId,
    suffix: sessionScopeId,
  });
}

/** One global snapshot for the agent shell (rail + composed layout); not workspace- or window-scoped. */
const AGENT_SHELL_SHARED_STORAGE_KEY = "opencursor.agent-shell.shared";
const LEGACY_AGENT_SHELL_WINDOW_KEY_PREFIX = "opencursor.agent-shell.window.";

let agentShellLegacyStorageMigrationDone = false;

function migrateLegacyAgentShellWindowSnapshots(): void {
  if (typeof window === "undefined" || agentShellLegacyStorageMigrationDone) {
    return;
  }
  try {
    if (window.localStorage.getItem(AGENT_SHELL_SHARED_STORAGE_KEY)) {
      for (let i = window.localStorage.length - 1; i >= 0; i -= 1) {
        const k = window.localStorage.key(i);
        if (k?.startsWith(LEGACY_AGENT_SHELL_WINDOW_KEY_PREFIX)) {
          window.localStorage.removeItem(k);
        }
      }
      agentShellLegacyStorageMigrationDone = true;
      return;
    }
    const legacyKeys: string[] = [];
    for (let i = 0; i < window.localStorage.length; i += 1) {
      const k = window.localStorage.key(i);
      if (k?.startsWith(LEGACY_AGENT_SHELL_WINDOW_KEY_PREFIX)) {
        legacyKeys.push(k);
      }
    }
    if (legacyKeys.length === 0) {
      agentShellLegacyStorageMigrationDone = true;
      return;
    }
    legacyKeys.sort();
    let migratedFromLegacy = false;
    for (const key of legacyKeys) {
      const raw = window.localStorage.getItem(key);
      if (!raw) {
        continue;
      }
      const parsed = JSON.parse(raw) as AgentShellWindowSnapshot | null;
      if (!parsed || typeof parsed !== "object") {
        continue;
      }
      const snapshot: AgentShellWindowSnapshot = {
        leftRailCollapsed:
          typeof parsed.leftRailCollapsed === "boolean"
            ? parsed.leftRailCollapsed
            : undefined,
        agentShellDesktopLayout:
          normalizeAgentShellDesktopLayout(parsed.agentShellDesktopLayout) ?? null,
      };
      window.localStorage.setItem(
        AGENT_SHELL_SHARED_STORAGE_KEY,
        JSON.stringify({
          leftRailCollapsed: snapshot.leftRailCollapsed,
          agentShellDesktopLayout: snapshot.agentShellDesktopLayout,
        })
      );
      migratedFromLegacy = true;
      break;
    }
    if (migratedFromLegacy) {
      for (const k of legacyKeys) {
        window.localStorage.removeItem(k);
      }
    }
    agentShellLegacyStorageMigrationDone = true;
  } catch {
    // ignore
  }
}

function readAgentShellSharedSnapshot(): AgentShellWindowSnapshot | null {
  if (typeof window === "undefined") {
    return null;
  }
  try {
    migrateLegacyAgentShellWindowSnapshots();
    const raw = window.localStorage.getItem(AGENT_SHELL_SHARED_STORAGE_KEY);
    if (!raw) {
      return null;
    }
    const parsed = JSON.parse(raw) as AgentShellWindowSnapshot | null;
    if (!parsed || typeof parsed !== "object") {
      return null;
    }
    return {
      leftRailCollapsed:
        typeof parsed.leftRailCollapsed === "boolean"
          ? parsed.leftRailCollapsed
          : undefined,
      agentShellDesktopLayout:
        normalizeAgentShellDesktopLayout(parsed.agentShellDesktopLayout) ?? null,
    };
  } catch {
    return null;
  }
}

function writeAgentShellSharedSnapshot(snapshot: AgentShellWindowSnapshot) {
  if (typeof window === "undefined") {
    return;
  }
  try {
    window.localStorage.setItem(
      AGENT_SHELL_SHARED_STORAGE_KEY,
      JSON.stringify({
        leftRailCollapsed: snapshot.leftRailCollapsed,
        agentShellDesktopLayout:
          normalizeAgentShellDesktopLayout(snapshot.agentShellDesktopLayout) ?? null,
      })
    );
  } catch {
    // Ignore storage quota or private browsing failures.
  }
}

function readWorkspaceRailArchiveSnapshot(
  serverId: string,
  workspaceId: string,
  windowId: string | null
): WorkspaceRailArchiveSnapshot | null {
  if (typeof window === "undefined") {
    return null;
  }

  try {
    const raw = window.localStorage.getItem(
      getWorkspaceSessionBackupKey(serverId, workspaceId, windowId)
    );
    if (!raw) {
      return null;
    }
    const parsed = JSON.parse(raw) as { session?: WorkspaceSessionState | null } | null;
    const archivedConversationIds = parsed?.session?.agentView?.archivedConversationIds;
    if (!Array.isArray(archivedConversationIds)) {
      return null;
    }
    return {
      archivedConversationIds: archivedConversationIds.filter(
        (id): id is string => typeof id === "string"
      ),
    };
  } catch {
    return null;
  }
}

function stringArraysEqual(a: string[], b: string[]): boolean {
  if (a === b) {
    return true;
  }
  if (a.length !== b.length) {
    return false;
  }
  for (let i = 0; i < a.length; i += 1) {
    if (a[i] !== b[i]) {
      return false;
    }
  }
  return true;
}

function sortConversationGroups(
  groups: AgentConversationGroup[],
  recentWorkspaceIds: string[]
): AgentConversationGroup[] {
  const recentOrder = new Map(
    recentWorkspaceIds.map((workspaceId, index) => [workspaceId, index])
  );
  return [...groups].sort((a, b) => {
    const recentA = recentOrder.get(a.workspace.id);
    const recentB = recentOrder.get(b.workspace.id);
    if (recentA != null && recentB != null && recentA !== recentB) {
      return recentA - recentB;
    }
    if (recentA != null) {
      return -1;
    }
    if (recentB != null) {
      return 1;
    }
    return a.workspace.name.localeCompare(b.workspace.name);
  });
}

function findConversationOwnerWorkspaceId(
  groups: AgentConversationGroup[],
  conversationId: string
): string | null {
  for (const group of groups) {
    if (group.conversations.some((c) => c.id === conversationId)) {
      return group.workspace.id;
    }
  }
  return null;
}

function createLegacySidePaneSession(
  workspaceSession: ReturnType<typeof useWorkspace>["workspaceSession"]
): AgentSidePaneSessionState {
  return {
    editor: workspaceSession.editor,
    rightPaneOpen: workspaceSession.agentView.rightPaneOpen,
    agentShellDesktopLayout: extractAgentSidePaneScopedLayout(
      workspaceSession.agentView.agentShellDesktopLayout
    ),
    expandedComposerDraftId: null,
  };
}

function hasLegacySidePaneState(
  workspaceSession: ReturnType<typeof useWorkspace>["workspaceSession"]
): boolean {
  return (
    workspaceSession.editor.leftTabs.length > 0 ||
    workspaceSession.editor.rightTabs.length > 0 ||
    workspaceSession.agentView.rightPaneOpen ||
    workspaceSession.agentView.agentShellDesktopLayout != null
  );
}

export function AgentShellStateProvider({
  children,
}: {
  children: ReactNode;
}) {
  const { activeServerId } = useServerConnections();
  const {
    activeWorkspaceId,
    activeWindowId,
    openWorkspaceById,
    recentWorkspaceIds,
    sessionReady,
    workspaceInfo,
    workspaceSession,
    updateWorkspaceSession,
  } = useWorkspace();
  const { isMobile } = useViewport();
  const urlConversationId =
    typeof window !== "undefined"
      ? new URL(window.location.href).searchParams.get("conversationId")?.trim() || null
      : null;
  const replaceConversationIdInLocation = useCallback(
    (conversationId: string | null) => {
      if (typeof window === "undefined") {
        return;
      }
      const url = new URL(window.location.href);
      if (conversationId) {
        url.searchParams.set("conversationId", conversationId);
      } else {
        url.searchParams.delete("conversationId");
      }
      const nextUrl = `${url.pathname}${url.search}${url.hash}`;
      const currentUrl = `${window.location.pathname}${window.location.search}${window.location.hash}`;
      if (nextUrl !== currentUrl) {
        window.history.replaceState(null, "", nextUrl);
      }
    },
    []
  );
  const [groups, setGroups] = useState<AgentConversationGroup[]>([]);
  const [backends, setBackends] = useState<AgentBackendInfo[]>([]);
  const [railLoading, setRailLoading] = useState(true);
  const [railRefreshing, setRailRefreshing] = useState(false);
  const [pendingConversationSelection, setPendingConversationSelection] = useState<{
    workspaceId: string;
    conversationId: string;
  } | null>(null);
  const [archivedConversationIdsByWorkspaceId, setArchivedConversationIdsByWorkspaceId] =
    useState<Record<string, string[]>>({});
  const [stableConversationView, setStableConversationView] =
    useState<AgentCenterStableConversationView | null>(null);
  const [sharedLeftRailCollapsed, setSharedLeftRailCollapsedState] = useState(false);
  const [sharedAgentShellDesktopLayout, setSharedAgentShellDesktopLayoutState] =
    useState<Record<string, number> | null>(null);
  const previousEditorTabCountRef = useRef(0);
  const editorTabCountHydratedRef = useRef(false);
  const editorTabScopeRef = useRef<string | null>(null);
  const sharedLeftRailCollapsedRef = useRef(sharedLeftRailCollapsed);
  const sharedAgentShellDesktopLayoutRef = useRef(sharedAgentShellDesktopLayout);

  useEffect(() => {
    sharedLeftRailCollapsedRef.current = sharedLeftRailCollapsed;
  }, [sharedLeftRailCollapsed]);

  useEffect(() => {
    sharedAgentShellDesktopLayoutRef.current = sharedAgentShellDesktopLayout;
  }, [sharedAgentShellDesktopLayout]);

  const refreshConversationGroups = useCallback(async () => {
    const result = await listCrossWorkspaceAgentConversations();
    setBackends(result.backends);
    setGroups(result.groups);
  }, []);

  useEffect(() => {
    let active = true;
    setRailLoading(true);
    void refreshConversationGroups()
      .catch(() => undefined)
      .finally(() => {
        if (active) {
          setRailLoading(false);
        }
      });
    return () => {
      active = false;
    };
  }, [refreshConversationGroups]);

  const refreshConversationGroupsWithState = useCallback(async () => {
    setRailRefreshing(true);
    try {
      await refreshConversationGroups();
    } finally {
      setRailRefreshing(false);
    }
  }, [refreshConversationGroups]);

  useEffect(() => {
    const handleFocus = () => {
      void refreshConversationGroupsWithState();
    };
    const handleVisibility = () => {
      if (document.visibilityState === "visible") {
        void refreshConversationGroupsWithState();
      }
    };
    window.addEventListener("focus", handleFocus);
    document.addEventListener("visibilitychange", handleVisibility);
    return () => {
      window.removeEventListener("focus", handleFocus);
      document.removeEventListener("visibilitychange", handleVisibility);
    };
  }, [refreshConversationGroupsWithState]);

  useEffect(() => {
    if (!activeWorkspaceId) {
      return;
    }
    void refreshConversationGroups().catch(() => undefined);
  }, [activeWorkspaceId, refreshConversationGroups]);

  const orderedGroups = useMemo(
    () => sortConversationGroups(groups, recentWorkspaceIds),
    [groups, recentWorkspaceIds]
  );

  useEffect(() => {
    if (!activeWorkspaceId) {
      return;
    }
    const archivedConversationIds = workspaceSession.agentView.archivedConversationIds ?? [];
    setArchivedConversationIdsByWorkspaceId((current) => {
      const previous = current[activeWorkspaceId] ?? [];
      if (stringArraysEqual(previous, archivedConversationIds)) {
        return current;
      }
      return {
        ...current,
        [activeWorkspaceId]: [...archivedConversationIds],
      };
    });
  }, [activeWorkspaceId, workspaceSession.agentView.archivedConversationIds]);

  useEffect(() => {
    if (orderedGroups.length === 0) {
      return;
    }
    setArchivedConversationIdsByWorkspaceId((current) => {
      let changed = false;
      const next = { ...current };
      for (const group of orderedGroups) {
        const workspaceId = group.workspace.id;
        if (workspaceId === activeWorkspaceId) {
          continue;
        }
        const snapshot = readWorkspaceRailArchiveSnapshot(
          activeServerId,
          workspaceId,
          activeWindowId
        );
        if (!snapshot) {
          continue;
        }
        const previous = next[workspaceId] ?? [];
        if (stringArraysEqual(previous, snapshot.archivedConversationIds)) {
          continue;
        }
        next[workspaceId] = snapshot.archivedConversationIds;
        changed = true;
      }
      return changed ? next : current;
    });
  }, [activeServerId, activeWindowId, activeWorkspaceId, orderedGroups]);

  const activeWorkspaceGroup = useMemo(
    () => orderedGroups.find((group) => group.workspace.id === activeWorkspaceId) ?? null,
    [activeWorkspaceId, orderedGroups]
  );

  const validActiveConversationIds = useMemo(
    () => new Set(activeWorkspaceGroup?.conversations.map((conversation) => conversation.id) ?? []),
    [activeWorkspaceGroup]
  );

  const requestedConversationId =
    urlConversationId ?? workspaceSession.agentView.selectedConversationId;
  const isDraftConversationSelected =
    requestedConversationId === AGENT_NEW_CHAT_SESSION_ID;
  const persistedConversationRequest =
    workspaceSession.agentView.selectedConversationId &&
    workspaceSession.agentView.selectedConversationId !== AGENT_NEW_CHAT_SESSION_ID
      ? workspaceSession.agentView.selectedConversationId
      : null;
  const urlConversationRequest =
    urlConversationId && urlConversationId !== AGENT_NEW_CHAT_SESSION_ID
      ? urlConversationId
      : null;

  const selectedConversationId = useMemo(() => {
    if (isDraftConversationSelected) {
      return null;
    }

    if (
      pendingConversationSelection &&
      pendingConversationSelection.workspaceId === activeWorkspaceId
    ) {
      if (validActiveConversationIds.has(pendingConversationSelection.conversationId)) {
        return pendingConversationSelection.conversationId;
      }
      // Keep the explicit open request until the cross-workspace rail index includes it
      // (same race as freshly-created conversations).
      return pendingConversationSelection.conversationId;
    }

    // The URL deep-link must beat stale workspace session state during reload hydration.
    // Otherwise the session's "last selected" chat can overwrite the explicit ?conversationId=
    // before the rail list finishes loading, which snaps the user back to the most recent chat.
    if (urlConversationRequest) {
      if (validActiveConversationIds.has(urlConversationRequest)) {
        return urlConversationRequest;
      }
      if (railLoading) {
        return urlConversationRequest;
      }
      if (orderedGroups.length > 0) {
        const ownerWs = findConversationOwnerWorkspaceId(orderedGroups, urlConversationRequest);
        if (ownerWs != null) {
          // Workspace switching updates the URL and session asynchronously. If the old URL still
          // points at another workspace while the new workspace has already loaded, prefer the
          // active workspace's persisted request instead of snapping back to the old owner.
          if (
            ownerWs !== activeWorkspaceId &&
            persistedConversationRequest &&
            validActiveConversationIds.has(persistedConversationRequest)
          ) {
            return persistedConversationRequest;
          }
          return urlConversationRequest;
        }
      }
    }

    if (persistedConversationRequest) {
      if (validActiveConversationIds.has(persistedConversationRequest)) {
        return persistedConversationRequest;
      }
      // While the rail list is still fetching, hold the previous session id instead of falling
      // through to the first chat in the workspace.
      if (railLoading) {
        return persistedConversationRequest;
      }
      if (orderedGroups.length > 0 && activeWorkspaceId) {
        const ownerWs = findConversationOwnerWorkspaceId(
          orderedGroups,
          persistedConversationRequest
        );
        if (ownerWs != null && ownerWs !== activeWorkspaceId) {
          return persistedConversationRequest;
        }
      }
      // Rail index often lags right after POST /conversations + prompt: the new id is valid in
      // session/URL but not yet present in the cached groups payload. Honor the selection instead
      // of snapping to conversations[0] (which feels like "wrong chat" / missing rail row).
      return persistedConversationRequest;
    }

    return activeWorkspaceGroup?.conversations[0]?.id ?? null;
  }, [
    activeWorkspaceGroup,
    activeWorkspaceId,
    isDraftConversationSelected,
    orderedGroups,
    pendingConversationSelection,
    persistedConversationRequest,
    railLoading,
    urlConversationRequest,
    validActiveConversationIds,
  ]);

  useEffect(() => {
    if (pendingConversationSelection) {
      return;
    }
    if (railLoading || !activeWorkspaceId || orderedGroups.length === 0) {
      return;
    }
    if (isDraftConversationSelected) {
      return;
    }
    const req =
      urlConversationId && urlConversationId !== AGENT_NEW_CHAT_SESSION_ID
        ? urlConversationId
        : workspaceSession.agentView.selectedConversationId &&
            workspaceSession.agentView.selectedConversationId !== AGENT_NEW_CHAT_SESSION_ID
          ? workspaceSession.agentView.selectedConversationId
          : null;
    if (!req) {
      return;
    }
    const owner = findConversationOwnerWorkspaceId(orderedGroups, req);
    if (!owner || owner === activeWorkspaceId) {
      return;
    }
    void openWorkspaceById(owner);
  }, [
    activeWorkspaceId,
    isDraftConversationSelected,
    openWorkspaceById,
    orderedGroups,
    pendingConversationSelection,
    railLoading,
    urlConversationId,
    workspaceSession.agentView.selectedConversationId,
  ]);

  const selectedConversationSummary = useMemo(
    () =>
      activeWorkspaceGroup?.conversations.find(
        (conversation) => conversation.id === selectedConversationId
      ) ?? null,
    [activeWorkspaceGroup, selectedConversationId]
  );

  const persistedConversationId = isDraftConversationSelected
    ? AGENT_NEW_CHAT_SESSION_ID
    : selectedConversationId;

  const sidePaneScopeId = useMemo(
    () => getAgentSidePaneSessionScopeId(persistedConversationId),
    [persistedConversationId]
  );

  const sidePaneSessionMap = workspaceSession.agentView.sidePaneSessionsByConversationId ?? {};
  const hasAnySidePaneSessions = Object.keys(sidePaneSessionMap).length > 0;
  const legacySidePaneSession = useMemo(
    () => createLegacySidePaneSession(workspaceSession),
    [workspaceSession]
  );
  const activeSidePaneSession = useMemo(() => {
    const persisted = sidePaneSessionMap[sidePaneScopeId];
    if (persisted) {
      return persisted;
    }
    return hasAnySidePaneSessions
      ? createEmptyAgentSidePaneSession()
      : legacySidePaneSession;
  }, [
    hasAnySidePaneSessions,
    legacySidePaneSession,
    sidePaneScopeId,
    sidePaneSessionMap,
  ]);

  // Apply persisted global shell before paint. Never re-source rail/layout from per-workspace session
  // after that — session layout changes when switching workspaces and must not clobber user prefs.
  useLayoutEffect(() => {
    if (typeof window === "undefined") {
      return;
    }
    const snapshot = readAgentShellSharedSnapshot();
    if (!snapshot) {
      return;
    }
    if (typeof snapshot.leftRailCollapsed === "boolean") {
      setSharedLeftRailCollapsedState(snapshot.leftRailCollapsed);
    }
    if (snapshot.agentShellDesktopLayout != null) {
      setSharedAgentShellDesktopLayoutState(snapshot.agentShellDesktopLayout);
    }
  }, []);

  useEffect(() => {
    if (!sessionReady || !activeWorkspaceId || typeof window === "undefined") {
      return;
    }
    if (readAgentShellSharedSnapshot()?.agentShellDesktopLayout != null) {
      return;
    }
    const fallbackLayout =
      normalizeAgentShellDesktopLayout(workspaceSession.agentView.agentShellDesktopLayout) ?? null;
    const nextLeftRailCollapsed =
      typeof workspaceSession.agentView.leftRailCollapsed === "boolean"
        ? workspaceSession.agentView.leftRailCollapsed
        : false;
    if (fallbackLayout == null) {
      return;
    }
    setSharedLeftRailCollapsedState(nextLeftRailCollapsed);
    setSharedAgentShellDesktopLayoutState(fallbackLayout);
    writeAgentShellSharedSnapshot({
      leftRailCollapsed: nextLeftRailCollapsed,
      agentShellDesktopLayout: fallbackLayout,
    });
  }, [
    activeWorkspaceId,
    sessionReady,
    workspaceSession.agentView.agentShellDesktopLayout,
    workspaceSession.agentView.leftRailCollapsed,
  ]);

  const effectiveAgentShellDesktopLayout = useMemo(
    () =>
      composeAgentShellDesktopLayout(
        sharedAgentShellDesktopLayout,
        activeSidePaneSession.agentShellDesktopLayout
      ),
    [
      activeSidePaneSession.agentShellDesktopLayout,
      sharedAgentShellDesktopLayout,
    ]
  );

  useEffect(() => {
    const sessions = workspaceSession.agentView.sidePaneSessionsByConversationId ?? {};
    const needsSanitization = Object.values(sessions).some(
      (session) => !isAgentSidePaneScopedLayout(session.agentShellDesktopLayout)
    );
    if (!needsSanitization) {
      return;
    }
    updateWorkspaceSession((current) => {
      const currentSessions = current.agentView.sidePaneSessionsByConversationId ?? {};
      let changed = false;
      const nextSessions = Object.fromEntries(
        Object.entries(currentSessions).map(([scopeId, session]) => {
          if (isAgentSidePaneScopedLayout(session.agentShellDesktopLayout)) {
            return [scopeId, session];
          }
          changed = true;
          return [
            scopeId,
            {
              ...session,
              agentShellDesktopLayout: extractAgentSidePaneScopedLayout(
                session.agentShellDesktopLayout
              ),
            },
          ];
        })
      );
      if (!changed) {
        return current;
      }
      return {
        ...current,
        agentView: {
          ...current.agentView,
          sidePaneSessionsByConversationId: nextSessions,
        },
      };
    });
  }, [
    updateWorkspaceSession,
    workspaceSession.agentView.sidePaneSessionsByConversationId,
  ]);

  useEffect(() => {
    if (
      pendingConversationSelection &&
      pendingConversationSelection.workspaceId !== activeWorkspaceId
    ) {
      return;
    }
    if (workspaceSession.agentView.selectedConversationId === persistedConversationId) {
      return;
    }
    // Never clobber a real persisted id with null while the rail is still loading — same race
    // as `selectedConversationId` (empty valid set during fetch).
    if (
      railLoading &&
      persistedConversationId == null &&
      workspaceSession.agentView.selectedConversationId != null &&
      workspaceSession.agentView.selectedConversationId !== AGENT_NEW_CHAT_SESSION_ID
    ) {
      return;
    }
    updateWorkspaceSession((current) => ({
      ...current,
      agentView: {
        ...current.agentView,
        selectedConversationId: persistedConversationId,
      },
    }));
  }, [
    activeWorkspaceId,
    pendingConversationSelection,
    persistedConversationId,
    railLoading,
    updateWorkspaceSession,
    workspaceSession.agentView.selectedConversationId,
  ]);

  useEffect(() => {
    if (
      pendingConversationSelection &&
      pendingConversationSelection.workspaceId !== activeWorkspaceId
    ) {
      return;
    }
    if (
      railLoading &&
      persistedConversationId == null &&
      workspaceSession.agentView.selectedConversationId != null &&
      workspaceSession.agentView.selectedConversationId !== AGENT_NEW_CHAT_SESSION_ID
    ) {
      return;
    }
    replaceConversationIdInLocation(persistedConversationId);
  }, [
    activeWorkspaceId,
    pendingConversationSelection,
    persistedConversationId,
    railLoading,
    replaceConversationIdInLocation,
    workspaceSession.agentView.selectedConversationId,
  ]);

  useEffect(() => {
    if (hasAnySidePaneSessions || !hasLegacySidePaneState(workspaceSession)) {
      return;
    }
    updateWorkspaceSession((current) => {
      const existingSessions = current.agentView.sidePaneSessionsByConversationId ?? {};
      if (Object.keys(existingSessions).length > 0) {
        return current;
      }
      return {
        ...current,
        agentView: {
          ...current.agentView,
          sidePaneSessionsByConversationId: {
            [sidePaneScopeId]: createLegacySidePaneSession(current),
          },
        },
      };
    });
  }, [
    hasAnySidePaneSessions,
    sidePaneScopeId,
    updateWorkspaceSession,
    workspaceSession,
  ]);

  useEffect(() => {
    const scopeKey = `${activeWorkspaceId ?? "workspace"}:${sidePaneScopeId}`;
    if (editorTabScopeRef.current !== scopeKey) {
      editorTabScopeRef.current = scopeKey;
      editorTabCountHydratedRef.current = false;
      previousEditorTabCountRef.current = 0;
    }
  }, [activeWorkspaceId, sidePaneScopeId]);

  useEffect(() => {
    const nextEditorTabCount =
      activeSidePaneSession.editor.leftTabs.length +
      activeSidePaneSession.editor.rightTabs.length;
    if (!editorTabCountHydratedRef.current) {
      editorTabCountHydratedRef.current = true;
      previousEditorTabCountRef.current = nextEditorTabCount;
      return;
    }
    if (nextEditorTabCount > previousEditorTabCountRef.current) {
      updateWorkspaceSession((current) => {
        const sessions = current.agentView.sidePaneSessionsByConversationId ?? {};
        const existing =
          sessions[sidePaneScopeId] ??
          (Object.keys(sessions).length > 0
            ? createEmptyAgentSidePaneSession()
            : createLegacySidePaneSession(current));
        if (existing.rightPaneOpen || nextEditorTabCount === 0) {
          return current;
        }
        return {
          ...current,
          agentView: {
            ...current.agentView,
            sidePaneSessionsByConversationId: {
              ...sessions,
              [sidePaneScopeId]: {
                ...existing,
                rightPaneOpen: false,
              },
            },
          },
        };
      });
    } else if (nextEditorTabCount === 0 && previousEditorTabCountRef.current > 0) {
      updateWorkspaceSession((current) => {
        const sessions = current.agentView.sidePaneSessionsByConversationId ?? {};
        const existing =
          sessions[sidePaneScopeId] ??
          (Object.keys(sessions).length > 0
            ? createEmptyAgentSidePaneSession()
            : createLegacySidePaneSession(current));
        if (!existing.rightPaneOpen) {
          return current;
        }
        return {
          ...current,
          agentView: {
            ...current.agentView,
            sidePaneSessionsByConversationId: {
              ...sessions,
              [sidePaneScopeId]: {
                ...existing,
                rightPaneOpen: false,
              },
            },
          },
        };
      });
    }
    previousEditorTabCountRef.current = nextEditorTabCount;
  }, [
    activeSidePaneSession.editor.leftTabs.length,
    activeSidePaneSession.editor.rightTabs.length,
    sidePaneScopeId,
    updateWorkspaceSession,
  ]);

  const setLeftRailCollapsed = useCallback((collapsed: boolean) => {
    setSharedLeftRailCollapsedState(collapsed);
    writeAgentShellSharedSnapshot({
      leftRailCollapsed: collapsed,
      agentShellDesktopLayout: sharedAgentShellDesktopLayoutRef.current,
    });
  }, []);

  const toggleLeftRailCollapsed = useCallback(() => {
    setLeftRailCollapsed(!sharedLeftRailCollapsed);
  }, [setLeftRailCollapsed, sharedLeftRailCollapsed]);

  const setRightPaneOpen = useCallback(
    (open: boolean) => {
      updateWorkspaceSession((current) => ({
        ...current,
        agentView: {
          ...current.agentView,
          sidePaneSessionsByConversationId: {
            ...(current.agentView.sidePaneSessionsByConversationId ?? {}),
            [sidePaneScopeId]: {
              ...((current.agentView.sidePaneSessionsByConversationId ?? {})[
                sidePaneScopeId
              ] ??
                (Object.keys(current.agentView.sidePaneSessionsByConversationId ?? {}).length > 0
                  ? createEmptyAgentSidePaneSession()
                  : createLegacySidePaneSession(current))),
              rightPaneOpen: open,
            },
          },
        },
      }));
    },
    [sidePaneScopeId, updateWorkspaceSession]
  );

  const toggleRightPaneOpen = useCallback(() => {
    setRightPaneOpen(!activeSidePaneSession.rightPaneOpen);
  }, [activeSidePaneSession.rightPaneOpen, setRightPaneOpen]);

  const updateSidePaneEditorSession = useCallback(
    (updater: (current: EditorSessionState) => EditorSessionState) => {
      updateWorkspaceSession((current) => {
        const sessions = current.agentView.sidePaneSessionsByConversationId ?? {};
        const existing =
          sessions[sidePaneScopeId] ??
          (Object.keys(sessions).length > 0
            ? createEmptyAgentSidePaneSession()
            : createLegacySidePaneSession(current));
        const nextEditor = updater(existing.editor);
        if (nextEditor === existing.editor) {
          return current;
        }
        return {
          ...current,
          agentView: {
            ...current.agentView,
            sidePaneSessionsByConversationId: {
              ...sessions,
              [sidePaneScopeId]: {
                ...existing,
                editor: nextEditor,
              },
            },
          },
        };
      });
    },
    [sidePaneScopeId, updateWorkspaceSession]
  );

  const setAgentShellDesktopLayout = useCallback(
    (layout: Record<string, number> | null) => {
      const normalizedLayout = normalizeAgentShellDesktopLayout(layout);
      const sharedLayout =
        normalizeAgentShellDesktopLayout(sharedAgentShellDesktopLayoutRef.current) ??
        normalizeAgentShellDesktopLayout(activeSidePaneSession.agentShellDesktopLayout) ??
        AGENT_SHELL_DEFAULT_LAYOUT;
      const scopedLayout =
        normalizeAgentShellDesktopLayout(activeSidePaneSession.agentShellDesktopLayout) ??
        sharedLayout;
      const nextLayout =
        composeAgentShellDesktopLayout(
          {
            ...sharedLayout,
            [AGENT_SHELL_PANEL_IDS.rail]:
              normalizedLayout?.[AGENT_SHELL_PANEL_IDS.rail] &&
              normalizedLayout[AGENT_SHELL_PANEL_IDS.rail] > 0
                ? normalizedLayout[AGENT_SHELL_PANEL_IDS.rail]
                : sharedLayout[AGENT_SHELL_PANEL_IDS.rail],
          },
          {
            ...scopedLayout,
            [AGENT_SHELL_PANEL_IDS.side]:
              normalizedLayout?.[AGENT_SHELL_PANEL_IDS.side] &&
              normalizedLayout[AGENT_SHELL_PANEL_IDS.side] > 0
                ? normalizedLayout[AGENT_SHELL_PANEL_IDS.side]
                : scopedLayout[AGENT_SHELL_PANEL_IDS.side],
          }
        ) ?? AGENT_SHELL_DEFAULT_LAYOUT;
      const nextScopedLayout = extractAgentSidePaneScopedLayout(nextLayout);
      setSharedAgentShellDesktopLayoutState(nextLayout);
      writeAgentShellSharedSnapshot({
        leftRailCollapsed: sharedLeftRailCollapsedRef.current,
        agentShellDesktopLayout: nextLayout,
      });
      updateWorkspaceSession((current) => {
        const sessions = current.agentView.sidePaneSessionsByConversationId ?? {};
        const existing =
          sessions[sidePaneScopeId] ??
          (Object.keys(sessions).length > 0
            ? createEmptyAgentSidePaneSession()
            : createLegacySidePaneSession(current));
        return {
          ...current,
          agentView: {
            ...current.agentView,
            sidePaneSessionsByConversationId: {
              ...sessions,
              [sidePaneScopeId]: {
                ...existing,
                agentShellDesktopLayout: nextScopedLayout,
              },
            },
          },
        };
      });
    },
    [activeSidePaneSession.agentShellDesktopLayout, sidePaneScopeId, updateWorkspaceSession]
  );

  const setExpandedComposerDraft = useCallback(
    (draftId: string | null) => {
      updateWorkspaceSession((current) => {
        const sessions = current.agentView.sidePaneSessionsByConversationId ?? {};
        const existing =
          sessions[sidePaneScopeId] ??
          (Object.keys(sessions).length > 0
            ? createEmptyAgentSidePaneSession()
            : createLegacySidePaneSession(current));
        if (existing.expandedComposerDraftId === draftId) {
          return current;
        }
        return {
          ...current,
          agentView: {
            ...current.agentView,
            sidePaneSessionsByConversationId: {
              ...sessions,
              [sidePaneScopeId]: {
                ...existing,
                expandedComposerDraftId: draftId,
              },
            },
          },
        };
      });
    },
    [sidePaneScopeId, updateWorkspaceSession]
  );

  const setSelectedConversationId = useCallback(
    (conversationId: string | null) => {
      updateWorkspaceSession((current) => ({
        ...current,
        agentView: {
          ...current.agentView,
          selectedConversationId: conversationId,
        },
      }));
      replaceConversationIdInLocation(conversationId);
    },
    [replaceConversationIdInLocation, updateWorkspaceSession]
  );

  const startNewConversation = useCallback(() => {
    updateWorkspaceSession((current) => ({
      ...current,
      agentView: {
        ...current.agentView,
        selectedConversationId: AGENT_NEW_CHAT_SESSION_ID,
      },
    }));
    replaceConversationIdInLocation(AGENT_NEW_CHAT_SESSION_ID);
  }, [replaceConversationIdInLocation, updateWorkspaceSession]);

  const openConversationSummary = useCallback(
    async (summary: AgentRailConversationSummary) => {
      const archiveSnapshot = readWorkspaceRailArchiveSnapshot(
        activeServerId,
        summary.workspaceId,
        activeWindowId
      );
      if (archiveSnapshot) {
        setArchivedConversationIdsByWorkspaceId((current) => {
          const previous = current[summary.workspaceId] ?? [];
          if (stringArraysEqual(previous, archiveSnapshot.archivedConversationIds)) {
            return current;
          }
          return {
            ...current,
            [summary.workspaceId]: archiveSnapshot.archivedConversationIds,
          };
        });
      }
      setPendingConversationSelection({
        workspaceId: summary.workspaceId,
        conversationId: summary.id,
      });
      try {
        if (summary.workspaceId !== activeWorkspaceId) {
          await openWorkspaceById(summary.workspaceId);
        }
        setSelectedConversationId(summary.id);
      } catch (error) {
        throw error;
      } finally {
        setPendingConversationSelection((current) =>
          current?.workspaceId === summary.workspaceId && current.conversationId === summary.id
            ? null
            : current
        );
      }
    },
    [
      activeServerId,
      activeWindowId,
      activeWorkspaceId,
      openWorkspaceById,
      setSelectedConversationId,
    ]
  );

  const archiveConversation = useCallback(
    (conversationId: string) => {
      updateWorkspaceSession((current) => {
        const archived = current.agentView.archivedConversationIds ?? [];
        if (archived.includes(conversationId)) return current;
        return {
          ...current,
          agentView: {
            ...current.agentView,
            archivedConversationIds: [...archived, conversationId],
          },
        };
      });
    },
    [updateWorkspaceSession]
  );

  const unarchiveConversation = useCallback(
    (conversationId: string) => {
      updateWorkspaceSession((current) => {
        const archived = current.agentView.archivedConversationIds ?? [];
        if (!archived.includes(conversationId)) return current;
        return {
          ...current,
          agentView: {
            ...current.agentView,
            archivedConversationIds: archived.filter((id) => id !== conversationId),
          },
        };
      });
    },
    [updateWorkspaceSession]
  );

  const pinConversation = useCallback(
    (conversationId: string) => {
      const prev = getGlobalPinnedAgentConversationIdsSnapshot();
      const next = [conversationId, ...prev.filter((id) => id !== conversationId)];
      writeGlobalPinnedAgentConversationIds(next);
      updateWorkspaceSession((current) => ({
        ...current,
        agentView: {
          ...current.agentView,
          pinnedAgentConversationIds: next,
        },
      }));
    },
    [updateWorkspaceSession]
  );

  const unpinConversation = useCallback(
    (conversationId: string) => {
      const prev = getGlobalPinnedAgentConversationIdsSnapshot();
      if (!prev.includes(conversationId)) {
        return;
      }
      const next = prev.filter((id) => id !== conversationId);
      writeGlobalPinnedAgentConversationIds(next);
      updateWorkspaceSession((current) => ({
        ...current,
        agentView: {
          ...current.agentView,
          pinnedAgentConversationIds: next,
        },
      }));
    },
    [updateWorkspaceSession]
  );

  const railFilterToggles = useMemo(
    () =>
      normalizeAgentRailFilterToggles(
        workspaceSession.agentView.railFilterToggles,
        workspaceSession.agentView.filterPreset
      ),
    [workspaceSession.agentView.filterPreset, workspaceSession.agentView.railFilterToggles]
  );

  const railFilterActive = useMemo(
    () => isAgentRailFilterActive(railFilterToggles),
    [railFilterToggles]
  );

  const setRailFilterToggle = useCallback(
    (key: AgentRailFilterToggleKey, value: boolean) => {
      updateWorkspaceSession((current) => {
        const prev = normalizeAgentRailFilterToggles(
          current.agentView.railFilterToggles,
          current.agentView.filterPreset
        );
        const next = { ...prev, [key]: value };
        return {
          ...current,
          agentView: {
            ...current.agentView,
            railFilterToggles: next,
            filterPreset: "default",
          },
        };
      });
    },
    [updateWorkspaceSession]
  );

  const clearRailFilters = useCallback(() => {
    updateWorkspaceSession((current) => ({
      ...current,
      agentView: {
        ...current.agentView,
        railFilterToggles: defaultAgentRailFilterToggles(),
        filterPreset: "default",
      },
    }));
  }, [updateWorkspaceSession]);

  /**
   * While a workspace is loading, `workspaceInfo`/`activeWorkspaceId` already point at the new
   * workspace but `workspaceSession` can still be the previous workspace's blob. Using its
   * archived ids would mis-filter the new workspace's rail (archived/pinned placement flash).
   */
  const activeWorkspaceResolvedArchives = useMemo(() => {
    if (!activeWorkspaceId) {
      return [];
    }
    const sessionAligned =
      sessionReady && workspaceInfo?.id === activeWorkspaceId;
    if (sessionAligned) {
      return workspaceSession.agentView.archivedConversationIds ?? [];
    }
    const cached = archivedConversationIdsByWorkspaceId[activeWorkspaceId] ?? [];
    if (cached.length > 0) {
      return cached;
    }
    return (
      readWorkspaceRailArchiveSnapshot(
        activeServerId,
        activeWorkspaceId,
        activeWindowId
      )?.archivedConversationIds ??
      []
    );
  }, [
    activeServerId,
    activeWorkspaceId,
    activeWindowId,
    archivedConversationIdsByWorkspaceId,
    sessionReady,
    workspaceInfo?.id,
    workspaceSession.agentView.archivedConversationIds,
  ]);

  const archivedConversationIdsSet = useMemo(
    () => new Set(activeWorkspaceResolvedArchives),
    [activeWorkspaceResolvedArchives]
  );

  const pinnedAgentConversationIds = useSyncExternalStore(
    subscribeGlobalPinnedAgentConversationIds,
    getGlobalPinnedAgentConversationIdsSnapshot,
    () => []
  );

  useLayoutEffect(() => {
    if (!sessionReady || typeof window === "undefined") {
      return;
    }
    migrateGlobalPinnedAgentConversationIdsIfNeeded(
      workspaceSession.agentView.pinnedAgentConversationIds
    );
  }, [sessionReady, workspaceSession.agentView.pinnedAgentConversationIds]);

  const pinnedConversationIdSet = useMemo(
    () => new Set(pinnedAgentConversationIds),
    [pinnedAgentConversationIds]
  );

  const railFilterMatchContext = useMemo(
    () => ({
      archivedConversationIds: archivedConversationIdsSet,
      pinnedConversationIds: pinnedConversationIdSet,
      unreadCompletionByConversationId:
        workspaceSession.chat.unreadChatCompletionByConversationId,
    }),
    [
      archivedConversationIdsSet,
      pinnedConversationIdSet,
      workspaceSession.chat.unreadChatCompletionByConversationId,
    ]
  );
  const emptyConversationIdSet = useMemo(() => new Set<string>(), []);
  const archivedConversationIdSetByWorkspaceId = useMemo(() => {
    const sets = new Map<string, Set<string>>();
    for (const group of orderedGroups) {
      const workspaceId = group.workspace.id;
      const archivedConversationIds =
        workspaceId === activeWorkspaceId
          ? activeWorkspaceResolvedArchives
          : (archivedConversationIdsByWorkspaceId[workspaceId] ?? []);
      sets.set(workspaceId, new Set(archivedConversationIds));
    }
    return sets;
  }, [
    activeWorkspaceId,
    activeWorkspaceResolvedArchives,
    archivedConversationIdsByWorkspaceId,
    orderedGroups,
  ]);

  const filteredGroups = useMemo(
    () =>
      orderedGroups.map((group) => ({
        ...group,
        conversations: group.conversations.filter((c) =>
          matchesAgentRailMultiFilter(c, railFilterToggles, {
            ...railFilterMatchContext,
            archivedConversationIds:
              archivedConversationIdSetByWorkspaceId.get(group.workspace.id) ??
              emptyConversationIdSet,
          })
        ),
      })),
    [
      archivedConversationIdSetByWorkspaceId,
      emptyConversationIdSet,
      orderedGroups,
      railFilterMatchContext,
      railFilterToggles,
    ]
  );

  const pinnedRailConversations = useMemo(() => {
    const byId = new Map<string, AgentRailConversationSummary>();
    for (const group of orderedGroups) {
      for (const c of group.conversations) {
        byId.set(c.id, c);
      }
    }
    return pinnedAgentConversationIds
      .map((id) => byId.get(id))
      .filter((c): c is AgentRailConversationSummary => {
        if (!c) {
          return false;
        }
        const archivedForWorkspace =
          archivedConversationIdSetByWorkspaceId.get(c.workspaceId) ?? emptyConversationIdSet;
        return matchesAgentRailMultiFilter(c, railFilterToggles, {
          ...railFilterMatchContext,
          archivedConversationIds: archivedForWorkspace,
        });
      });
  }, [
    archivedConversationIdSetByWorkspaceId,
    emptyConversationIdSet,
    orderedGroups,
    pinnedAgentConversationIds,
    railFilterMatchContext,
    railFilterToggles,
  ]);

  const groupsForRail = useMemo(
    () =>
      filteredGroups.map((group) => ({
        ...group,
        conversations: group.conversations.filter((c) => !pinnedConversationIdSet.has(c.id)),
      })),
    [filteredGroups, pinnedConversationIdSet]
  );

  const value = useMemo<AgentShellStateContextValue>(
    () => ({
      leftRailCollapsed: sharedLeftRailCollapsed,
      setLeftRailCollapsed,
      toggleLeftRailCollapsed,
      rightPaneOpen: activeSidePaneSession.rightPaneOpen,
      setRightPaneOpen,
      toggleRightPaneOpen,
      sidePaneScopeId,
      sidePaneEditorSession: activeSidePaneSession.editor,
      updateSidePaneEditorSession,
      agentShellDesktopLayout: effectiveAgentShellDesktopLayout,
      setAgentShellDesktopLayout,
      expandedComposerDraftId: activeSidePaneSession.expandedComposerDraftId,
      setExpandedComposerDraft,
      selectedConversationId,
      conversationSelectionPending: pendingConversationSelection != null,
      stableConversationView,
      setStableConversationView,
      isDraftConversationSelected,
      setSelectedConversationId,
      startNewConversation,
      openConversationSummary,
      groups: groupsForRail,
      backends,
      activeWorkspaceGroup,
      selectedConversationSummary,
      railLoading,
      railRefreshing,
      refreshConversationGroups: refreshConversationGroupsWithState,
      archiveConversation,
      unarchiveConversation,
      pinnedRailConversations,
      pinConversation,
      unpinConversation,
      railFilterToggles,
      railFilterActive,
      setRailFilterToggle,
      clearRailFilters,
      isMobile,
    }),
    [
      activeWorkspaceGroup,
      activeSidePaneSession.editor,
      activeSidePaneSession.expandedComposerDraftId,
      activeSidePaneSession.rightPaneOpen,
      effectiveAgentShellDesktopLayout,
      archiveConversation,
      backends,
      clearRailFilters,
      pendingConversationSelection,
      groupsForRail,
      isMobile,
      isDraftConversationSelected,
      openConversationSummary,
      pinConversation,
      pinnedRailConversations,
      railFilterActive,
      railFilterToggles,
      railLoading,
      railRefreshing,
      refreshConversationGroupsWithState,
      selectedConversationId,
      selectedConversationSummary,
      stableConversationView,
      setAgentShellDesktopLayout,
      setExpandedComposerDraft,
      setRailFilterToggle,
      setLeftRailCollapsed,
      setRightPaneOpen,
      setSelectedConversationId,
      sidePaneScopeId,
      startNewConversation,
      toggleLeftRailCollapsed,
      toggleRightPaneOpen,
      unarchiveConversation,
      unpinConversation,
      updateSidePaneEditorSession,
      sharedLeftRailCollapsed,
    ]
  );

  return (
    <AgentShellStateContext.Provider value={value}>
      {children}
    </AgentShellStateContext.Provider>
  );
}

export function useAgentShellState(): AgentShellStateContextValue {
  const value = useContext(AgentShellStateContext);
  if (!value) {
    throw new Error(
      "useAgentShellState must be used within AgentShellStateProvider"
    );
  }
  return value;
}

/** Same as `useAgentShellState` but returns null outside the agent shell (e.g. IDE-only layout). */
export function useAgentShellStateMaybe(): AgentShellStateContextValue | null {
  return useContext(AgentShellStateContext);
}
