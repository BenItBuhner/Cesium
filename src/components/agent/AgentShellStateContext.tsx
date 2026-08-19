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
import {
  listCrossWorkspaceAgentConversations,
  listCrossWorkspaceAgentConversationsForServer,
  patchAgentConversationMetadata,
} from "@/lib/server-api";
import {
  safeReadLocationSearchParam,
  safeReplaceLocationSearchParams,
} from "@/lib/safe-url";
import { useServerConnections } from "@/components/preferences/ServerConnectionsProvider";
import type { ServerRuntimeStatus } from "@/components/preferences/ServerConnectionsProvider";
import {
  AGENT_SHELL_DEFAULT_LAYOUT,
  AGENT_SHELL_PANEL_IDS,
  composeAgentShellDesktopLayout,
  extractAgentSidePaneScopedLayout,
  isAgentSidePaneScopedLayout,
  normalizeAgentShellDesktopLayout,
  readAgentShellSharedSnapshot,
  writeAgentShellSharedSnapshot,
} from "@/components/agent/agent-shell-layout";
import {
  defaultAgentRailFilterToggles,
  isRenderableAgentRailConversation,
  isAgentRailFilterActive,
  matchesAgentRailMultiFilter,
  normalizeAgentRailFilterToggles,
  type AgentRailFilterToggleKey,
  type AgentRailFilterToggleState,
} from "@/lib/agent-rail";
import { agentRailConversationNeedsAttention } from "@/lib/agent-rail-status";
import {
  getGlobalPinnedAgentConversationIdsSnapshot,
  migrateGlobalPinnedAgentConversationIdsIfNeeded,
  subscribeGlobalPinnedAgentConversationIds,
  writeGlobalPinnedAgentConversationIds,
} from "@/lib/agent-rail-pins";
import {
  resolveAgentRightPaneOpen,
  shouldRestorePersistedRightPaneOpen,
} from "@/lib/agent-right-pane";
import {
  resolveLeftRailCollapsed,
  shouldRestorePersistedLeftRailCollapsed,
} from "@/lib/agent-left-rail";
import {
  AGENT_CONVERSATION_DELETED_EVENT,
  AGENT_CONVERSATION_UPSERTED_EVENT,
  dispatchAgentConversationUpserted,
  type AgentConversationDeletedDetail,
  type AgentConversationUpsertedDetail,
} from "@/lib/agent-conversation-events";
import {
  patchAgentConversationGroups,
  patchAgentConversationSummaryInGroups,
  patchAgentConversationTitleInGroups,
  removeConversationFromAgentGroups,
} from "@/lib/agent-rail-patch";
import { groupAgentRailGroups } from "@/lib/agent-rail-groups";
import {
  buildAgentSwitcherList,
  bumpAgentConversationMru,
  isValidAgentConversationMruId,
  type AgentSwitcherCandidate,
} from "@/lib/agent-conversation-mru";
import { markConversationSwitchStart } from "@/lib/dev-perf";
import { useWorkspace } from "@/contexts/WorkspaceContext";
import { useWorkspaceDirectory } from "@/contexts/WorkspaceDirectoryContext";
import { useGlobalSettings } from "@/components/preferences/GlobalSettingsProvider";
import {
  AGENT_STANDALONE_COMPOSER_DRAFT_ID,
  agentWorkspaceComposerDraftId,
  useOpenInEditor,
} from "@/components/editor/OpenInEditorContext";
import type { WorkspaceSortMode } from "@/lib/global-settings";
import type { ServerConnection } from "@/lib/server-connections";
import {
  RAIL_INITIAL_LOAD_FAILSAFE_MS,
  RAIL_INITIAL_LOAD_RETRY_DELAY_MS,
  resolveRailFetchServers,
  runRailFetchWithTimeout,
} from "@/lib/rail-fetch";
import {
  filterGroupsByMachine,
  filterGroupsByWorkspaceScope,
  getRepositoryGroupingKey,
} from "@/lib/multi-server-workspaces";
import {
  clearSettledInGroups,
  collectAttentionConversations,
  collectRunningConversations,
  sinkSettledInGroups,
  stripAttentionFromPinned,
  stripElevatedFromGroups,
} from "@/lib/agent-rail-elevate";
import {
  AGENT_NEW_CHAT_SESSION_ID,
  createEmptyAgentSidePaneSession,
  getAgentSidePaneSessionScopeId,
  type ChatScrollAnchor,
  type AgentSidePaneSessionState,
  type EditorSessionState,
} from "@/lib/workspace-session";
import { useWorkbenchNotifications } from "@/components/notifications/WorkbenchNotificationProvider";
import { WORKBENCH_NOTIFICATION_KIND } from "@/components/notifications/workbench-notification-types";

const AGENT_RAIL_CYCLE_PINNED_SECTION_ID = "__agentPinned__";
const AGENT_RAIL_COLLAPSED_WORKSPACES_STORAGE_KEY =
  "opencursor.agent-rail-collapsed-workspaces";

function readAgentRailCollapsedWorkspaceIdsForCycle(): Set<string> {
  if (typeof window === "undefined") {
    return new Set();
  }
  try {
    const raw = window.localStorage.getItem(AGENT_RAIL_COLLAPSED_WORKSPACES_STORAGE_KEY);
    if (!raw) {
      return new Set();
    }
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) {
      return new Set();
    }
    return new Set(parsed.filter((id): id is string => typeof id === "string"));
  } catch {
    return new Set();
  }
}

function buildAgentRailCycleOrder(input: {
  activeWorkspaceId: string | null;
  groups: AgentConversationGroup[];
  pinnedRailConversations: AgentRailConversationSummary[];
  attentionRailConversations: AgentRailConversationSummary[];
  runningRailConversations: AgentRailConversationSummary[];
  collapsedWorkspaceIds: Set<string>;
}): AgentRailConversationSummary[] {
  const {
    activeWorkspaceId,
    groups,
    pinnedRailConversations,
    attentionRailConversations,
    runningRailConversations,
    collapsedWorkspaceIds,
  } = input;
  const visibleGroups = groups.filter(
    (group) => group.workspace.id === activeWorkspaceId || group.conversations.length > 0
  );
  const out: AgentRailConversationSummary[] = [];
  if (!collapsedWorkspaceIds.has("__agentAttention__")) {
    out.push(...attentionRailConversations);
  }
  if (!collapsedWorkspaceIds.has("__agentRunning__")) {
    out.push(...runningRailConversations);
  }
  if (!collapsedWorkspaceIds.has(AGENT_RAIL_CYCLE_PINNED_SECTION_ID)) {
    out.push(...pinnedRailConversations);
  }
  for (const group of visibleGroups) {
    if (collapsedWorkspaceIds.has(group.workspace.id)) {
      continue;
    }
    out.push(...group.conversations);
  }
  return out;
}

function nextAgentRailCycleIndex(
  currentId: string | null | undefined,
  flat: AgentRailConversationSummary[],
  delta: 1 | -1
): number | null {
  if (flat.length === 0) {
    return null;
  }
  let idx = flat.findIndex((c) => c.id === currentId);
  if (idx < 0) {
    idx = delta > 0 ? -1 : flat.length;
  }
  let next = idx + delta;
  while (next < 0) {
    next += flat.length;
  }
  while (next >= flat.length) {
    next -= flat.length;
  }
  return next;
}
export type AgentCenterStableConversationView = {
  conversationId: string;
  messages: ChatMessage[];
  conversationBusy: boolean;
  hasOlderHistory: boolean;
  loadingOlderHistory: boolean;
  /** Omitted = default to bottom; set = restore saved offset. */
  initialScrollTop?: number;
  /** Message-anchored restore when available (cross-device / paginated history). */
  initialScrollAnchor?: ChatScrollAnchor;
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
  /** Open the given workspace, then the draft new-chat session (for rail “+” on a non-active workspace). */
  startNewChatInWorkspace: (workspaceId: string) => Promise<void>;
  /** Draft a chat with no project workspace (temp sandbox created on first send). */
  startStandaloneChat: () => void;
  /** True while the draft composer targets a no-workspace standalone chat. */
  standaloneDraftActive: boolean;
  setStandaloneDraftActive: (active: boolean) => void;
  /** Move selection along the visible rail (pinned, then workspaces); crosses workspaces. */
  cycleAgentConversation: (delta: 1 | -1) => void;
  openConversationSummary: (summary: AgentRailConversationSummary) => Promise<void>;
  /** MRU-ordered rows for the Ctrl+Tab agent switcher palette. */
  agentSwitcherItems: AgentSwitcherCandidate[];
  findConversationSummaryById: (conversationId: string) => AgentRailConversationSummary | null;
  bumpAgentConversationMruForServer: (conversationId: string) => void;
  groups: AgentConversationGroup[];
  backends: AgentBackendInfo[];
  activeWorkspaceGroup: AgentConversationGroup | null;
  selectedConversationSummary: AgentRailConversationSummary | null;
  railLoading: boolean;
  railRefreshing: boolean;
  railLoadError: string | null;
  refreshConversationGroups: () => Promise<void>;
  /** Instant rail label while PATCH round-trips; callers should refresh on failure. */
  applyOptimisticRailTitle: (conversationId: string, title: string) => void;
  archiveConversation: (conversation: AgentRailConversationSummary) => Promise<void>;
  unarchiveConversation: (conversation: AgentRailConversationSummary) => Promise<void>;
  /** Mark a conversation settled (sinks to the bottom until a new prompt unsettles it). */
  settleConversation: (conversation: AgentRailConversationSummary) => Promise<void>;
  unsettleConversation: (conversation: AgentRailConversationSummary) => Promise<void>;
  /** Opt-in Settled mode; settle controls render only while enabled. */
  settledModeEnabled: boolean;
  pinnedRailConversations: AgentRailConversationSummary[];
  attentionRailConversations: AgentRailConversationSummary[];
  /** Actively working agents, elevated into their own cross-workspace section. */
  runningRailConversations: AgentRailConversationSummary[];
  pinConversation: (conversationId: string) => void;
  unpinConversation: (conversationId: string) => void;
  railFilterToggles: AgentRailFilterToggleState;
  railFilterActive: boolean;
  setRailFilterToggle: (key: AgentRailFilterToggleKey, value: boolean) => void;
  clearRailFilters: () => void;
  /** Conversations whose finished turn the user has not opened yet. */
  unreadCompletionByConversationId: Record<string, true> | undefined;
  /** Failed runs the user has already viewed. */
  acknowledgedFailureByConversationId: Record<string, true> | undefined;
  /** Real workspace names keyed by workspace id (survives rail regrouping). */
  railWorkspaceNameById: Map<string, string>;
  isMobile: boolean;
};

const AgentShellStateContext =
  createContext<AgentShellStateContextValue | null>(null);

function sortConversationGroups(
  groups: AgentConversationGroup[],
  recentWorkspaceIds: string[],
  workspaceSortMode: WorkspaceSortMode,
  customWorkspaceOrderIds: string[]
): AgentConversationGroup[] {
  const groupId = (group: AgentConversationGroup) => group.workspaceKey ?? group.workspace.id;
  const recentOrder = new Map(
    recentWorkspaceIds.map((workspaceId, index) => [workspaceId, index])
  );
  const customOrder = new Map(
    customWorkspaceOrderIds.map((workspaceId, index) => [workspaceId, index])
  );
  const compareByName = (a: AgentConversationGroup, b: AgentConversationGroup) =>
    a.workspace.name.localeCompare(b.workspace.name, undefined, { sensitivity: "base" });

  return [...groups].sort((a, b) => {
    if (workspaceSortMode === "machine") {
      return (
        (a.serverLabel ?? "").localeCompare(b.serverLabel ?? "", undefined, {
          sensitivity: "base",
        }) ||
        compareByName(a, b) ||
        groupId(a).localeCompare(groupId(b))
      );
    }
    if (workspaceSortMode === "alphabetical") {
      return compareByName(a, b) || groupId(a).localeCompare(groupId(b));
    }

    if (workspaceSortMode === "custom") {
      const customA = customOrder.get(groupId(a));
      const customB = customOrder.get(groupId(b));
      if (customA != null && customB != null && customA !== customB) {
        return customA - customB;
      }
      if (customA != null) {
        return -1;
      }
      if (customB != null) {
        return 1;
      }
      return compareByName(a, b);
    }

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
    return compareByName(a, b);
  });
}

function findConversationOwnerWorkspaceId(
  groups: AgentConversationGroup[],
  conversationId: string
): string | null {
  for (const group of groups) {
    const match = group.conversations.find((c) => c.id === conversationId);
    if (match) {
      // Never trust group.workspace.id: under bucket groupings (priority /
      // status / updated / repository) it is a pseudo-workspace key like
      // "priority:local:recent", and opening it as a workspace fails loudly.
      return match.workspaceId ?? group.workspace.id;
    }
  }
  return null;
}

function removePlaceholderRailConversations(
  groups: AgentConversationGroup[]
): AgentConversationGroup[] {
  return groups.map((group) => ({
    ...group,
    conversations: group.conversations.filter(isRenderableAgentRailConversation),
  }));
}

function annotateRailGroupsForServer(
  groups: AgentConversationGroup[],
  server: Pick<ServerConnection, "id" | "label" | "baseUrl">
): AgentConversationGroup[] {
  return groups.map((group) => {
    const workspaceKey = `${server.id}:${group.workspace.id}`;
    const repositoryKey = group.repository?.isGitRepo
      ? getRepositoryGroupingKey({
          repository: group.repository,
          serverId: server.id,
          fallbackRoot: group.workspace.root,
        })
      : undefined;
    return {
      ...group,
      serverId: server.id,
      serverLabel: server.label,
      workspaceKey,
      repositoryKey,
      conversations: group.conversations.map((conversation) => ({
        ...conversation,
        serverId: server.id,
        serverLabel: server.label,
        workspaceKey,
        conversationKey: `${server.id}:${conversation.id}`,
        repositoryKey,
        repository: conversation.repository ?? group.repository,
      })),
    };
  });
}

/**
 * Ensure every workspace returned by the live directory has at least an empty
 * group in the rail. Without this, workspaces whose owning server has no
 * conversations (or returned an error) would silently disappear from the
 * cross-server rail and the user would think one of their servers vanished.
 */
function mergeDirectoryPlaceholders(
  liveGroups: AgentConversationGroup[],
  directory: ReadonlyArray<{
    id: string;
    name: string;
    root: string;
    createdAt: number;
    updatedAt: number;
    lastOpenedAt: number;
    serverId: string;
    serverLabel: string;
    workspaceKey: string;
    repository?: AgentConversationGroup["repository"];
  }>
): AgentConversationGroup[] {
  const seenKeys = new Set(
    liveGroups
      .map((group) => group.workspaceKey ?? group.workspace.id)
      .filter((key): key is string => Boolean(key))
  );
  const result = [...liveGroups];
  for (const workspace of directory) {
    if (seenKeys.has(workspace.workspaceKey)) {
      continue;
    }
    seenKeys.add(workspace.workspaceKey);
    result.push({
      workspace: {
        id: workspace.id,
        name: workspace.name,
        root: workspace.root,
        createdAt: workspace.createdAt,
        updatedAt: workspace.updatedAt,
        lastOpenedAt: workspace.lastOpenedAt,
      },
      conversations: [],
      serverId: workspace.serverId,
      serverLabel: workspace.serverLabel,
      workspaceKey: workspace.workspaceKey,
      repositoryKey: workspace.repository?.isGitRepo
        ? getRepositoryGroupingKey({
            repository: workspace.repository,
            serverId: workspace.serverId,
            fallbackRoot: workspace.root,
          })
        : undefined,
      repository: workspace.repository,
    });
  }
  return result;
}

function mergeAuthRequiredServerPlaceholders(
  liveGroups: AgentConversationGroup[],
  servers: ReadonlyArray<Pick<ServerConnection, "id" | "label" | "baseUrl">>,
  serverStatusById: Record<string, ServerRuntimeStatus>
): AgentConversationGroup[] {
  const seenServerIds = new Set(liveGroups.map((group) => group.serverId).filter(Boolean));
  const result = [...liveGroups];
  for (const server of servers) {
    if (serverStatusById[server.id]?.health !== "auth_required" || seenServerIds.has(server.id)) {
      continue;
    }
    const workspaceId = `__server_auth_required:${server.id}`;
    result.push({
      workspace: {
        id: workspaceId,
        name: server.label,
        root: server.baseUrl,
        createdAt: 0,
        updatedAt: 0,
        lastOpenedAt: 0,
      },
      conversations: [],
      serverId: server.id,
      serverLabel: "Auth required",
      workspaceKey: `${server.id}:${workspaceId}`,
      serverAuthRequired: true,
    });
  }
  return result;
}

function mergeAgentBackends(
  lists: AgentBackendInfo[][]
): AgentBackendInfo[] {
  const byId = new Map<string, AgentBackendInfo>();
  for (const list of lists) {
    for (const backend of list) {
      if (!byId.has(backend.id)) {
        byId.set(backend.id, backend);
      }
    }
  }
  return [...byId.values()];
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
  const {
    activeWorkspaceId,
    openWorkspaceById,
    recentWorkspaceIds,
    sessionReady,
    workspaceSession,
    updateWorkspaceSession,
  } = useWorkspace();
  const { settings, updateSettings } = useGlobalSettings();
  const {
    activeServer,
    onlineServers,
    servers,
    serverStatusById,
    setActiveServer,
    ready: connectionsReady,
  } = useServerConnections();
  const { pushNotification } = useWorkbenchNotifications();
  const { workspaces: directoryWorkspaces } = useWorkspaceDirectory();
  const { resetComposerDraft } = useOpenInEditor();
  const { isMobile } = useViewport();
  const urlConversationId =
    typeof window !== "undefined"
      ? safeReadLocationSearchParam("conversationId")
      : null;
  const replaceConversationIdInLocation = useCallback(
    (conversationId: string | null) => {
      if (typeof window === "undefined") {
        return;
      }
      safeReplaceLocationSearchParams((params) => {
        if (conversationId) {
          params.set("conversationId", conversationId);
        } else {
          params.delete("conversationId");
        }
      });
    },
    []
  );
  const [groups, setGroups] = useState<AgentConversationGroup[]>([]);
  const [backends, setBackends] = useState<AgentBackendInfo[]>([]);
  const [railLoading, setRailLoading] = useState(true);
  const [railRefreshing, setRailRefreshing] = useState(false);
  const [railLoadError, setRailLoadError] = useState<string | null>(null);
  const [pendingConversationSelection, setPendingConversationSelection] = useState<{
    workspaceId: string;
    conversationId: string;
  } | null>(null);
  const [standaloneDraftActive, setStandaloneDraftActive] = useState(false);
  const [stableConversationView, setStableConversationView] =
    useState<AgentCenterStableConversationView | null>(null);
  const [persistedLeftRailCollapsed, setSharedLeftRailCollapsedState] = useState<
    boolean | null
  >(null);
  const sharedLeftRailCollapsed = resolveLeftRailCollapsed({
    isMobile,
    persistedLeftRailCollapsed,
  });
  const [draftRightPaneOpenScope, setDraftRightPaneOpenScope] = useState<string | null>(null);
  const [sharedAgentShellDesktopLayout, setSharedAgentShellDesktopLayoutState] =
    useState<Record<string, number> | null>(null);
  const previousEditorTabCountRef = useRef(0);
  const editorTabCountHydratedRef = useRef(false);
  const editorTabScopeRef = useRef<string | null>(null);
  const rightPaneScopeRef = useRef<string | null>(null);
  const sharedLeftRailCollapsedRef = useRef(sharedLeftRailCollapsed);
  const sharedAgentShellDesktopLayoutRef = useRef(sharedAgentShellDesktopLayout);
  const railInitialLoadCompletedRef = useRef(false);
  /** True once any conversation-groups payload has been applied. Background
   * refresh failures must never replace an already-rendered rail with an
   * error screen (mobile radios routinely fail right after wake). */
  const railHasDataRef = useRef(false);
  const serverStatusByIdRef = useRef(serverStatusById);
  const railRefreshInFlightRef = useRef<Promise<void> | null>(null);
  const railFetchGenerationRef = useRef(0);
  const archiveMutationSequenceRef = useRef(new Map<string, number>());
  const settleMutationSequenceRef = useRef(new Map<string, number>());
  serverStatusByIdRef.current = serverStatusById;

  useEffect(() => {
    sharedLeftRailCollapsedRef.current = sharedLeftRailCollapsed;
  }, [sharedLeftRailCollapsed]);

  useEffect(() => {
    sharedAgentShellDesktopLayoutRef.current = sharedAgentShellDesktopLayout;
  }, [sharedAgentShellDesktopLayout]);

  const applyRailGroupsResult = useCallback(
    (
      servers: ServerConnection[],
      successful: Array<{
        server: ServerConnection;
        backends: AgentBackendInfo[];
        groups: AgentConversationGroup[];
      }>
    ) => {
      if (successful.length === 0) {
        return false;
      }
      setBackends(mergeAgentBackends(successful.map((result) => result.backends)));
      setGroups(
        mergeAuthRequiredServerPlaceholders(
          mergeDirectoryPlaceholders(
            successful.flatMap((result) => result.groups),
            directoryWorkspaces
          ),
          servers,
          serverStatusByIdRef.current
        )
      );
      railHasDataRef.current = true;
      return true;
    },
    [directoryWorkspaces]
  );

  const refreshConversationGroups = useCallback(async () => {
    const fetchGeneration = ++railFetchGenerationRef.current;
    const servers = resolveRailFetchServers({
      activeServer,
      onlineServers,
      serverStatusById: serverStatusByIdRef.current,
    });
    const results = await Promise.all(
      servers.map(async (server) => {
        try {
          const result = await runRailFetchWithTimeout(
            `Rail fetch for ${server.label}`,
            (signal) =>
              listCrossWorkspaceAgentConversationsForServer({
                serverId: server.id,
                baseUrl: server.baseUrl,
              }, { cache: "no-store", signal })
          );
          return {
            server,
            backends: result.backends,
            groups: annotateRailGroupsForServer(
              removePlaceholderRailConversations(result.groups),
              server
            ),
          };
        } catch (error) {
          if (typeof console !== "undefined") {
            console.warn(
              `[rail] Failed to fetch conversations for ${server.label} (${server.baseUrl}):`,
              error
            );
          }
          return null;
        }
      })
    );
    const successful = results.filter((result): result is NonNullable<typeof result> =>
      Boolean(result)
    );
    if (fetchGeneration !== railFetchGenerationRef.current) {
      return;
    }
    if (applyRailGroupsResult(servers, successful)) {
      return;
    }

    try {
      const result = await runRailFetchWithTimeout(
        "Rail fetch for active server",
        (signal) => listCrossWorkspaceAgentConversations({ cache: "no-store", signal })
      );
      if (fetchGeneration !== railFetchGenerationRef.current) {
        return;
      }
      setBackends(result.backends);
      setGroups(
        mergeAuthRequiredServerPlaceholders(
          mergeDirectoryPlaceholders(
            removePlaceholderRailConversations(result.groups),
            directoryWorkspaces
          ),
          servers,
          serverStatusByIdRef.current
        )
      );
      railHasDataRef.current = true;
    } catch (error) {
      if (typeof console !== "undefined") {
        console.warn("[rail] Failed to fetch conversations from active server:", error);
      }
      throw error;
    }
  }, [activeServer, applyRailGroupsResult, directoryWorkspaces, onlineServers]);

  // Failsafe for the initial "Loading chats..." spinner. Deliberately
  // decoupled from the loader effect below: that effect re-runs whenever its
  // dependencies churn during startup (health probes flipping onlineServers,
  // the workspace directory arriving, active-server changes), and an
  // effect-scoped timer would be cleared on every re-run — leaving the
  // spinner up forever if the in-flight run never settles. This timer only
  // restarts when `connectionsReady` flips (at most once), so it also covers
  // the case where server-connections bootstrap itself never completes.
  useEffect(() => {
    if (railInitialLoadCompletedRef.current) {
      return;
    }
    const failSafeTimer = window.setTimeout(() => {
      if (railInitialLoadCompletedRef.current) {
        return;
      }
      railInitialLoadCompletedRef.current = true;
      setRailLoading(false);
      setRailRefreshing(false);
      if (!railHasDataRef.current) {
        setRailLoadError(
          "Timed out loading conversations. Check your server connection and retry."
        );
      }
    }, RAIL_INITIAL_LOAD_FAILSAFE_MS);
    return () => {
      window.clearTimeout(failSafeTimer);
    };
  }, [connectionsReady]);

  useEffect(() => {
    if (!connectionsReady) {
      return;
    }
    let active = true;
    const initialLoad = !railInitialLoadCompletedRef.current;
    if (initialLoad) {
      setRailLoading(true);
      setRailLoadError(null);
    } else {
      setRailRefreshing(true);
    }

    const loadWithInitialRetry = async () => {
      try {
        await refreshConversationGroups();
      } catch (error) {
        // One automatic retry on the very first load: transient network blips
        // (mobile radio wake, proxy cold start) should not require the user
        // to find the Retry button.
        if (!initialLoad || !active) {
          throw error;
        }
        await new Promise((resolve) =>
          window.setTimeout(resolve, RAIL_INITIAL_LOAD_RETRY_DELAY_MS)
        );
        if (!active) {
          throw error;
        }
        await refreshConversationGroups();
      }
    };

    void loadWithInitialRetry()
      .then(() => {
        if (active) {
          setRailLoadError(null);
        }
      })
      .catch(() => {
        // Keep showing already-loaded conversations over an error screen.
        if (active && !railHasDataRef.current) {
          setRailLoadError("Could not load conversations. Check your server connection and retry.");
        }
      })
      .finally(() => {
        if (active) {
          railInitialLoadCompletedRef.current = true;
          setRailLoading(false);
          setRailRefreshing(false);
        }
      });
    return () => {
      active = false;
    };
  }, [connectionsReady, refreshConversationGroups]);

  const refreshConversationGroupsWithState = useCallback(async () => {
    if (railRefreshInFlightRef.current) {
      return railRefreshInFlightRef.current;
    }
    setRailRefreshing(true);
    setRailLoadError(null);
    const refreshPromise = (async () => {
      await refreshConversationGroups();
      setRailLoadError(null);
    })();
    railRefreshInFlightRef.current = refreshPromise;
    try {
      await refreshPromise;
    } catch {
      // A failed background refresh must not blank out an already-loaded
      // rail; stale conversations beat an error screen, and the periodic
      // refresh will heal the data as soon as the connection recovers.
      if (!railHasDataRef.current) {
        setRailLoadError("Could not load conversations. Check your server connection and retry.");
      }
    } finally {
      railRefreshInFlightRef.current = null;
      setRailRefreshing(false);
    }
  }, [refreshConversationGroups]);

  const applyOptimisticRailTitle = useCallback(
    (conversationId: string, title: string) => {
      railFetchGenerationRef.current += 1;
      setGroups((prev) => patchAgentConversationTitleInGroups(prev, conversationId, title));
    },
    []
  );

  useEffect(() => {
    // `navigator.onLine === false` means a fetch is guaranteed to fail;
    // skipping avoids churning generations/state on flappy mobile radios.
    // (`true` is not trustworthy, so it is never used to assume success.)
    const browserIsOffline = () =>
      typeof navigator !== "undefined" && navigator.onLine === false;
    const handleFocus = () => {
      if (document.visibilityState === "hidden" || browserIsOffline()) return;
      void refreshConversationGroupsWithState();
    };
    const handleVisibility = () => {
      if (document.visibilityState === "visible" && !browserIsOffline()) {
        void refreshConversationGroupsWithState();
      }
    };
    const handleOnline = () => {
      if (document.visibilityState === "hidden") return;
      void refreshConversationGroupsWithState();
    };
    window.addEventListener("focus", handleFocus);
    document.addEventListener("visibilitychange", handleVisibility);
    window.addEventListener("online", handleOnline);
    return () => {
      window.removeEventListener("focus", handleFocus);
      document.removeEventListener("visibilitychange", handleVisibility);
      window.removeEventListener("online", handleOnline);
    };
  }, [refreshConversationGroupsWithState]);

  useEffect(() => {
    const interval = window.setInterval(() => {
      if (
        document.visibilityState === "hidden" ||
        (typeof navigator !== "undefined" && navigator.onLine === false)
      ) {
        return;
      }
      void refreshConversationGroupsWithState();
    }, 20_000);
    return () => window.clearInterval(interval);
  }, [refreshConversationGroupsWithState]);

  useEffect(() => {
    const onUpsert = (ev: Event) => {
      const detail = (ev as CustomEvent<AgentConversationUpsertedDetail>).detail;
      if (!detail?.id || !detail.workspaceId) {
        return;
      }
      if (railInitialLoadCompletedRef.current) {
        railFetchGenerationRef.current += 1;
      }
      setGroups((prev) =>
        patchAgentConversationGroups(prev, detail, detail.serverId ?? activeServer.id)
      );
    };
    const onDeleted = (ev: Event) => {
      const detail = (ev as CustomEvent<AgentConversationDeletedDetail>).detail;
      if (!detail?.conversationId || !detail.workspaceId) {
        return;
      }
      if (railInitialLoadCompletedRef.current) {
        railFetchGenerationRef.current += 1;
      }
      setGroups((prev) =>
        removeConversationFromAgentGroups(
          prev,
          detail.conversationId,
          detail.workspaceId,
            detail.serverId ?? activeServer.id
        )
      );
    };
    window.addEventListener(AGENT_CONVERSATION_UPSERTED_EVENT, onUpsert);
    window.addEventListener(AGENT_CONVERSATION_DELETED_EVENT, onDeleted);
    return () => {
      window.removeEventListener(AGENT_CONVERSATION_UPSERTED_EVENT, onUpsert);
      window.removeEventListener(AGENT_CONVERSATION_DELETED_EVENT, onDeleted);
    };
  }, [activeServer.id]);

  useEffect(() => {
    // During the initial load these eager refreshes would only race the main
    // loader (each call bumps the fetch generation, forcing earlier fetches
    // to discard their results). The initial cross-workspace load already
    // covers every workspace/server, so they add nothing until it completes.
    if (!activeWorkspaceId || !railInitialLoadCompletedRef.current) {
      return;
    }
    void refreshConversationGroups().catch(() => undefined);
  }, [activeWorkspaceId, refreshConversationGroups]);

  useEffect(() => {
    if (!railInitialLoadCompletedRef.current) {
      return;
    }
    void refreshConversationGroupsWithState();
  }, [activeServer.id, refreshConversationGroupsWithState]);

  const settledModeEnabled = settings.general.agentRail.settledMode === true;

  // Settled mode is opt-in: with the mode off, persisted settled flags are
  // stripped up front so no downstream derivation (sinking, elevation,
  // status kinds, row toggles) ever sees them.
  const settledAwareGroups = useMemo(
    () => (settledModeEnabled ? groups : clearSettledInGroups(groups)),
    [groups, settledModeEnabled]
  );

  const visibleMachineGroups = useMemo(
    () => filterGroupsByMachine(settledAwareGroups, settings.general.agentRail.hiddenServerIds),
    [settledAwareGroups, settings.general.agentRail.hiddenServerIds]
  );

  const scopedMachineGroups = useMemo(
    () => filterGroupsByWorkspaceScope(visibleMachineGroups, settings.general.agentRail.scope),
    [settings.general.agentRail.scope, visibleMachineGroups]
  );

  const groupedByRailMode = useMemo(
    () =>
      groupAgentRailGroups(
        scopedMachineGroups,
        settings.general.agentRail.groupBy,
        Date.now(),
        {
          unreadCompletionByConversationId:
            workspaceSession.chat.unreadChatCompletionByConversationId,
          acknowledgedFailureByConversationId:
            workspaceSession.chat.acknowledgedFailureByConversationId,
        }
      ),
    [
      settings.general.agentRail.groupBy,
      scopedMachineGroups,
      workspaceSession.chat.acknowledgedFailureByConversationId,
      workspaceSession.chat.unreadChatCompletionByConversationId,
    ]
  );

  const orderedGroups = useMemo(
    () =>
      // Priority buckets come pre-ordered (urgent first); workspace sorting
      // would scramble them alphabetically.
      settings.general.agentRail.groupBy === "priority"
        ? groupedByRailMode
        : sortConversationGroups(
            groupedByRailMode,
            recentWorkspaceIds,
            settings.general.workspaceSortMode,
            settings.general.workspaceCustomOrderIds
          ),
    [
      groupedByRailMode,
      recentWorkspaceIds,
      settings.general.agentRail.groupBy,
      settings.general.workspaceCustomOrderIds,
      settings.general.workspaceSortMode,
    ]
  );

  // Workspace-shaped view of the same data, independent of the rail's visual
  // grouping. Identity consumers (active workspace, composer drafts, switcher
  // labels) must never see bucket pseudo-workspaces like "Needs attention".
  const workspaceShapedGroups = useMemo(
    () =>
      settings.general.agentRail.groupBy === "workspace"
        ? groupedByRailMode
        : groupAgentRailGroups(scopedMachineGroups, "workspace"),
    [groupedByRailMode, settings.general.agentRail.groupBy, scopedMachineGroups]
  );

  const activeWorkspaceGroup = useMemo(
    () =>
      workspaceShapedGroups.find(
        (group) =>
          group.workspace.id === activeWorkspaceId &&
          (!group.serverId || group.serverId === activeServer.id)
      ) ??
      workspaceShapedGroups.find((group) =>
        group.conversations.some(
          (conversation) =>
            conversation.workspaceId === activeWorkspaceId &&
            (!conversation.serverId || conversation.serverId === activeServer.id)
        )
      ) ??
      null,
    [activeServer.id, activeWorkspaceId, workspaceShapedGroups]
  );

  const validActiveConversationIds = useMemo(
    () => new Set(activeWorkspaceGroup?.conversations.map((conversation) => conversation.id) ?? []),
    [activeWorkspaceGroup]
  );

  const requestedConversationId =
    urlConversationId ?? workspaceSession.agentView.selectedConversationId;
  const isDraftConversationSelected =
    requestedConversationId == null || requestedConversationId === AGENT_NEW_CHAT_SESSION_ID;
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

    return null;
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

  const sidePaneSessionsByConversationId =
    workspaceSession.agentView.sidePaneSessionsByConversationId;
  const sidePaneSessionMap = useMemo(
    () => sidePaneSessionsByConversationId ?? {},
    [sidePaneSessionsByConversationId]
  );
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
  const draftRightPaneScope = `${activeWorkspaceId ?? "workspace"}:${sidePaneScopeId}`;
  const rightPaneOpen = resolveAgentRightPaneOpen({
    isDraftConversationSelected,
    persistedRightPaneOpen: activeSidePaneSession.rightPaneOpen,
    draftRightPaneExplicitlyOpen: draftRightPaneOpenScope === draftRightPaneScope,
  });

  useEffect(() => {
    if (!isDraftConversationSelected && draftRightPaneOpenScope != null) {
      setDraftRightPaneOpenScope(null);
    }
  }, [draftRightPaneOpenScope, isDraftConversationSelected]);

  // Apply persisted global shell before paint. Never re-source rail/layout from per-workspace session
  // after that — session layout changes when switching workspaces and must not clobber user prefs.
  // Mobile ignores a stored "rail open" flag: the drawer covers the viewport, so a fresh
  // session (sign-in, new server, new WebView) should land on the new-chat page.
  useLayoutEffect(() => {
    if (typeof window === "undefined") {
      return;
    }
    const snapshot = readAgentShellSharedSnapshot();
    if (snapshot?.agentShellDesktopLayout != null) {
      setSharedAgentShellDesktopLayoutState(snapshot.agentShellDesktopLayout);
    }
    if (!shouldRestorePersistedLeftRailCollapsed(isMobile)) {
      setSharedLeftRailCollapsedState(null);
      return;
    }
    if (typeof snapshot?.leftRailCollapsed === "boolean") {
      setSharedLeftRailCollapsedState(snapshot.leftRailCollapsed);
    }
  }, [isMobile]);

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
    if (shouldRestorePersistedLeftRailCollapsed(isMobile)) {
      setSharedLeftRailCollapsedState(nextLeftRailCollapsed);
    }
    setSharedAgentShellDesktopLayoutState(fallbackLayout);
    writeAgentShellSharedSnapshot({
      leftRailCollapsed: nextLeftRailCollapsed,
      agentShellDesktopLayout: fallbackLayout,
    });
  }, [
    activeWorkspaceId,
    isMobile,
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
			if (isDraftConversationSelected) {
				previousEditorTabCountRef.current = nextEditorTabCount;
				return;
			}
			updateWorkspaceSession((current) => {
				const sessions = current.agentView.sidePaneSessionsByConversationId ?? {};
				const existing =
					sessions[sidePaneScopeId] ??
					(Object.keys(sessions).length > 0
						? createEmptyAgentSidePaneSession()
						: createLegacySidePaneSession(current));
				if (existing.rightPaneOpen) {
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
								rightPaneOpen: true,
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
		isDraftConversationSelected,
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
      if (isDraftConversationSelected) {
        setDraftRightPaneOpenScope(open ? draftRightPaneScope : null);
        return;
      }
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
    [
      draftRightPaneScope,
      isDraftConversationSelected,
      sidePaneScopeId,
      updateWorkspaceSession,
    ]
  );

  const toggleRightPaneOpen = useCallback(() => {
    setRightPaneOpen(!rightPaneOpen);
  }, [rightPaneOpen, setRightPaneOpen]);

  useLayoutEffect(() => {
    if (shouldRestorePersistedRightPaneOpen()) {
      return;
    }
    const scopeKey = `${activeWorkspaceId ?? "workspace"}:${sidePaneScopeId}`;
    if (rightPaneScopeRef.current === scopeKey) {
      return;
    }
    rightPaneScopeRef.current = scopeKey;
    setRightPaneOpen(false);
  }, [activeWorkspaceId, setRightPaneOpen, sidePaneScopeId]);

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
        const currentSharedLayout =
          normalizeAgentShellDesktopLayout(current.agentView.agentShellDesktopLayout) ?? {};
        const existing =
          sessions[sidePaneScopeId] ??
          (Object.keys(sessions).length > 0
            ? createEmptyAgentSidePaneSession()
            : createLegacySidePaneSession(current));
        return {
          ...current,
          agentView: {
            ...current.agentView,
            agentShellDesktopLayout: {
              ...currentSharedLayout,
              [AGENT_SHELL_PANEL_IDS.rail]: nextLayout[AGENT_SHELL_PANEL_IDS.rail],
            },
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

  const bumpAgentConversationMruForServer = useCallback(
    (conversationId: string) => {
      if (!isValidAgentConversationMruId(conversationId)) {
        return;
      }
      const serverId = activeServer.id;
      updateSettings((current) => {
        const prevStack = current.general.agentConversationMruByServer[serverId] ?? [];
        const nextStack = bumpAgentConversationMru(conversationId, prevStack);
        if (
          nextStack.length === prevStack.length &&
          nextStack.every((id, index) => id === prevStack[index])
        ) {
          return current;
        }
        return {
          ...current,
          general: {
            ...current.general,
            agentConversationMruByServer: {
              ...current.general.agentConversationMruByServer,
              [serverId]: nextStack,
            },
          },
        };
      });
    },
    [activeServer.id, updateSettings]
  );

  const setSelectedConversationId = useCallback(
    (conversationId: string | null) => {
      markConversationSwitchStart(conversationId, "setSelectedConversationId");
      if (conversationId && isValidAgentConversationMruId(conversationId)) {
        bumpAgentConversationMruForServer(conversationId);
      }
      updateWorkspaceSession((current) => ({
        ...current,
        agentView: {
          ...current.agentView,
          selectedConversationId: conversationId,
        },
      }));
      replaceConversationIdInLocation(conversationId);
    },
    [bumpAgentConversationMruForServer, replaceConversationIdInLocation, updateWorkspaceSession]
  );

  const startNewConversation = useCallback(() => {
    // New Chat must not inherit stuck / previously-sent composer text from the
    // stable landing draft ids (submit used to race and re-apply stale content).
    resetComposerDraft(AGENT_STANDALONE_COMPOSER_DRAFT_ID);
    resetComposerDraft(agentWorkspaceComposerDraftId(activeWorkspaceId));
    updateWorkspaceSession((current) => ({
      ...current,
      agentView: {
        ...current.agentView,
        selectedConversationId: AGENT_NEW_CHAT_SESSION_ID,
      },
    }));
    replaceConversationIdInLocation(AGENT_NEW_CHAT_SESSION_ID);
    if (isMobile) {
      setLeftRailCollapsed(true);
    }
  }, [
    activeWorkspaceId,
    isMobile,
    replaceConversationIdInLocation,
    resetComposerDraft,
    setLeftRailCollapsed,
    updateWorkspaceSession,
  ]);

  const startStandaloneChat = useCallback(() => {
    resetComposerDraft(AGENT_STANDALONE_COMPOSER_DRAFT_ID);
    setStandaloneDraftActive(true);
    startNewConversation();
  }, [resetComposerDraft, startNewConversation]);

  const startNewChatInWorkspace = useCallback(
    async (workspaceId: string) => {
      // Must run before any `await`. `loadWorkspaceState` rewrites `workspaceId` in the URL but
      // keeps the old `conversationId` until loading finishes. While the async fetch runs, the
      // effect below sees (active workspace B + URL conversation owned by A) and calls
      // `openWorkspaceById(A)` to "honor" the deep link — undoing the rail + click. Drafting the
      // URL up front keeps `isDraftConversationSelected` true so that effect bails.
      setStandaloneDraftActive(false);
      replaceConversationIdInLocation(AGENT_NEW_CHAT_SESSION_ID);
      if (workspaceId !== activeWorkspaceId) {
        await openWorkspaceById(workspaceId);
      }
      startNewConversation();
    },
    [
      activeWorkspaceId,
      openWorkspaceById,
      replaceConversationIdInLocation,
      startNewConversation,
    ]
  );

  const openConversationSummary = useCallback(
    async (summary: AgentRailConversationSummary) => {
      markConversationSwitchStart(summary.id, "rail");
      bumpAgentConversationMruForServer(summary.id);
      setStandaloneDraftActive(false);
      if (summary.serverId && summary.serverId !== activeServer.id) {
        setActiveServer(summary.serverId);
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
      activeServer.id,
      activeWorkspaceId,
      bumpAgentConversationMruForServer,
      openWorkspaceById,
      setActiveServer,
      setSelectedConversationId,
    ]
  );

  const setConversationArchived = useCallback(
    async (summary: AgentRailConversationSummary, archived: boolean) => {
      const mutationKey =
        summary.conversationKey ??
        `${summary.serverId ?? activeServer.id}:${summary.workspaceId}:${summary.id}`;
      const sequence = (archiveMutationSequenceRef.current.get(mutationKey) ?? 0) + 1;
      archiveMutationSequenceRef.current.set(mutationKey, sequence);
      const optimisticUpdatedAt = Math.max(summary.updatedAt + 1, Date.now());
      railFetchGenerationRef.current += 1;
      setGroups((current) =>
        patchAgentConversationSummaryInGroups(current, summary, {
          archivedAt: archived ? optimisticUpdatedAt : null,
          updatedAt: optimisticUpdatedAt,
        })
      );

      const targetServer =
        (summary.serverId
          ? servers.find((server) => server.id === summary.serverId)
          : activeServer) ?? activeServer;
      try {
        const { conversation } = await patchAgentConversationMetadata(
          summary.id,
          { archived },
          {
            server: {
              serverId: targetServer.id,
              baseUrl: targetServer.baseUrl,
              workspaceId: summary.workspaceId,
            },
          }
        );
        if (archiveMutationSequenceRef.current.get(mutationKey) === sequence) {
          dispatchAgentConversationUpserted(conversation, targetServer.id);
        }
      } catch (error) {
        if (archiveMutationSequenceRef.current.get(mutationKey) === sequence) {
          setGroups((current) =>
            patchAgentConversationSummaryInGroups(current, summary, {
              archivedAt: summary.archivedAt,
              updatedAt: summary.updatedAt,
            })
          );
          pushNotification({
            kind: WORKBENCH_NOTIFICATION_KIND.editorNotice,
            severity: "error",
            title: archived ? "Archive Failed" : "Restore Failed",
            message:
              error instanceof Error
                ? error.message
                : `Could not ${archived ? "archive" : "restore"} the conversation.`,
            autoDismissMs: 8_000,
            compact: true,
          });
          await refreshConversationGroupsWithState();
        }
      } finally {
        if (archiveMutationSequenceRef.current.get(mutationKey) === sequence) {
          archiveMutationSequenceRef.current.delete(mutationKey);
        }
      }
    },
    [
      activeServer,
      pushNotification,
      refreshConversationGroupsWithState,
      servers,
    ]
  );

  const archiveConversation = useCallback(
    (conversation: AgentRailConversationSummary) =>
      setConversationArchived(conversation, true),
    [setConversationArchived]
  );

  const unarchiveConversation = useCallback(
    (conversation: AgentRailConversationSummary) =>
      setConversationArchived(conversation, false),
    [setConversationArchived]
  );

  const setConversationSettled = useCallback(
    async (summary: AgentRailConversationSummary, settled: boolean) => {
      const mutationKey =
        summary.conversationKey ??
        `${summary.serverId ?? activeServer.id}:${summary.workspaceId}:${summary.id}`;
      const sequence = (settleMutationSequenceRef.current.get(mutationKey) ?? 0) + 1;
      settleMutationSequenceRef.current.set(mutationKey, sequence);
      railFetchGenerationRef.current += 1;
      // Rank-neutral on purpose: settling must not bump the row's recency,
      // it only re-partitions the row into/out of the settled tail.
      setGroups((current) =>
        patchAgentConversationSummaryInGroups(current, summary, {
          settledAt: settled ? Date.now() : null,
        })
      );

      const targetServer =
        (summary.serverId
          ? servers.find((server) => server.id === summary.serverId)
          : activeServer) ?? activeServer;
      try {
        const { conversation } = await patchAgentConversationMetadata(
          summary.id,
          { settled },
          {
            server: {
              serverId: targetServer.id,
              baseUrl: targetServer.baseUrl,
              workspaceId: summary.workspaceId,
            },
          }
        );
        if (settleMutationSequenceRef.current.get(mutationKey) === sequence) {
          dispatchAgentConversationUpserted(conversation, targetServer.id);
        }
      } catch (error) {
        if (settleMutationSequenceRef.current.get(mutationKey) === sequence) {
          setGroups((current) =>
            patchAgentConversationSummaryInGroups(current, summary, {
              settledAt: summary.settledAt ?? null,
            })
          );
          pushNotification({
            kind: WORKBENCH_NOTIFICATION_KIND.editorNotice,
            severity: "error",
            title: settled ? "Settle Failed" : "Unsettle Failed",
            message:
              error instanceof Error
                ? error.message
                : `Could not ${settled ? "settle" : "unsettle"} the conversation.`,
            autoDismissMs: 8_000,
            compact: true,
          });
          await refreshConversationGroupsWithState();
        }
      } finally {
        if (settleMutationSequenceRef.current.get(mutationKey) === sequence) {
          settleMutationSequenceRef.current.delete(mutationKey);
        }
      }
    },
    [
      activeServer,
      pushNotification,
      refreshConversationGroupsWithState,
      servers,
    ]
  );

  const settleConversation = useCallback(
    (conversation: AgentRailConversationSummary) =>
      setConversationSettled(conversation, true),
    [setConversationSettled]
  );

  const unsettleConversation = useCallback(
    (conversation: AgentRailConversationSummary) =>
      setConversationSettled(conversation, false),
    [setConversationSettled]
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
      pinnedConversationIds: pinnedConversationIdSet,
      unreadCompletionByConversationId:
        workspaceSession.chat.unreadChatCompletionByConversationId,
      acknowledgedFailureByConversationId:
        workspaceSession.chat.acknowledgedFailureByConversationId,
    }),
    [
      pinnedConversationIdSet,
      workspaceSession.chat.acknowledgedFailureByConversationId,
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

  const pinnedRailConversationsUnstripped = useMemo(() => {
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
        return matchesAgentRailMultiFilter(c, railFilterToggles, railFilterMatchContext);
      });
  }, [orderedGroups, pinnedAgentConversationIds, railFilterMatchContext, railFilterToggles]);

  const attentionRailConversations = useMemo(() => {
    const hidden = new Set(settings.general.agentRail.hiddenSections ?? []);
    if (settings.general.agentRail.groupBy === "priority" || hidden.has("attention")) {
      return [];
    }
    return collectAttentionConversations(
      filteredGroups,
      pinnedRailConversationsUnstripped,
      {
        unreadCompletionByConversationId:
          workspaceSession.chat.unreadChatCompletionByConversationId,
        acknowledgedFailureByConversationId:
          workspaceSession.chat.acknowledgedFailureByConversationId,
      }
    );
  }, [
    filteredGroups,
    pinnedRailConversationsUnstripped,
    settings.general.agentRail.groupBy,
    settings.general.agentRail.hiddenSections,
    workspaceSession.chat.acknowledgedFailureByConversationId,
    workspaceSession.chat.unreadChatCompletionByConversationId,
  ]);

  const attentionConversationIds = useMemo(
    () => new Set(attentionRailConversations.map((conversation) => conversation.id)),
    [attentionRailConversations]
  );

  // Actively working agents get their own elevated home right below Needs
  // attention: the user is most likely to come back to them next.
  const runningRailConversations = useMemo(() => {
    const hidden = new Set(settings.general.agentRail.hiddenSections ?? []);
    if (settings.general.agentRail.groupBy === "priority" || hidden.has("running")) {
      return [];
    }
    return collectRunningConversations(
      filteredGroups,
      pinnedRailConversationsUnstripped,
      {
        unreadCompletionByConversationId:
          workspaceSession.chat.unreadChatCompletionByConversationId,
        acknowledgedFailureByConversationId:
          workspaceSession.chat.acknowledgedFailureByConversationId,
      }
    );
  }, [
    filteredGroups,
    pinnedRailConversationsUnstripped,
    settings.general.agentRail.groupBy,
    settings.general.agentRail.hiddenSections,
    workspaceSession.chat.acknowledgedFailureByConversationId,
    workspaceSession.chat.unreadChatCompletionByConversationId,
  ]);

  const elevatedConversationIds = useMemo(() => {
    const ids = new Set(attentionConversationIds);
    for (const conversation of runningRailConversations) {
      ids.add(conversation.id);
    }
    return ids;
  }, [attentionConversationIds, runningRailConversations]);

  const pinnedRailConversations = useMemo(
    () => stripAttentionFromPinned(pinnedRailConversationsUnstripped, elevatedConversationIds),
    [elevatedConversationIds, pinnedRailConversationsUnstripped]
  );

  const groupsForRail = useMemo(
    () =>
      sinkSettledInGroups(
        stripElevatedFromGroups(
          filteredGroups,
          elevatedConversationIds,
          pinnedConversationIdSet
        )
      ),
    [elevatedConversationIds, filteredGroups, pinnedConversationIdSet]
  );

  // Derived from the raw (pre-regrouping) groups so the attention section can
  // label rows with real workspace names even when the rail is grouped by
  // status/updated buckets.
  const railWorkspaceNameById = useMemo(() => {
    const names = new Map<string, string>();
    for (const group of groups) {
      if (!names.has(group.workspace.id)) {
        names.set(group.workspace.id, group.workspace.name);
      }
    }
    return names;
  }, [groups]);

  // Viewing a conversation marks its completion as read. Without this, the
  // unread flag is only cleared by the IDE chat/editor tab handlers, so chats
  // opened from the agent rail would sit in the Review bucket forever. Also
  // covers flags set while the conversation is already open (the shell does
  // not always mirror selection into `chat.tabs`), and defers clearing while
  // the page is hidden so background completions stay unread until seen.
  const unreadCompletionMap = workspaceSession.chat.unreadChatCompletionByConversationId;
  useEffect(() => {
    if (!selectedConversationId || !unreadCompletionMap?.[selectedConversationId]) {
      return;
    }
    const clearIfSeen = () => {
      if (typeof document !== "undefined" && document.visibilityState === "hidden") {
        return;
      }
      updateWorkspaceSession((current) => {
        const unread = current.chat.unreadChatCompletionByConversationId ?? {};
        if (!unread[selectedConversationId]) {
          return current;
        }
        const next = { ...unread };
        delete next[selectedConversationId];
        return {
          ...current,
          chat: {
            ...current.chat,
            unreadChatCompletionByConversationId: next,
          },
        };
      });
    };
    clearIfSeen();
    document.addEventListener("visibilitychange", clearIfSeen);
    return () => document.removeEventListener("visibilitychange", clearIfSeen);
  }, [selectedConversationId, unreadCompletionMap, updateWorkspaceSession]);

  const acknowledgedFailureMap = workspaceSession.chat.acknowledgedFailureByConversationId;
  useEffect(() => {
    if (
      !selectedConversationId ||
      selectedConversationSummary?.id !== selectedConversationId ||
      selectedConversationSummary.status !== "failed" ||
      acknowledgedFailureMap?.[selectedConversationId]
    ) {
      return;
    }
    const ackIfSeen = () => {
      if (typeof document !== "undefined" && document.visibilityState === "hidden") {
        return;
      }
      updateWorkspaceSession((current) => {
        const acked = current.chat.acknowledgedFailureByConversationId ?? {};
        if (acked[selectedConversationId]) {
          return current;
        }
        return {
          ...current,
          chat: {
            ...current.chat,
            acknowledgedFailureByConversationId: { ...acked, [selectedConversationId]: true },
          },
        };
      });
    };
    ackIfSeen();
    document.addEventListener("visibilitychange", ackIfSeen);
    return () => document.removeEventListener("visibilitychange", ackIfSeen);
  }, [
    acknowledgedFailureMap,
    selectedConversationId,
    selectedConversationSummary,
    updateWorkspaceSession,
  ]);

  const agentSwitcherCandidates = useMemo(() => {
    const items: AgentSwitcherCandidate[] = [];
    const seen = new Set<string>();
    const pushSummary = (
      summary: AgentRailConversationSummary,
      workspaceId: string,
      workspaceName: string,
      serverId?: string
    ) => {
      if (seen.has(summary.id) || !isRenderableAgentRailConversation(summary)) {
        return;
      }
      seen.add(summary.id);
      items.push({
        id: summary.id,
        title: summary.title,
        updatedAt: summary.updatedAt,
        workspaceId,
        workspaceName,
        serverId,
        badge:
          summary.status === "running"
            ? "running"
            : agentRailConversationNeedsAttention(summary, {
                acknowledgedFailure: Boolean(
                  workspaceSession.chat.acknowledgedFailureByConversationId?.[summary.id]
                ),
              })
              ? "needs attention"
              : undefined,
      });
    };

    for (const group of workspaceShapedGroups) {
      if (group.serverId && group.serverId !== activeServer.id) {
        continue;
      }
      for (const conversation of group.conversations) {
        pushSummary(
          conversation,
          group.workspace.id,
          group.workspace.name,
          group.serverId
        );
      }
    }

    for (const pinnedId of pinnedAgentConversationIds) {
      for (const group of workspaceShapedGroups) {
        const conversation = group.conversations.find((c) => c.id === pinnedId);
        if (!conversation) {
          continue;
        }
        if (group.serverId && group.serverId !== activeServer.id) {
          continue;
        }
        pushSummary(
          conversation,
          group.workspace.id,
          group.workspace.name,
          group.serverId
        );
      }
    }

    return items;
  }, [
    activeServer.id,
    pinnedAgentConversationIds,
    workspaceSession.chat.acknowledgedFailureByConversationId,
    workspaceShapedGroups,
  ]);

  const agentSwitcherItems = useMemo(() => {
    const mruIds = settings.general.agentConversationMruByServer[activeServer.id] ?? [];
    return buildAgentSwitcherList({
      mruIds,
      candidates: agentSwitcherCandidates,
    });
  }, [
    activeServer.id,
    agentSwitcherCandidates,
    settings.general.agentConversationMruByServer,
  ]);

  const findConversationSummaryById = useCallback(
    (conversationId: string): AgentRailConversationSummary | null => {
      for (const group of orderedGroups) {
        const match = group.conversations.find((c) => c.id === conversationId);
        if (match) {
          return match;
        }
      }
      return null;
    },
    [orderedGroups]
  );

  const cycleAgentConversation = useCallback(
    (delta: 1 | -1) => {
      const collapsed = readAgentRailCollapsedWorkspaceIdsForCycle();
      const flat = buildAgentRailCycleOrder({
        activeWorkspaceId,
        groups: groupsForRail,
        pinnedRailConversations,
        attentionRailConversations,
        runningRailConversations,
        collapsedWorkspaceIds: collapsed,
      });
      const currentId = isDraftConversationSelected ? null : selectedConversationId;
      const nextIdx = nextAgentRailCycleIndex(currentId, flat, delta);
      if (nextIdx == null) {
        return;
      }
      void openConversationSummary(flat[nextIdx]);
    },
    [
      activeWorkspaceId,
      groupsForRail,
      isDraftConversationSelected,
      openConversationSummary,
      pinnedRailConversations,
      attentionRailConversations,
      runningRailConversations,
      selectedConversationId,
    ]
  );

  const value = useMemo<AgentShellStateContextValue>(
    () => ({
      leftRailCollapsed: sharedLeftRailCollapsed,
      setLeftRailCollapsed,
      toggleLeftRailCollapsed,
      rightPaneOpen,
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
      startNewChatInWorkspace,
      startStandaloneChat,
      standaloneDraftActive,
      setStandaloneDraftActive,
      cycleAgentConversation,
      openConversationSummary,
      agentSwitcherItems,
      findConversationSummaryById,
      bumpAgentConversationMruForServer,
      groups: groupsForRail,
      backends,
      activeWorkspaceGroup,
      selectedConversationSummary,
      railLoading,
      railRefreshing,
      railLoadError,
      refreshConversationGroups: refreshConversationGroupsWithState,
      applyOptimisticRailTitle,
      archiveConversation,
      unarchiveConversation,
      settleConversation,
      unsettleConversation,
      settledModeEnabled,
      pinnedRailConversations,
      attentionRailConversations,
      runningRailConversations,
      pinConversation,
      unpinConversation,
      railFilterToggles,
      railFilterActive,
      setRailFilterToggle,
      clearRailFilters,
      unreadCompletionByConversationId:
        workspaceSession.chat.unreadChatCompletionByConversationId,
      acknowledgedFailureByConversationId:
        workspaceSession.chat.acknowledgedFailureByConversationId,
      railWorkspaceNameById,
      isMobile,
    }),
    [
      activeWorkspaceGroup,
      activeSidePaneSession.editor,
      activeSidePaneSession.expandedComposerDraftId,
      effectiveAgentShellDesktopLayout,
      archiveConversation,
      backends,
      clearRailFilters,
      agentSwitcherItems,
      bumpAgentConversationMruForServer,
      cycleAgentConversation,
      findConversationSummaryById,
      pendingConversationSelection,
      groupsForRail,
      isMobile,
      isDraftConversationSelected,
      openConversationSummary,
      startNewChatInWorkspace,
      startStandaloneChat,
      standaloneDraftActive,
      setStandaloneDraftActive,
      pinConversation,
      pinnedRailConversations,
      attentionRailConversations,
      runningRailConversations,
      settleConversation,
      unsettleConversation,
      settledModeEnabled,
      railFilterActive,
      railFilterToggles,
      railLoading,
      railRefreshing,
      railLoadError,
      refreshConversationGroupsWithState,
      rightPaneOpen,
      applyOptimisticRailTitle,
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
      workspaceSession.chat.unreadChatCompletionByConversationId,
      workspaceSession.chat.acknowledgedFailureByConversationId,
      railWorkspaceNameById,
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
