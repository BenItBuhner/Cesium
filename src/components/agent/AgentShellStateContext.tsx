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
import { isStandaloneChatWorkspace } from "@/lib/types";
import {
  formatProvisionalChatTitleFromComposer,
  landingDraftUsesStandaloneWorkspace,
  resolveLandingComposerDraftId,
} from "@/lib/chat-draft-title";
import {
  createAgentConversation,
  createStandaloneAgentConversation,
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
  createDefaultAgentRailFilterState,
  isRenderableAgentRailConversation,
  isAgentRailFilterStateActive,
  matchesAgentRailFilters,
  normalizeAgentRailFilterState,
  type AgentRailFilterState,
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
  AGENT_CONVERSATIONS_UPSERTED_BATCH_EVENT,
  dispatchAgentConversationUpserted,
  type AgentConversationDeletedDetail,
  type AgentConversationsUpsertedBatchDetail,
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
  hasMeaningfulComposerContent,
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

/**
 * Push (WebSocket `conversation_upserted`) keeps the rail live; HTTP refetch
 * is only a consistency backstop. It used to run every 20s AND on every
 * focus/visibility flip, which multiplied by servers is serious network
 * churn for data that almost never differs from the pushed state.
 */
const RAIL_PERIODIC_REFRESH_MS = 120_000;
const RAIL_FOCUS_REFRESH_MIN_GAP_MS = 30_000;
import {
  filterGroupsByMachine,
  filterGroupsByWorkspaceScope,
  getRepositoryGroupingKey,
} from "@/lib/multi-server-workspaces";
import {
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
import { useCloudContext } from "@/contexts/CloudContext";
import { useCodespaces } from "@/contexts/CodespacesContext";
import {
  annotateRailGroupsForServer,
  buildConversationCatalog,
  conversationCatalogServerKey,
  conversationCatalogSignature,
  readConversationCatalogStore,
  resolveOfflineCatalogGroups,
  serializeConversationCatalogPayload,
  upsertConversationCatalog,
} from "@/lib/conversation-catalog";

/** Debounce for mirroring freshly fetched catalogs to the account. */
const CATALOG_CLOUD_PUSH_DELAY_MS = 4_000;

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
  /**
   * Mark a conversation settled (sinks to the bottom until a new prompt
   * unsettles it). Pass `forMs` for a temporary settle ("ignore for a day")
   * that auto-unsettles once the duration elapses.
   */
  settleConversation: (
    conversation: AgentRailConversationSummary,
    options?: { forMs?: number }
  ) => Promise<void>;
  unsettleConversation: (conversation: AgentRailConversationSummary) => Promise<void>;
  pinnedRailConversations: AgentRailConversationSummary[];
  attentionRailConversations: AgentRailConversationSummary[];
  /** Actively working agents, elevated into their own cross-workspace section. */
  runningRailConversations: AgentRailConversationSummary[];
  pinConversation: (conversationId: string) => void;
  unpinConversation: (conversationId: string) => void;
  railFilters: AgentRailFilterState;
  railFilterActive: boolean;
  setRailFilters: (next: AgentRailFilterState) => void;
  clearRailFilters: () => void;
  /** Clears every unread-completion flag (the rail's "Mark all as read"). */
  markAllConversationsRead: () => void;
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
  const cloud = useCloudContext();
  const codespaces = useCodespaces();
  const {
    composerDrafts,
    resetComposerDraft,
    upsertComposerDraft,
  } = useOpenInEditor();
  const composerDraftsRef = useRef(composerDrafts);
  composerDraftsRef.current = composerDrafts;
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
  const standaloneDraftActiveRef = useRef(standaloneDraftActive);
  standaloneDraftActiveRef.current = standaloneDraftActive;
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

  /* ---------------------- conversation catalogs ---------------------- */

  const serversRef = useRef(servers);
  serversRef.current = servers;
  const codespaceDevicesRef = useRef(codespaces.devices);
  codespaceDevicesRef.current = codespaces.devices;
  const cloudActionsRef = useRef(cloud.actions);
  cloudActionsRef.current = cloud.actions;
  const pushedCatalogSignaturesRef = useRef(new Map<string, string>());
  const pendingCatalogPushRef = useRef(
    new Map<string, ReturnType<typeof setTimeout>>()
  );

  const catalogServerKeyFor = useCallback(
    (server: Pick<ServerConnection, "baseUrl">) =>
      conversationCatalogServerKey(server, codespaceDevicesRef.current),
    []
  );

  /**
   * A live listing just arrived from `server`: remember it locally and mirror
   * it to the account (debounced, only when it actually changed) so this and
   * every other device can show it once the engine goes to sleep.
   */
  const recordConversationCatalog = useCallback(
    (server: ServerConnection, liveGroups: AgentConversationGroup[]) => {
      const serverKey = catalogServerKeyFor(server);
      if (!serverKey) {
        return;
      }
      const catalog = buildConversationCatalog({ serverKey, server, groups: liveGroups });
      upsertConversationCatalog(catalog);
      const signature = conversationCatalogSignature(catalog);
      if (pushedCatalogSignaturesRef.current.get(serverKey) === signature) {
        return;
      }
      const existingTimer = pendingCatalogPushRef.current.get(serverKey);
      if (existingTimer) {
        clearTimeout(existingTimer);
      }
      pendingCatalogPushRef.current.set(
        serverKey,
        setTimeout(() => {
          pendingCatalogPushRef.current.delete(serverKey);
          const actions = cloudActionsRef.current;
          if (!actions) {
            return;
          }
          pushedCatalogSignaturesRef.current.set(serverKey, signature);
          void actions
            .saveConversationCatalog({
              serverKey,
              serverName: catalog.serverName,
              baseUrl: catalog.baseUrl,
              payload: serializeConversationCatalogPayload(catalog),
              conversationCount: catalog.conversationCount,
              sourceUpdatedAt: catalog.sourceUpdatedAt,
            })
            .catch(() => {
              // Retry on the next changed listing.
              pushedCatalogSignaturesRef.current.delete(serverKey);
            });
        }, CATALOG_CLOUD_PUSH_DELAY_MS)
      );
    },
    [catalogServerKeyFor]
  );

  useEffect(
    () => () => {
      for (const timer of pendingCatalogPushRef.current.values()) {
        clearTimeout(timer);
      }
      pendingCatalogPushRef.current.clear();
    },
    []
  );

  /**
   * Cached groups for every saved server that did not answer this round.
   * A server whose fetch was attempted and failed is unreachable by direct
   * evidence; the rest qualify once their health probe says offline. Servers
   * still unprobed (and not attempted) are skipped so a healthy machine
   * never flashes as offline during the first paint; auth-required servers
   * already get their own placeholder.
   */
  const resolveOfflineGroups = useCallback(
    (fetchedServerIds: ReadonlySet<string>, failedServerIds: ReadonlySet<string>) => {
      const statusById = serverStatusByIdRef.current;
      const candidates = serversRef.current.filter((server) => {
        if (fetchedServerIds.has(server.id)) {
          return false;
        }
        const health = statusById[server.id]?.health ?? "unknown";
        if (health === "auth_required") {
          return false;
        }
        return failedServerIds.has(server.id) || health !== "unknown";
      });
      if (candidates.length === 0) {
        return [];
      }
      return resolveOfflineCatalogGroups({
        servers: candidates,
        fetchedServerIds,
        store: readConversationCatalogStore(),
        serverKeyFor: catalogServerKeyFor,
      });
    },
    [catalogServerKeyFor]
  );

  const applyRailGroupsResult = useCallback(
    (
      servers: ServerConnection[],
      successful: Array<{
        server: ServerConnection;
        backends: AgentBackendInfo[];
        groups: AgentConversationGroup[];
      }>
    ) => {
      const fetchedServerIds = new Set(successful.map((result) => result.server.id));
      const offlineGroups = resolveOfflineGroups(
        fetchedServerIds,
        new Set(servers.map((server) => server.id).filter((id) => !fetchedServerIds.has(id)))
      );
      if (successful.length === 0 && offlineGroups.length === 0) {
        return false;
      }
      if (successful.length > 0) {
        setBackends(mergeAgentBackends(successful.map((result) => result.backends)));
      }
      setGroups(
        mergeAuthRequiredServerPlaceholders(
          mergeDirectoryPlaceholders(
            [...successful.flatMap((result) => result.groups), ...offlineGroups],
            directoryWorkspaces
          ),
          servers,
          serverStatusByIdRef.current
        )
      );
      railHasDataRef.current = true;
      return true;
    },
    [directoryWorkspaces, resolveOfflineGroups]
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
          const liveGroups = annotateRailGroupsForServer(
            removePlaceholderRailConversations(result.groups),
            server
          );
          recordConversationCatalog(server, liveGroups);
          return {
            server,
            backends: result.backends,
            groups: liveGroups,
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
      const liveGroups = annotateRailGroupsForServer(
        removePlaceholderRailConversations(result.groups),
        activeServer
      );
      recordConversationCatalog(activeServer, liveGroups);
      setBackends(result.backends);
      setGroups(
        mergeAuthRequiredServerPlaceholders(
          mergeDirectoryPlaceholders(
            [...liveGroups, ...resolveOfflineGroups(new Set([activeServer.id]), new Set())],
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
      // Last resort: the active engine itself is unreachable. Its cached
      // catalog (an asleep codespace's conversations, typically) beats an
      // error screen, and opening a row runs the wake path.
      const cached = resolveOfflineGroups(new Set(), new Set([activeServer.id]));
      if (cached.length > 0 && fetchGeneration === railFetchGenerationRef.current) {
        setGroups(
          mergeAuthRequiredServerPlaceholders(
            mergeDirectoryPlaceholders(cached, directoryWorkspaces),
            servers,
            serverStatusByIdRef.current
          )
        );
        railHasDataRef.current = true;
        return;
      }
      throw error;
    }
  }, [
    activeServer,
    applyRailGroupsResult,
    directoryWorkspaces,
    onlineServers,
    recordConversationCatalog,
    resolveOfflineGroups,
  ]);

  // Failsafe for the initial "Loading chats..." spinner. Deliberately
  // decoupled from the loader effect below: that effect re-runs whenever its
  // dependencies churn during startup (health probes flipping onlineServers,
  // the workspace directory arriving, active-server changes), and an
  // effect-scoped timer would be cleared on every re-run - leaving the
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

  const lastRailRefreshAtRef = useRef(0);
  const refreshConversationGroupsWithState = useCallback(async () => {
    if (railRefreshInFlightRef.current) {
      // The owner of the in-flight promise handles its rejection below; every
      // other caller `void`s this function, so hand them a settled-safe view or
      // an offline server surfaces as "Uncaught (in promise) TypeError: Failed
      // to fetch" on each focus/visibility refresh.
      return railRefreshInFlightRef.current.then(
        () => undefined,
        () => undefined
      );
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
      lastRailRefreshAtRef.current = Date.now();
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

  /**
   * Focus/visibility/online handlers used to refetch unconditionally, so
   * window-switching sprayed full cross-workspace list fetches. Live updates
   * arrive over the agent WebSocket; an HTTP refetch is only a staleness
   * backstop and can skip when one ran recently.
   */
  const refreshConversationGroupsIfStale = useCallback(
    (staleAfterMs: number) => {
      if (Date.now() - lastRailRefreshAtRef.current < staleAfterMs) {
        return;
      }
      void refreshConversationGroupsWithState();
    },
    [refreshConversationGroupsWithState]
  );

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
      refreshConversationGroupsIfStale(RAIL_FOCUS_REFRESH_MIN_GAP_MS);
    };
    const handleVisibility = () => {
      if (document.visibilityState === "visible" && !browserIsOffline()) {
        refreshConversationGroupsIfStale(RAIL_FOCUS_REFRESH_MIN_GAP_MS);
      }
    };
    const handleOnline = () => {
      if (document.visibilityState === "hidden") return;
      // Coming back online is a real gap in push coverage - always refetch.
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
  }, [refreshConversationGroupsIfStale, refreshConversationGroupsWithState]);

  useEffect(() => {
    const interval = window.setInterval(() => {
      if (
        document.visibilityState === "hidden" ||
        (typeof navigator !== "undefined" && navigator.onLine === false)
      ) {
        return;
      }
      refreshConversationGroupsIfStale(RAIL_PERIODIC_REFRESH_MS - 5_000);
    }, RAIL_PERIODIC_REFRESH_MS);
    return () => window.clearInterval(interval);
  }, [refreshConversationGroupsIfStale]);

  useEffect(() => {
    // The rail renders every conversation row, so each groups update is the
    // most expensive state application in the shell. Pushed record batches
    // coalesce here for up to a second under sustained load (latest record
    // per conversation wins); a quiet period applies the first batch
    // immediately so light activity still feels instant.
    const pendingRecords = new Map<string, AgentConversationUpsertedDetail>();
    let applyTimer: ReturnType<typeof setTimeout> | null = null;
    let lastApplyAt = 0;
    const RAIL_PATCH_COALESCE_MS = 1_000;

    const applyPending = () => {
      applyTimer = null;
      if (pendingRecords.size === 0) {
        return;
      }
      const records = [...pendingRecords.values()];
      pendingRecords.clear();
      lastApplyAt = Date.now();
      if (railInitialLoadCompletedRef.current) {
        railFetchGenerationRef.current += 1;
      }
      setGroups((prev) =>
        records.reduce(
          (acc, record) =>
            patchAgentConversationGroups(acc, record, record.serverId ?? activeServer.id),
          prev
        )
      );
    };

    const onUpsertBatch = (ev: Event) => {
      const detail = (ev as CustomEvent<AgentConversationsUpsertedBatchDetail>).detail;
      const records = (detail?.conversations ?? []).filter(
        (record) => record?.id && record.workspaceId
      );
      if (records.length === 0) {
        return;
      }
      for (const record of records) {
        pendingRecords.set(record.id, record);
      }
      if (applyTimer != null) {
        return;
      }
      const delay = Math.max(0, RAIL_PATCH_COALESCE_MS - (Date.now() - lastApplyAt));
      applyTimer = setTimeout(applyPending, delay);
    };
    const onDeleted = (ev: Event) => {
      const detail = (ev as CustomEvent<AgentConversationDeletedDetail>).detail;
      if (!detail?.conversationId || !detail.workspaceId) {
        return;
      }
      // A queued upsert for the deleted conversation must not resurrect it.
      pendingRecords.delete(detail.conversationId);
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
    window.addEventListener(AGENT_CONVERSATIONS_UPSERTED_BATCH_EVENT, onUpsertBatch);
    window.addEventListener(AGENT_CONVERSATION_DELETED_EVENT, onDeleted);
    return () => {
      window.removeEventListener(AGENT_CONVERSATIONS_UPSERTED_BATCH_EVENT, onUpsertBatch);
      window.removeEventListener(AGENT_CONVERSATION_DELETED_EVENT, onDeleted);
      if (applyTimer != null) {
        clearTimeout(applyTimer);
      }
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

  // Timed settles ("ignore for a day") expire server-side on read; schedule a
  // refresh right after the earliest expiry so the row resurfaces without any
  // user interaction.
  useEffect(() => {
    const now = Date.now();
    let earliest = Number.POSITIVE_INFINITY;
    for (const group of groups) {
      for (const conversation of group.conversations) {
        if (
          conversation.settledAt != null &&
          conversation.settledUntil != null &&
          conversation.settledUntil > now
        ) {
          earliest = Math.min(earliest, conversation.settledUntil);
        }
      }
    }
    if (!Number.isFinite(earliest)) {
      return;
    }
    const delay = Math.min(Math.max(earliest - now + 1_000, 1_000), 2_147_000_000);
    const timer = setTimeout(() => {
      void refreshConversationGroupsWithState();
    }, delay);
    return () => clearTimeout(timer);
  }, [groups, refreshConversationGroupsWithState]);

  const visibleMachineGroups = useMemo(
    () => filterGroupsByMachine(groups, settings.general.agentRail.hiddenServerIds),
    [groups, settings.general.agentRail.hiddenServerIds]
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
          orderBy: settings.general.agentRail.orderBy,
        }
      ),
    [
      settings.general.agentRail.groupBy,
      settings.general.agentRail.orderBy,
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
  // after that - session layout changes when switching workspaces and must not clobber user prefs.
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
    // Never clobber a real persisted id with null while the rail is still loading - same race
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

  const persistLandingComposerDraft = useCallback(async () => {
    const activeIsStandaloneChat = Boolean(
      activeWorkspaceGroup && isStandaloneChatWorkspace(activeWorkspaceGroup.workspace)
    );
    const draftId = resolveLandingComposerDraftId({
      standaloneDraftActive: standaloneDraftActiveRef.current,
      activeWorkspaceId: activeWorkspaceGroup?.workspace.id ?? activeWorkspaceId,
      activeIsStandaloneChat,
    });
    const draft = composerDraftsRef.current[draftId];
    if (!draft || !hasMeaningfulComposerContent(draft)) {
      return null;
    }

    const snapshot = draft;
    const title = formatProvisionalChatTitleFromComposer(snapshot);
    resetComposerDraft(draftId);

    const composer = settings.composer;
    const input = {
      backendId: composer.backendId,
      mode: composer.mode,
      modelId: composer.model.modelValue ?? composer.model.id,
      modelName: composer.model.name,
      ...(composer.backendId === "cesium-agent" && composer.profileId?.trim()
        ? { profileId: composer.profileId.trim() }
        : {}),
      title,
    };

    try {
      const useStandalone = landingDraftUsesStandaloneWorkspace({
        standaloneDraftActive: standaloneDraftActiveRef.current,
        activeWorkspaceId: activeWorkspaceId,
        activeIsStandaloneChat,
      });
      const result = useStandalone
        ? await createStandaloneAgentConversation(input, title)
        : await createAgentConversation(input);
      const conversation = result.conversation;
      upsertComposerDraft(conversation.id, {
        title: snapshot.title,
        content: snapshot.content,
        attachments: snapshot.attachments,
        captures: snapshot.captures,
        textReferences: snapshot.textReferences,
        linkReferences: snapshot.linkReferences,
      });
      dispatchAgentConversationUpserted(conversation);
      void refreshConversationGroups().catch(() => undefined);
      return conversation;
    } catch (error) {
      upsertComposerDraft(draftId, {
        title: snapshot.title,
        content: snapshot.content,
        attachments: snapshot.attachments,
        captures: snapshot.captures,
        textReferences: snapshot.textReferences,
        linkReferences: snapshot.linkReferences,
      });
      console.warn("[agent] failed to persist new-chat draft:", error);
      return null;
    }
  }, [
    activeWorkspaceGroup,
    activeWorkspaceId,
    refreshConversationGroups,
    resetComposerDraft,
    settings.composer,
    upsertComposerDraft,
  ]);

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
      if (
        conversationId &&
        conversationId !== AGENT_NEW_CHAT_SESSION_ID &&
        isDraftConversationSelected
      ) {
        void persistLandingComposerDraft();
      }
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
    [
      bumpAgentConversationMruForServer,
      isDraftConversationSelected,
      persistLandingComposerDraft,
      replaceConversationIdInLocation,
      updateWorkspaceSession,
    ]
  );

  const startNewConversation = useCallback(() => {
    // Persist the in-progress landing composer as a rail draft, then clear
    // the stable landing ids so New Chat never inherits leftover text.
    void persistLandingComposerDraft();
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
    persistLandingComposerDraft,
    replaceConversationIdInLocation,
    resetComposerDraft,
    setLeftRailCollapsed,
    updateWorkspaceSession,
  ]);

  const startStandaloneChat = useCallback(() => {
    void persistLandingComposerDraft();
    setStandaloneDraftActive(true);
    startNewConversation();
  }, [persistLandingComposerDraft, startNewConversation]);

  const startNewChatInWorkspace = useCallback(
    async (workspaceId: string) => {
      void persistLandingComposerDraft();
      // Must run before any `await`. `loadWorkspaceState` rewrites `workspaceId` in the URL but
      // keeps the old `conversationId` until loading finishes. While the async fetch runs, the
      // effect below sees (active workspace B + URL conversation owned by A) and calls
      // `openWorkspaceById(A)` to "honor" the deep link - undoing the rail + click. Drafting the
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
      persistLandingComposerDraft,
      replaceConversationIdInLocation,
      startNewConversation,
    ]
  );

  const openConversationSummary = useCallback(
    async (summary: AgentRailConversationSummary) => {
      markConversationSwitchStart(summary.id, "rail");
      bumpAgentConversationMruForServer(summary.id);
      setStandaloneDraftActive(false);
      setPendingConversationSelection({
        workspaceId: summary.workspaceId,
        conversationId: summary.id,
      });
      let targetServerId = summary.serverId ?? null;
      try {
        // A row restored from a catalog belongs to an engine that did not
        // answer. For a paired codespace that means "asleep": start it (and
        // sign in) before switching, otherwise the switch would land on a
        // dead connection and the conversation could not load.
        if (summary.serverOffline && summary.serverId) {
          const device = codespaces.deviceForServerId(summary.serverId);
          if (device) {
            pushNotification({
              kind: WORKBENCH_NOTIFICATION_KIND.editorNotice,
              severity: "info",
              title: "Waking Codespace",
              message: `Starting ${device.label} so "${summary.title}" can load. This can take a minute on a cold resume.`,
              autoDismissMs: 12_000,
              compact: true,
            });
            const wokenServerId = await codespaces.connectDevice(device);
            if (!wokenServerId) {
              const failure = codespaces.getLastWakeFailure();
              pushNotification({
                kind: WORKBENCH_NOTIFICATION_KIND.editorNotice,
                severity: "error",
                title:
                  failure?.reason === "deleted"
                    ? "Codespace No Longer Exists"
                    : "Could Not Wake Codespace",
                message:
                  failure?.message ??
                  "The codespace did not come online. Open the device picker to retry or recreate it.",
                autoDismissMs: 12_000,
                compact: true,
              });
              return;
            }
            targetServerId = wokenServerId;
            const warning = codespaces.getLastWakeWarning();
            if (warning) {
              pushNotification({
                kind: WORKBENCH_NOTIFICATION_KIND.editorNotice,
                severity: "warning",
                title: "Codespace Keep-Alive Warning",
                message: warning,
                autoDismissMs: 15_000,
                compact: true,
              });
            }
            void refreshConversationGroupsWithState();
          } else {
            // Plain machines have no remote start button; switch anyway so
            // the selection lands the moment the machine is back.
            pushNotification({
              kind: WORKBENCH_NOTIFICATION_KIND.editorNotice,
              severity: "warning",
              title: "Machine Offline",
              message: `${summary.serverLabel ?? "This machine"} is not reachable right now. "${summary.title}" is shown from the last saved listing and will open once the machine is back online.`,
              autoDismissMs: 10_000,
              compact: true,
            });
          }
        }
        if (targetServerId && targetServerId !== activeServer.id) {
          setActiveServer(targetServerId);
        }
        if (summary.workspaceId !== activeWorkspaceId) {
          try {
            await openWorkspaceById(summary.workspaceId);
          } catch (error) {
            // Expected for a machine we already told the user is offline:
            // the warning above covers it. Anything else stays loud.
            if (!summary.serverOffline) {
              throw error;
            }
            return;
          }
        }
        setSelectedConversationId(summary.id);
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
      codespaces,
      openWorkspaceById,
      pushNotification,
      refreshConversationGroupsWithState,
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
    async (
      summary: AgentRailConversationSummary,
      settled: boolean,
      options?: { forMs?: number }
    ) => {
      const mutationKey =
        summary.conversationKey ??
        `${summary.serverId ?? activeServer.id}:${summary.workspaceId}:${summary.id}`;
      const sequence = (settleMutationSequenceRef.current.get(mutationKey) ?? 0) + 1;
      settleMutationSequenceRef.current.set(mutationKey, sequence);
      railFetchGenerationRef.current += 1;
      const forMs =
        settled && typeof options?.forMs === "number" && Number.isFinite(options.forMs)
          ? Math.max(0, Math.floor(options.forMs))
          : null;
      const now = Date.now();
      // Rank-neutral on purpose: settling must not bump the row's recency,
      // it only re-partitions the row into/out of the settled tail.
      setGroups((current) =>
        patchAgentConversationSummaryInGroups(current, summary, {
          settledAt: settled ? now : null,
          settledUntil: settled && forMs ? now + forMs : null,
        })
      );

      const targetServer =
        (summary.serverId
          ? servers.find((server) => server.id === summary.serverId)
          : activeServer) ?? activeServer;
      try {
        const { conversation } = await patchAgentConversationMetadata(
          summary.id,
          { settled, ...(forMs ? { settledForMs: forMs } : {}) },
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
              settledUntil: summary.settledUntil ?? null,
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
    (conversation: AgentRailConversationSummary, options?: { forMs?: number }) =>
      setConversationSettled(conversation, true, options),
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

  const railFilters = useMemo(
    () =>
      normalizeAgentRailFilterState(
        workspaceSession.agentView.railFilters,
        workspaceSession.agentView.railFilterToggles,
        workspaceSession.agentView.filterPreset
      ),
    [
      workspaceSession.agentView.filterPreset,
      workspaceSession.agentView.railFilters,
      workspaceSession.agentView.railFilterToggles,
    ]
  );

  const railFilterActive = useMemo(
    () => isAgentRailFilterStateActive(railFilters),
    [railFilters]
  );

  const setRailFilters = useCallback(
    (next: AgentRailFilterState) => {
      updateWorkspaceSession((current) => ({
        ...current,
        agentView: {
          ...current.agentView,
          railFilters: normalizeAgentRailFilterState(next),
          filterPreset: "default",
        },
      }));
    },
    [updateWorkspaceSession]
  );

  const clearRailFilters = useCallback(() => {
    updateWorkspaceSession((current) => ({
      ...current,
      agentView: {
        ...current.agentView,
        railFilters: createDefaultAgentRailFilterState(),
        filterPreset: "default",
      },
    }));
  }, [updateWorkspaceSession]);

  const markAllConversationsRead = useCallback(() => {
    updateWorkspaceSession((current) => {
      const unread = current.chat.unreadChatCompletionByConversationId ?? {};
      if (Object.keys(unread).length === 0) {
        return current;
      }
      return {
        ...current,
        chat: {
          ...current.chat,
          unreadChatCompletionByConversationId: {},
        },
      };
    });
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
          matchesAgentRailFilters(c, railFilters, railFilterMatchContext)
        ),
      })),
    [orderedGroups, railFilterMatchContext, railFilters]
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
        return matchesAgentRailFilters(c, railFilters, railFilterMatchContext);
      });
  }, [orderedGroups, pinnedAgentConversationIds, railFilterMatchContext, railFilters]);

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
      pinnedRailConversations,
      attentionRailConversations,
      runningRailConversations,
      pinConversation,
      unpinConversation,
      railFilters,
      railFilterActive,
      setRailFilters,
      clearRailFilters,
      markAllConversationsRead,
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
      railFilterActive,
      railFilters,
      markAllConversationsRead,
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
      setRailFilters,
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
