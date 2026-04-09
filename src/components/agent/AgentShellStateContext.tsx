"use client";

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { useViewport } from "@/hooks/useViewport";
import type {
  AgentBackendInfo,
  AgentConversationGroup,
  AgentRailConversationSummary,
} from "@/lib/agent-types";
import { listCrossWorkspaceAgentConversations } from "@/lib/server-api";
import {
  defaultAgentRailFilterToggles,
  isAgentRailFilterActive,
  matchesAgentRailMultiFilter,
  normalizeAgentRailFilterToggles,
  type AgentRailFilterToggleKey,
  type AgentRailFilterToggleState,
} from "@/lib/agent-rail";
import { useWorkspace } from "@/contexts/WorkspaceContext";
import {
  AGENT_NEW_CHAT_SESSION_ID,
  createEmptyAgentSidePaneSession,
  getAgentSidePaneSessionScopeId,
  type AgentSidePaneSessionState,
  type EditorSessionState,
} from "@/lib/workspace-session";

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
    agentShellDesktopLayout: workspaceSession.agentView.agentShellDesktopLayout,
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
  const {
    activeWorkspaceId,
    openWorkspaceById,
    recentWorkspaceIds,
    workspaceSession,
    updateWorkspaceSession,
  } = useWorkspace();
  const { isMobile } = useViewport();
  const router = useRouter();
  const searchParams = useSearchParams();
  const urlConversationId = searchParams.get("conversationId")?.trim() || null;
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
        router.replace(nextUrl);
      }
    },
    [router]
  );
  const [groups, setGroups] = useState<AgentConversationGroup[]>([]);
  const [backends, setBackends] = useState<AgentBackendInfo[]>([]);
  const [railLoading, setRailLoading] = useState(true);
  const [railRefreshing, setRailRefreshing] = useState(false);
  const previousEditorTabCountRef = useRef(0);
  const editorTabCountHydratedRef = useRef(false);
  const editorTabScopeRef = useRef<string | null>(null);

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
    void refreshConversationGroupsWithState();
  }, [activeWorkspaceId, refreshConversationGroupsWithState]);

  const orderedGroups = useMemo(
    () => sortConversationGroups(groups, recentWorkspaceIds),
    [groups, recentWorkspaceIds]
  );

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
    }

    return activeWorkspaceGroup?.conversations[0]?.id ?? null;
  }, [
    activeWorkspaceGroup,
    activeWorkspaceId,
    isDraftConversationSelected,
    orderedGroups,
    persistedConversationRequest,
    railLoading,
    urlConversationRequest,
    validActiveConversationIds,
  ]);

  useEffect(() => {
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

  useEffect(() => {
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
    persistedConversationId,
    railLoading,
    updateWorkspaceSession,
    workspaceSession.agentView.selectedConversationId,
  ]);

  useEffect(() => {
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

  const setLeftRailCollapsed = useCallback(
    (collapsed: boolean) => {
      updateWorkspaceSession((current) => ({
        ...current,
        agentView: {
          ...current.agentView,
          leftRailCollapsed: collapsed,
        },
      }));
    },
    [updateWorkspaceSession]
  );

  const toggleLeftRailCollapsed = useCallback(() => {
    setLeftRailCollapsed(!workspaceSession.agentView.leftRailCollapsed);
  }, [setLeftRailCollapsed, workspaceSession.agentView.leftRailCollapsed]);

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
                agentShellDesktopLayout: layout,
              },
            },
          },
        };
      });
    },
    [sidePaneScopeId, updateWorkspaceSession]
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
      if (summary.workspaceId !== activeWorkspaceId) {
        await openWorkspaceById(summary.workspaceId);
      }
      setSelectedConversationId(summary.id);
    },
    [activeWorkspaceId, openWorkspaceById, setSelectedConversationId]
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
      updateWorkspaceSession((current) => {
        const pinned = current.agentView.pinnedAgentConversationIds ?? [];
        const next = [conversationId, ...pinned.filter((id) => id !== conversationId)];
        if (next.length === pinned.length && next[0] === pinned[0]) {
          return current;
        }
        return {
          ...current,
          agentView: {
            ...current.agentView,
            pinnedAgentConversationIds: next,
          },
        };
      });
    },
    [updateWorkspaceSession]
  );

  const unpinConversation = useCallback(
    (conversationId: string) => {
      updateWorkspaceSession((current) => {
        const pinned = current.agentView.pinnedAgentConversationIds ?? [];
        if (!pinned.includes(conversationId)) return current;
        return {
          ...current,
          agentView: {
            ...current.agentView,
            pinnedAgentConversationIds: pinned.filter((id) => id !== conversationId),
          },
        };
      });
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

  const archivedConversationIdsSet = useMemo(
    () => new Set(workspaceSession.agentView.archivedConversationIds ?? []),
    [workspaceSession.agentView.archivedConversationIds]
  );

  const pinnedAgentConversationIds = workspaceSession.agentView.pinnedAgentConversationIds ?? [];
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

  const filteredGroups = useMemo(
    () =>
      orderedGroups.map((group) => ({
        ...group,
        conversations: group.conversations.filter((c) =>
          matchesAgentRailMultiFilter(c, railFilterToggles, railFilterMatchContext)
        ),
      })),
    [orderedGroups, railFilterMatchContext, railFilterToggles]
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
      .filter(
        (c): c is AgentRailConversationSummary =>
          !!c &&
          matchesAgentRailMultiFilter(c, railFilterToggles, railFilterMatchContext)
      );
  }, [
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
      leftRailCollapsed: workspaceSession.agentView.leftRailCollapsed,
      setLeftRailCollapsed,
      toggleLeftRailCollapsed,
      rightPaneOpen: activeSidePaneSession.rightPaneOpen,
      setRightPaneOpen,
      toggleRightPaneOpen,
      sidePaneScopeId,
      sidePaneEditorSession: activeSidePaneSession.editor,
      updateSidePaneEditorSession,
      agentShellDesktopLayout: activeSidePaneSession.agentShellDesktopLayout,
      setAgentShellDesktopLayout,
      expandedComposerDraftId: activeSidePaneSession.expandedComposerDraftId,
      setExpandedComposerDraft,
      selectedConversationId,
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
      activeSidePaneSession.agentShellDesktopLayout,
      activeSidePaneSession.editor,
      activeSidePaneSession.expandedComposerDraftId,
      activeSidePaneSession.rightPaneOpen,
      archiveConversation,
      backends,
      clearRailFilters,
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
      workspaceSession.agentView.leftRailCollapsed,
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
