"use client";

import {
  ChevronDown,
  ChevronRight,
  CircleUserRound,
  FolderPlus,
  GitBranchPlus,
  ListFilter,
  MessageSquare,
  PanelLeftClose,
  Pin,
  Plus,
  Search,
  Settings,
} from "lucide-react";
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type DragEvent as ReactDragEvent,
  type MouseEvent as ReactMouseEvent,
  type ReactNode,
} from "react";
import { useWorkbenchContextMenu } from "@/components/ide/WorkbenchContextMenuProvider";
import { useEditorBridgeRef } from "@/components/ide/EditorBridgeContext";
import type { WorkbenchMenuItem } from "@/components/ide/workbench-context-menu-types";
import { RecentChatsModal, type RecentChatOption } from "@/components/ide/RecentChatsModal";
import { AgentConversationRow } from "@/components/agent/rail/AgentConversationRow";
import { AgentRailBulkSelectBar } from "@/components/agent/rail/AgentRailBulkSelectBar";
import {
  applyRailBulkClick,
  buildRailBulkSectionId,
  getRailConversationKey,
  orderedRailConversationKeys,
  railBulkClickModifierInBulkMode,
} from "@/lib/agent-rail-bulk-select";
import { useAgentConversations } from "@/components/chat/AgentConversationsContext";
import { useOpenInEditor } from "@/components/editor/OpenInEditorContext";
import type { AgentRailConversationSummary } from "@/lib/agent-types";
import {
  AGENT_RAIL_FILTER_TOGGLE_KEYS,
  type AgentRailFilterToggleKey,
} from "@/lib/agent-rail";
import { AGENT_RAIL_OPEN_SEARCH_EVENT } from "@/components/agent/agent-rail-events";
import { AgentRailFilterMenuPortal } from "@/components/agent/AgentRailFilterMenuPortal";
import { useShellView } from "@/components/layout/ShellViewContext";
import { useAgentShellState } from "./AgentShellStateContext";
import { useWorkspace } from "@/contexts/WorkspaceContext";
import { useUserPreferences } from "@/components/preferences/UserPreferencesProvider";
import { useGlobalSettings } from "@/components/preferences/GlobalSettingsProvider";
import { ServerPickerPopover } from "@/components/preferences/ServerPickerPopover";
import { useServerConnections } from "@/components/preferences/ServerConnectionsProvider";
import { useWorkspaceDirectory } from "@/contexts/WorkspaceDirectoryContext";
import type {
  AgentRailGroupByMode,
  AgentRailSectionId,
  ChatFolderState,
  ServerRailAppearance,
  WorkspaceRailAppearance,
  WorkspaceSortMode,
} from "@/lib/global-settings";
import { isStandaloneChatWorkspace } from "@/lib/types";
import {
  getServerDisplayLabel,
  getServerRailAppearance,
  isLocalDeviceServer,
} from "@/lib/server-rail-appearance";
import {
  getLastWorkspaceForServer,
  rememberLastWorkspaceForServer,
} from "@/lib/per-server-workspace-memory";
import {
  createWorkspaceGitWorktree,
  startOrchestrationMode,
} from "@/lib/server-api";
import { dispatchAgentConversationUpserted } from "@/lib/agent-conversation-events";
import { agentRecordToRailSummary } from "@/lib/agent-rail-patch";
import { usePersistHomeWorkspaceRailAppearances } from "@/hooks/usePersistHomeWorkspaceRailAppearances";
import { AGENT_NEW_CHAT_SESSION_ID } from "@/lib/workspace-session";
import {
  FOLDER_COLOR_OPTIONS,
  FOLDER_ICON_OPTIONS,
  getFolderIcon,
  getWorkspaceRailAppearance,
  isValidFolderColor,
  resolveGroupWorkspaceAppearanceKey,
  WorkspaceFolderIcon,
} from "@/lib/workspace-rail-appearance";
import {
  STANDALONE_CHATS_FOLDER_SCOPE,
  createChatFolderState,
  getChatFoldersForScope,
  isStandaloneChatFolderScope,
  moveConversationInChatFolders,
  partitionConversationsByFolders,
  reorderChatFolders,
  updateRootOrderForMove,
  upsertChatFoldersWithNewFolder,
  type ChatFolderPlacement,
} from "@/lib/chat-folders";

const PINNED_SECTION_WORKSPACE_ID = "__agentPinned__";
const CHATS_SECTION_WORKSPACE_ID = STANDALONE_CHATS_FOLDER_SCOPE;
const AGENT_RAIL_CONVERSATION_DRAG_TYPE = "application/x-opencursor-agent-conversation";
const AGENT_RAIL_FOLDER_DRAG_TYPE = "application/x-opencursor-agent-chat-folder";

const COLLAPSED_WORKSPACES_STORAGE_KEY = "opencursor.agent-rail-collapsed-workspaces";
const COLLAPSED_FOLDERS_STORAGE_KEY = "opencursor.agent-rail-collapsed-folders";

function WorkspaceRailHeaderIcon({
  appearance,
  collapsed,
  onCustomize,
}: {
  appearance: WorkspaceRailAppearance;
  collapsed: boolean;
  onCustomize: () => void;
}) {
  return (
    <span
      className="relative grid size-[10px] shrink-0 place-items-center"
      onContextMenu={(event) => {
        event.preventDefault();
        event.stopPropagation();
        onCustomize();
      }}
    >
      <WorkspaceFolderIcon
        iconName={appearance.icon}
        color={appearance.color}
        className="col-start-1 row-start-1 size-[10px] group-hover/wshead:opacity-0"
        strokeWidth={2}
      />
      <ChevronRight
        className={`col-start-1 row-start-1 size-[10px] text-[var(--text-disabled)] opacity-0 group-hover/wshead:opacity-100 group-hover/wshead:text-[var(--text-secondary)] ${
          collapsed ? "" : "rotate-90"
        }`}
        strokeWidth={2}
      />
    </span>
  );
}

function createChatFolderId(): string {
  if (typeof crypto !== "undefined" && "randomUUID" in crypto) {
    return crypto.randomUUID();
  }
  return `folder-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

function readCollapsedWorkspaceIdsFromStorage(): Set<string> {
  if (typeof window === "undefined") {
    return new Set();
  }
  try {
    const raw = window.localStorage.getItem(COLLAPSED_WORKSPACES_STORAGE_KEY);
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

function readCollapsedFolderIdsFromStorage(): Set<string> {
  if (typeof window === "undefined") {
    return new Set();
  }
  try {
    const raw = window.localStorage.getItem(COLLAPSED_FOLDERS_STORAGE_KEY);
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

function writeCollapsedWorkspaceIdsToStorage(ids: Set<string>) {
  try {
    window.localStorage.setItem(
      COLLAPSED_WORKSPACES_STORAGE_KEY,
      JSON.stringify([...ids])
    );
  } catch {
    /* quota or private mode */
  }
}

function writeCollapsedFolderIdsToStorage(ids: Set<string>) {
  try {
    window.localStorage.setItem(
      COLLAPSED_FOLDERS_STORAGE_KEY,
      JSON.stringify([...ids])
    );
  } catch {
    /* quota or private mode */
  }
}

const FILTER_TOGGLE_LABELS: Record<AgentRailFilterToggleKey, string> = {
  archived: "Archived",
  running: "Running",
  needs_attention: "Needs attention",
  pinned: "Pinned",
  unread: "Unread",
  read: "Read",
  external: "External sources",
};

const WORKSPACE_SORT_LABELS: Record<WorkspaceSortMode, string> = {
  recent: "Recently opened",
  alphabetical: "Alphabetical",
  machine: "Machine",
  custom: "Custom order",
};

/**
 * Only the conversation list scrolls; rail header + account row stay outside this node.
 * Fades sit in the list viewport (same idea as HorizontalFadedScroll / tool rows).
 */
function AgentRailConversationListScroll({
  children,
  measureKey,
}: {
  children: ReactNode;
  measureKey: string | number;
}) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const topFadeRef = useRef<HTMLDivElement>(null);
  const bottomFadeRef = useRef<HTMLDivElement>(null);
  const leftFadeRef = useRef<HTMLDivElement>(null);
  const rightFadeRef = useRef<HTMLDivElement>(null);
  const fadeStateRef = useRef({
    top: false,
    bottom: false,
    left: false,
    right: false,
  });
  const scrollRafRef = useRef<number | null>(null);

  const updateFade = useCallback(() => {
    const el = scrollRef.current;
    if (!el) {
      return;
    }
    const { scrollTop, scrollLeft, scrollWidth, clientWidth, scrollHeight, clientHeight } = el;
    const maxScrollX = scrollWidth - clientWidth;
    const maxScrollY = scrollHeight - clientHeight;
    const next = {
      top: scrollTop > 2,
      bottom: maxScrollY > 2 && scrollTop < maxScrollY - 2,
      left: scrollLeft > 2,
      right: maxScrollX > 2 && scrollLeft < maxScrollX - 2,
    };
    const prev = fadeStateRef.current;
    if (
      prev.top === next.top &&
      prev.bottom === next.bottom &&
      prev.left === next.left &&
      prev.right === next.right
    ) {
      return;
    }
    fadeStateRef.current = next;
    topFadeRef.current?.toggleAttribute("hidden", !next.top);
    bottomFadeRef.current?.toggleAttribute("hidden", !next.bottom);
    leftFadeRef.current?.toggleAttribute("hidden", !next.left);
    rightFadeRef.current?.toggleAttribute("hidden", !next.right);
  }, []);

  const scheduleUpdateFade = useCallback(() => {
    if (scrollRafRef.current != null) {
      return;
    }
    scrollRafRef.current = requestAnimationFrame(() => {
      scrollRafRef.current = null;
      updateFade();
    });
  }, [updateFade]);

  useLayoutEffect(() => {
    updateFade();
  }, [measureKey, updateFade]);

  useLayoutEffect(() => {
    const el = scrollRef.current;
    if (!el) {
      return;
    }
    const ro = new ResizeObserver(() => scheduleUpdateFade());
    ro.observe(el);
    return () => {
      ro.disconnect();
      if (scrollRafRef.current != null) {
        cancelAnimationFrame(scrollRafRef.current);
        scrollRafRef.current = null;
      }
    };
  }, [scheduleUpdateFade]);

  const edge = "var(--bg-panel)";
  const gradTop = `linear-gradient(to bottom, ${edge}, transparent)`;
  const gradBottom = `linear-gradient(to top, ${edge}, transparent)`;
  const gradLeft = `linear-gradient(to right, ${edge}, transparent)`;
  const gradRight = `linear-gradient(to left, ${edge}, transparent)`;

  return (
    <div className="relative min-h-0 min-w-0 flex-1">
      <div
        ref={topFadeRef}
        hidden
        className="pointer-events-none absolute inset-x-0 top-0 z-[2] h-[28px]"
        style={{ backgroundImage: gradTop }}
        aria-hidden
      />
      <div
        ref={bottomFadeRef}
        hidden
        className="pointer-events-none absolute inset-x-0 bottom-0 z-[2] h-[28px]"
        style={{ backgroundImage: gradBottom }}
        aria-hidden
      />
      <div
        ref={leftFadeRef}
        hidden
        className="pointer-events-none absolute inset-y-0 left-0 z-[2] w-[28px]"
        style={{ backgroundImage: gradLeft }}
        aria-hidden
      />
      <div
        ref={rightFadeRef}
        hidden
        className="pointer-events-none absolute inset-y-0 right-0 z-[2] w-[28px]"
        style={{ backgroundImage: gradRight }}
        aria-hidden
      />
      <div
        ref={scrollRef}
        onScroll={scheduleUpdateFade}
        className="hide-scrollbar-y relative z-0 h-full min-h-0 w-full min-w-0 overflow-auto px-[11px] pb-[8px] pt-[12px]"
      >
        {children}
      </div>
    </div>
  );
}

function RailIconCustomizePanel({
  title,
  icon,
  color,
  showNameField,
  name,
  nameFieldLabel = "Folder name",
  allowEmptyName = false,
  onClose,
  onUpdate,
}: {
  title: string;
  icon: string;
  color: string;
  showNameField: boolean;
  name?: string;
  nameFieldLabel?: string;
  allowEmptyName?: boolean;
  onClose: () => void;
  onUpdate: (patch: { icon?: string; color?: string; name?: string }) => void;
}) {
  return (
    <div className="ml-[13px] mt-[3px] rounded-[var(--radius-card)] border border-[var(--border-card)] bg-[var(--bg-panel)] p-[8px] shadow-[0_12px_40px_rgba(0,0,0,0.22)]">
      <div className="flex items-center gap-[8px]">
        <div
          className="flex size-[28px] shrink-0 items-center justify-center rounded-[var(--agent-control-radius)] border border-[var(--border-subtle)]"
          style={{ color }}
          aria-hidden
        >
          <WorkspaceFolderIcon iconName={icon} className="size-[16px]" strokeWidth={1.8} />
        </div>
        {showNameField ? (
          <input
            value={name ?? ""}
            maxLength={80}
            aria-label={nameFieldLabel}
            className="h-[28px] min-w-0 flex-1 rounded-[var(--agent-control-radius)] border border-[var(--border-subtle)] bg-[var(--bg-main)] px-[8px] font-sans text-[12px] text-[var(--text-primary)] outline-none transition-colors placeholder:text-[var(--text-disabled)] focus:border-[var(--accent)]"
            onChange={(event) => {
              const nextName = event.target.value.slice(0, 80);
              onUpdate({ name: allowEmptyName ? nextName : nextName || "Folder" });
            }}
            onKeyDown={(event) => {
              if (event.key === "Escape") {
                event.preventDefault();
                onClose();
              }
            }}
          />
        ) : (
          <span className="min-w-0 flex-1 truncate font-sans text-[12px] font-medium text-[var(--text-primary)]">
            {title}
          </span>
        )}
        <button
          type="button"
          onClick={onClose}
          className="h-[28px] shrink-0 rounded-[var(--agent-control-radius)] px-[8px] font-sans text-[11px] text-[var(--text-secondary)] transition-colors hover:bg-[var(--bg-card)] hover:text-[var(--text-primary)]"
        >
          Done
        </button>
      </div>

      <div className="mt-[8px] grid grid-cols-7 gap-[4px]" aria-label="Icon palette">
        {FOLDER_ICON_OPTIONS.map(({ name: iconName, Icon }) => {
          const selected = icon === iconName;
          return (
            <button
              key={iconName}
              type="button"
              onClick={() => onUpdate({ icon: iconName })}
              className={`flex size-[24px] items-center justify-center rounded-[var(--agent-control-radius)] border transition-colors ${
                selected
                  ? "border-[var(--accent)] bg-[var(--accent-bg)] text-[var(--text-primary)]"
                  : "border-transparent text-[var(--text-secondary)] hover:border-[var(--border-subtle)] hover:bg-[var(--bg-card)] hover:text-[var(--text-primary)]"
              }`}
              title={iconName}
              aria-label={`Use ${iconName} icon`}
              aria-pressed={selected}
            >
              <Icon className="size-[14px]" strokeWidth={1.8} />
            </button>
          );
        })}
      </div>

      <div className="mt-[8px] flex items-center gap-[6px]">
        <div className="flex min-w-0 flex-1 flex-wrap gap-[4px]" aria-label="Color palette">
          {FOLDER_COLOR_OPTIONS.map((swatchColor) => (
            <button
              key={swatchColor}
              type="button"
              onClick={() => onUpdate({ color: swatchColor })}
              className={`size-[var(--d2-rail-control-size)] rounded-full border transition-transform hover:scale-110 ${
                color.toLowerCase() === swatchColor.toLowerCase()
                  ? "border-[var(--text-primary)]"
                  : "border-[var(--border-card)]"
              }`}
              style={{ backgroundColor: swatchColor }}
              title={swatchColor}
              aria-label={`Use ${swatchColor} color`}
              aria-pressed={color.toLowerCase() === swatchColor.toLowerCase()}
            />
          ))}
        </div>
        <label className="flex shrink-0 items-center gap-[5px] rounded-[var(--agent-control-radius)] border border-[var(--border-subtle)] bg-[var(--bg-main)] px-[6px] py-[3px] font-sans text-[11px] text-[var(--text-secondary)]">
          Custom
          <input
            type="color"
            value={isValidFolderColor(color) ? color : "#7c3aed"}
            onChange={(event) => onUpdate({ color: event.target.value })}
            className="size-[var(--d2-rail-control-size)] cursor-pointer border-0 bg-transparent p-0"
            aria-label="Custom color"
          />
        </label>
      </div>
    </div>
  );
}

export function AgentWorkspaceRail() {
  const { openSettingsView } = useShellView();
  const { renameConversation, forkConversation } = useAgentConversations();
  const { openAgentConversation } = useOpenInEditor();
  const {
    groups,
    leftRailCollapsed,
    railLoading,
    railLoadError,
    selectedConversationId,
    startNewConversation,
    startNewChatInWorkspace,
    startStandaloneChat,
    toggleLeftRailCollapsed,
    openConversationSummary,
    refreshConversationGroups,
    applyOptimisticRailTitle,
    archiveConversation,
    pinnedRailConversations,
    pinConversation,
    unpinConversation,
    railFilterToggles,
    railFilterActive,
    setRailFilterToggle,
    clearRailFilters,
    isMobile,
  } = useAgentShellState();
  const {
    activeWorkspaceId,
    gitStatus,
    homeWorkspaceId,
    openWorkspaceById,
  } = useWorkspace();
  const editorBridgeRef = useEditorBridgeRef();
  const { experimentalIpadCustomButtons, experimentalIpadWindowedTabInset } =
    useUserPreferences();
  const { settings, updateSettings } = useGlobalSettings();
  const { activeServer, servers, serverStatusById, setActiveServer } = useServerConnections();
  const { byServerId: directoryByServerId } = useWorkspaceDirectory();
  const workspaceSortMode = settings.general.workspaceSortMode;
  const workspaceCustomOrderIds = settings.general.workspaceCustomOrderIds;
  const agentRailSettings = settings.general.agentRail;
  const padRailForWindowChrome = experimentalIpadWindowedTabInset && !isMobile;
  /** Only the top control row needs iPadOS window-chrome inset; list + footer stay full-width in the rail. */
  const railTopBarPadClass = `${padRailForWindowChrome
    ? "pl-[var(--editor-window-chrome-tab-inset)] pr-[11px]"
    : "px-[11px]"} ${isMobile ? "mobile-safe-top-pad" : ""}`;
  const { openAt, openAtPoint } = useWorkbenchContextMenu();
  const filterAnchorRef = useRef<HTMLButtonElement>(null);
  const accountAnchorRef = useRef<HTMLButtonElement>(null);
  const [filterMenuOpen, setFilterMenuOpen] = useState(false);
  const [serverPickerOpen, setServerPickerOpen] = useState(false);
  const [collapsedWorkspaceIds, setCollapsedWorkspaceIds] = useState<Set<string>>(new Set());
  const [collapsedFolderIds, setCollapsedFolderIds] = useState<Set<string>>(new Set());
  const [draggingWorkspaceId, setDraggingWorkspaceId] = useState<string | null>(null);
  const [draggingConversationId, setDraggingConversationId] = useState<string | null>(null);
  const [draggingFolderId, setDraggingFolderId] = useState<string | null>(null);
  const [editingFolderId, setEditingFolderId] = useState<string | null>(null);
  const [editingWorkspaceKey, setEditingWorkspaceKey] = useState<string | null>(null);
  const [editingServerId, setEditingServerId] = useState<string | null>(null);
  const workspaceRailAppearances = settings.general.workspaceRailAppearances;
  const serverRailAppearances = settings.general.serverRailAppearances;
  const activeServerAppearance = useMemo(
    () =>
      getServerRailAppearance(
        serverRailAppearances,
        activeServer.id,
        servers.findIndex((server) => server.id === activeServer.id)
      ),
    [activeServer.id, serverRailAppearances, servers]
  );
  const activeServerDisplayLabel = useMemo(
    () => getServerDisplayLabel(activeServer, activeServerAppearance),
    [activeServer, activeServerAppearance]
  );
  const machineOptions = useMemo(
    () =>
      servers.map((server, index) => ({
        id: server.id,
        label: getServerDisplayLabel(
          server,
          getServerRailAppearance(serverRailAppearances, server.id, index)
        ),
      })),
    [serverRailAppearances, servers]
  );
  const homeAppearancePersistEntries = useMemo(
    () =>
      groups.map((group) => {
        const workspaceKey = resolveGroupWorkspaceAppearanceKey(group, activeServer.id);
        return {
          workspaceKey,
          isHome: Boolean(homeWorkspaceId && group.workspace.id === homeWorkspaceId),
        };
      }),
    [activeServer.id, groups, homeWorkspaceId]
  );
  usePersistHomeWorkspaceRailAppearances(
    workspaceRailAppearances,
    homeAppearancePersistEntries,
    updateSettings
  );

  const [recentChatsOpen, setRecentChatsOpen] = useState(false);
  const [renameState, setRenameState] = useState<{
    conversationId: string;
    draft: string;
    original: string;
  } | null>(null);
  const [pendingEditorOpen, setPendingEditorOpen] = useState<{
    conversation: AgentRailConversationSummary;
    group?: "left" | "right";
  } | null>(null);
  const [bulkSelectMode, setBulkSelectMode] = useState(false);
  const [bulkSectionId, setBulkSectionId] = useState<string | null>(null);
  const [bulkSelectedKeys, setBulkSelectedKeys] = useState<Set<string>>(() => new Set());
  const [bulkAnchorIndex, setBulkAnchorIndex] = useState<number | null>(null);
  const [bulkSectionPinned, setBulkSectionPinned] = useState(false);
  const workspaceBranchLabel = useCallback(
    (workspaceId: string, root: string): string | null => {
      if (workspaceId === activeWorkspaceId && gitStatus?.isGitRepo) {
        return gitStatus.currentBranch
          ? gitStatus.dirty
            ? `${gitStatus.currentBranch} *`
            : gitStatus.currentBranch
          : "detached";
      }
      const normalized = root.replace(/\\/g, "/");
      if (normalized.includes("/.cesium/")) {
        return "worktree";
      }
      return null;
    },
    [activeWorkspaceId, gitStatus]
  );

  useLayoutEffect(() => {
    setCollapsedWorkspaceIds(readCollapsedWorkspaceIdsFromStorage());
    setCollapsedFolderIds(readCollapsedFolderIdsFromStorage());
  }, []);

  useEffect(() => {
    if (leftRailCollapsed && !isMobile) {
      setFilterMenuOpen(false);
    }
  }, [isMobile, leftRailCollapsed]);

  useEffect(() => {
    const onOpenSearch = () => setRecentChatsOpen(true);
    window.addEventListener(AGENT_RAIL_OPEN_SEARCH_EVENT, onOpenSearch);
    return () => window.removeEventListener(AGENT_RAIL_OPEN_SEARCH_EVENT, onOpenSearch);
  }, []);

  useLayoutEffect(() => {
    if (!selectedConversationId || selectedConversationId === AGENT_NEW_CHAT_SESSION_ID) {
      return;
    }
    const escaped =
      typeof CSS !== "undefined" && typeof CSS.escape === "function"
        ? CSS.escape(selectedConversationId)
        : selectedConversationId.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
    const row = document.querySelector(
      `[data-perf="agent-rail-row"][data-conversation-id="${escaped}"]`
    );
    row?.scrollIntoView({ block: "nearest", inline: "nearest" });
  }, [selectedConversationId]);

  const filterSummary = useMemo(() => {
    if (!railFilterActive) {
      return "Non-archived chats";
    }
    return AGENT_RAIL_FILTER_TOGGLE_KEYS.filter((k) => railFilterToggles[k])
      .map((k) => FILTER_TOGGLE_LABELS[k])
      .join(", ");
  }, [railFilterActive, railFilterToggles]);

  const sortSummary = WORKSPACE_SORT_LABELS[workspaceSortMode];
  const railControlActive =
    railFilterActive ||
    workspaceSortMode !== "recent" ||
    agentRailSettings.groupBy !== "workspace" ||
    agentRailSettings.hiddenServerIds.length > 0;

  const visibleGroups = useMemo(() => {
    const seenKeys = new Set<string>();
    const result: typeof groups = [];
    for (const group of groups) {
      if (isStandaloneChatWorkspace(group.workspace)) {
        continue;
      }
      const key = resolveGroupWorkspaceAppearanceKey(group, activeServer.id);
      if (seenKeys.has(key)) {
        continue;
      }
      seenKeys.add(key);
      result.push(group);
    }
    return result;
  }, [activeServer.id, groups]);

  const standaloneChatConversations = useMemo(() => {
    const conversations: AgentRailConversationSummary[] = [];
    for (const group of groups) {
      if (!isStandaloneChatWorkspace(group.workspace)) {
        continue;
      }
      for (const conversation of group.conversations) {
        conversations.push(conversation);
      }
    }
    return conversations;
  }, [groups]);

  const standaloneWorkspaceIds = useMemo(() => {
    const ids = new Set<string>();
    for (const group of groups) {
      if (isStandaloneChatWorkspace(group.workspace)) {
        ids.add(group.workspace.id);
      }
    }
    return ids;
  }, [groups]);

  const resolveConversationFolderScope = useCallback(
    (conversation: Pick<AgentRailConversationSummary, "workspaceId">) =>
      standaloneWorkspaceIds.has(conversation.workspaceId)
        ? STANDALONE_CHATS_FOLDER_SCOPE
        : conversation.workspaceId,
    [standaloneWorkspaceIds]
  );

  const findRailConversationById = useCallback(
    (conversationId: string): AgentRailConversationSummary | null => {
      for (const group of groups) {
        for (const conversation of group.conversations) {
          if (conversation.id === conversationId) {
            return conversation;
          }
        }
      }
      for (const conversation of pinnedRailConversations) {
        if (conversation.id === conversationId) {
          return conversation;
        }
      }
      return null;
    },
    [groups, pinnedRailConversations]
  );

  const collectScopeRootConversationIds = useCallback(
    (scopeId: string, options?: { includeConversationId?: string }) => {
      const folders = getChatFoldersForScope(settings.general.chatFolders, scopeId);
      const folderedIds = new Set<string>();
      for (const folder of folders) {
        for (const id of folder.conversationIds) {
          folderedIds.add(id);
        }
      }
      if (options?.includeConversationId) {
        folderedIds.delete(options.includeConversationId);
      }
      const conversations = isStandaloneChatFolderScope(scopeId)
        ? standaloneChatConversations
        : groups.flatMap((group) =>
            group.workspace.id === scopeId ? group.conversations : []
          );
      return conversations
        .filter((conversation) => !folderedIds.has(conversation.id))
        .map((conversation) => conversation.id);
    },
    [groups, settings.general.chatFolders, standaloneChatConversations]
  );

  const railSectionOrder = useMemo(() => {
    const order = agentRailSettings.sectionOrder ?? ["pinned", "chats", "workspaces"];
    const hidden = new Set(agentRailSettings.hiddenSections ?? []);
    return order.filter((id) => !hidden.has(id));
  }, [agentRailSettings.hiddenSections, agentRailSettings.sectionOrder]);

  const handleNewStandaloneChat = useCallback(() => {
    startStandaloneChat();
  }, [startStandaloneChat]);

  const handleActiveServerChange = useCallback(
    (serverId: string) => {
      if (serverId === activeServer.id) {
        setServerPickerOpen(false);
        return;
      }
      if (activeWorkspaceId) {
        rememberLastWorkspaceForServer(activeServer.id, activeWorkspaceId);
      }
      setActiveServer(serverId);
      setServerPickerOpen(false);
      const restoredWorkspaceId = getLastWorkspaceForServer(serverId);
      const directoryWorkspaces = directoryByServerId.get(serverId) ?? [];
      const targetWorkspaceId =
        restoredWorkspaceId &&
        directoryWorkspaces.some((workspace) => workspace.id === restoredWorkspaceId)
          ? restoredWorkspaceId
          : directoryWorkspaces[0]?.id;
      if (targetWorkspaceId) {
        void openWorkspaceById(targetWorkspaceId).catch(() => undefined);
      }
    },
    [
      activeServer.id,
      activeWorkspaceId,
      directoryByServerId,
      openWorkspaceById,
      setActiveServer,
    ]
  );

  useEffect(() => {
    if (!activeWorkspaceId) {
      return;
    }
    rememberLastWorkspaceForServer(activeServer.id, activeWorkspaceId);
  }, [activeServer.id, activeWorkspaceId]);

  const setWorkspaceSortMode = useCallback(
    (mode: WorkspaceSortMode) => {
      updateSettings((current) => {
        const seededCustomOrderIds =
          mode === "custom" && current.general.workspaceCustomOrderIds.length === 0
            ? visibleGroups.map((group) =>
                resolveGroupWorkspaceAppearanceKey(group, activeServer.id)
              )
            : current.general.workspaceCustomOrderIds;
        if (current.general.workspaceSortMode === mode) {
          if (seededCustomOrderIds === current.general.workspaceCustomOrderIds) {
            return current;
          }
        }
        return {
          ...current,
          general: {
            ...current.general,
            workspaceSortMode: mode,
            workspaceCustomOrderIds: seededCustomOrderIds,
          },
        };
      });
    },
    [activeServer.id, updateSettings, visibleGroups]
  );

  const resetWorkspaceCustomOrder = useCallback(() => {
    updateSettings((current) => {
      if (
        current.general.workspaceSortMode === "recent" &&
        current.general.workspaceCustomOrderIds.length === 0
      ) {
        return current;
      }
      return {
        ...current,
        general: {
          ...current.general,
          workspaceSortMode: "recent",
          workspaceCustomOrderIds: [],
        },
      };
    });
  }, [updateSettings]);

  const setAgentRailGroupBy = useCallback(
    (mode: AgentRailGroupByMode) => {
      updateSettings((current) => ({
        ...current,
        general: {
          ...current.general,
          agentRail: {
            ...current.general.agentRail,
            groupBy: mode,
          },
        },
      }));
    },
    [updateSettings]
  );

  const patchAgentRailSettings = useCallback(
    (patch: Partial<typeof agentRailSettings>) => {
      updateSettings((current) => ({
        ...current,
        general: {
          ...current.general,
          agentRail: {
            ...current.general.agentRail,
            ...patch,
          },
        },
      }));
    },
    [updateSettings]
  );

  const setMachineVisible = useCallback(
    (serverId: string, visible: boolean) => {
      updateSettings((current) => {
        const hidden = new Set(current.general.agentRail.hiddenServerIds);
        if (visible) {
          hidden.delete(serverId);
        } else {
          hidden.add(serverId);
        }
        return {
          ...current,
          general: {
            ...current.general,
            agentRail: {
              ...current.general.agentRail,
              hiddenServerIds: [...hidden],
            },
          },
        };
      });
    },
    [updateSettings]
  );

  const setRailSectionOrder = useCallback(
    (order: AgentRailSectionId[]) => {
      patchAgentRailSettings({ sectionOrder: order });
    },
    [patchAgentRailSettings]
  );

  const setRailSectionHidden = useCallback(
    (sectionId: AgentRailSectionId, hidden: boolean) => {
      if (sectionId === "workspaces") {
        return;
      }
      updateSettings((current) => {
        const hiddenSections = new Set(current.general.agentRail.hiddenSections ?? []);
        if (hidden) {
          hiddenSections.add(sectionId);
        } else {
          hiddenSections.delete(sectionId);
        }
        return {
          ...current,
          general: {
            ...current.general,
            agentRail: {
              ...current.general.agentRail,
              hiddenSections: Array.from(hiddenSections),
            },
          },
        };
      });
    },
    [updateSettings]
  );

  const reorderWorkspaceGroups = useCallback(
    (sourceWorkspaceId: string, targetWorkspaceId: string, placement: "before" | "after") => {
      const visibleWorkspaceIds = visibleGroups.map((group) =>
        resolveGroupWorkspaceAppearanceKey(group, activeServer.id)
      );
      const visibleWorkspaceIdSet = new Set(visibleWorkspaceIds);
      if (
        !visibleWorkspaceIdSet.has(sourceWorkspaceId) ||
        !visibleWorkspaceIdSet.has(targetWorkspaceId)
      ) {
        return;
      }

      updateSettings((current) => {
        const order = current.general.workspaceCustomOrderIds.filter((id) =>
          visibleWorkspaceIdSet.has(id)
        );
        for (const id of visibleWorkspaceIds) {
          if (!order.includes(id)) {
            order.push(id);
          }
        }

        const withoutSource = order.filter((id) => id !== sourceWorkspaceId);
        const targetIndex = withoutSource.indexOf(targetWorkspaceId);
        const insertIndex =
          targetIndex < 0
            ? withoutSource.length
            : targetIndex + (placement === "after" ? 1 : 0);
        withoutSource.splice(insertIndex, 0, sourceWorkspaceId);

        const hiddenCustomIds = current.general.workspaceCustomOrderIds.filter(
          (id) => !visibleWorkspaceIdSet.has(id)
        );
        const nextCustomOrderIds = [...withoutSource, ...hiddenCustomIds];

        return {
          ...current,
          general: {
            ...current.general,
            workspaceSortMode: "custom",
            workspaceCustomOrderIds: nextCustomOrderIds,
          },
        };
      });
    },
    [activeServer.id, updateSettings, visibleGroups]
  );

  const handleWorkspaceDragStart = useCallback(
    (event: ReactDragEvent<HTMLElement>, workspaceId: string) => {
      event.dataTransfer.effectAllowed = "move";
      event.dataTransfer.setData("text/plain", workspaceId);
      setDraggingWorkspaceId(workspaceId);
    },
    []
  );

  const handleWorkspaceDragOver = useCallback(
    (event: ReactDragEvent<HTMLElement>) => {
      if (!draggingWorkspaceId) {
        return;
      }
      event.preventDefault();
      event.dataTransfer.dropEffect = "move";
    },
    [draggingWorkspaceId]
  );

  const handleWorkspaceDrop = useCallback(
    (event: ReactDragEvent<HTMLElement>, targetWorkspaceId: string) => {
      event.preventDefault();
      const sourceWorkspaceId =
        event.dataTransfer.getData("text/plain") || draggingWorkspaceId;
      setDraggingWorkspaceId(null);
      if (!sourceWorkspaceId) {
        return;
      }
      const rect = event.currentTarget.getBoundingClientRect();
      const placement = event.clientY > rect.top + rect.height / 2 ? "after" : "before";
      reorderWorkspaceGroups(sourceWorkspaceId, targetWorkspaceId, placement);
    },
    [draggingWorkspaceId, reorderWorkspaceGroups]
  );

  const handleWorkspaceDragEnd = useCallback(() => {
    setDraggingWorkspaceId(null);
  }, []);

  const handleConversationDragStart = useCallback(
    (event: ReactDragEvent<HTMLDivElement>, conversation: AgentRailConversationSummary) => {
      setDraggingConversationId(conversation.id);
      event.dataTransfer.effectAllowed = "move";
      event.dataTransfer.setData(AGENT_RAIL_CONVERSATION_DRAG_TYPE, conversation.id);
      event.dataTransfer.setData("text/plain", conversation.id);
    },
    []
  );

  const handleConversationDragEnd = useCallback(() => {
    setDraggingConversationId(null);
  }, []);

  const railListScrollMeasureKey = useMemo(
    () =>
      `${visibleGroups.length}:${standaloneChatConversations.length}:${pinnedRailConversations.length}:${settings.general.chatFolders.length}:${railLoading ? 1 : 0}:${renameState?.conversationId ?? ""}:${collapsedFolderIds.size}:${editingWorkspaceKey ?? ""}:${railSectionOrder.join(",")}`,
    [
      visibleGroups.length,
      standaloneChatConversations.length,
      pinnedRailConversations.length,
      settings.general.chatFolders.length,
      railLoading,
      renameState?.conversationId,
      collapsedFolderIds.size,
      editingWorkspaceKey,
      railSectionOrder,
    ]
  );

  const handleNewChat = useCallback(() => {
    startNewConversation();
  }, [startNewConversation]);

  const handleNewOrchestrationWorktree = useCallback(async (
    workspaceId: string,
    workspaceName: string,
    baseBranch?: string | null,
    isGitRepo?: boolean
  ) => {
    if (isGitRepo === false) {
      window.alert("Orchestration Mode worktrees require a Git repository.");
      return;
    }
    const defaultBranch = `orchestration/${Date.now().toString(36)}`;
    const branch = window.prompt(
      `New orchestration branch name for ${workspaceName}`,
      defaultBranch
    );
    const trimmed = branch?.trim();
    if (!trimmed) {
      return;
    }
    try {
      const result = await createWorkspaceGitWorktree({
        workspaceId,
        branch: trimmed,
        baseBranch: baseBranch ?? undefined,
        newBranch: true,
        name: trimmed.split(/[\\/]/).filter(Boolean).at(-1) ?? trimmed,
      });
      await openWorkspaceById(result.workspace.id);
      const { snapshot, headConversation } = await startOrchestrationMode({
        title: `Orchestration: ${trimmed}`,
        prompt:
          `Start Orchestration Mode for branch ${trimmed}. ` +
          "Create or refine the kanban board, identify the work, assign child agents where useful, and keep going until the board is complete and verified.",
      });
      dispatchAgentConversationUpserted(headConversation);
      editorBridgeRef.current?.openOrchestrationBoardTab(
        snapshot.board.id,
        snapshot.board.title
      );
      await openConversationSummary({
        ...agentRecordToRailSummary(headConversation),
        serverId: activeServer.id,
        serverLabel: activeServer.label,
        workspaceKey: `${activeServer.id}:${headConversation.workspaceId}`,
        conversationKey: `${activeServer.id}:${headConversation.id}`,
      });
      void refreshConversationGroups();
    } catch (error) {
      window.alert(
        error instanceof Error
          ? `Failed to start Orchestration Mode: ${error.message}`
          : "Failed to start Orchestration Mode."
      );
    }
  }, [
    activeServer.id,
    activeServer.label,
    editorBridgeRef,
    openConversationSummary,
    openWorkspaceById,
    refreshConversationGroups,
  ]);

  const handleNewChatForWorkspace = useCallback(
    (workspaceId: string) => void startNewChatInWorkspace(workspaceId),
    [startNewChatInWorkspace]
  );

  const toggleWorkspaceCollapsed = useCallback((workspaceId: string) => {
    setCollapsedWorkspaceIds((prev) => {
      const next = new Set(prev);
      if (next.has(workspaceId)) {
        next.delete(workspaceId);
      } else {
        next.add(workspaceId);
      }
      writeCollapsedWorkspaceIdsToStorage(next);
      return next;
    });
  }, []);

  const toggleFolderCollapsed = useCallback((folderId: string) => {
    setCollapsedFolderIds((prev) => {
      const next = new Set(prev);
      if (next.has(folderId)) {
        next.delete(folderId);
      } else {
        next.add(folderId);
      }
      writeCollapsedFolderIdsToStorage(next);
      return next;
    });
  }, []);

  const createFolderForWorkspace = useCallback(
    (scopeId: string, options?: { conversationId?: string }) => {
      const folderId = createChatFolderId();
      const conversationId = options?.conversationId;
      updateSettings((current) => {
        const workspaceFolders = getChatFoldersForScope(current.general.chatFolders, scopeId);
        const nextFolder = createChatFolderState({
          id: folderId,
          scopeId,
          existingFolders: workspaceFolders,
          conversationId,
          color: FOLDER_COLOR_OPTIONS[workspaceFolders.length % FOLDER_COLOR_OPTIONS.length],
        });
        const folderedIds = new Set<string>();
        for (const folder of workspaceFolders) {
          for (const id of folder.conversationIds) {
            folderedIds.add(id);
          }
        }
        const scopeConversations = isStandaloneChatFolderScope(scopeId)
          ? standaloneChatConversations
          : groups.flatMap((group) =>
              group.workspace.id === scopeId ? group.conversations : []
            );
        const knownRootIds = scopeConversations
          .filter((conversation) => !folderedIds.has(conversation.id))
          .map((conversation) => conversation.id);
        const nextRootOrderByScope = conversationId
          ? updateRootOrderForMove(current.general.chatRootOrderByScope, {
              scopeId,
              conversationId,
              folderId: nextFolder.id,
              knownRootIds,
            })
          : current.general.chatRootOrderByScope;
        return {
          ...current,
          general: {
            ...current.general,
            chatFolders: upsertChatFoldersWithNewFolder(
              current.general.chatFolders,
              nextFolder,
              conversationId
            ),
            chatRootOrderByScope: nextRootOrderByScope,
          },
        };
      });
      setCollapsedFolderIds((prev) => {
        if (!prev.has(folderId)) {
          return prev;
        }
        const next = new Set(prev);
        next.delete(folderId);
        writeCollapsedFolderIdsToStorage(next);
        return next;
      });
      setEditingFolderId(folderId);
    },
    [groups, standaloneChatConversations, updateSettings]
  );

  const updateFolder = useCallback(
    (folderId: string, updater: (folder: ChatFolderState) => ChatFolderState) => {
      updateSettings((current) => ({
        ...current,
        general: {
          ...current.general,
          chatFolders: current.general.chatFolders.map((folder) =>
            folder.id === folderId ? updater(folder) : folder
          ),
        },
      }));
    },
    [updateSettings]
  );

  const updateWorkspaceAppearance = useCallback(
    (workspaceKey: string, patch: Partial<WorkspaceRailAppearance>) => {
      updateSettings((current) => {
        const previous = getWorkspaceRailAppearance(
          current.general.workspaceRailAppearances,
          workspaceKey,
          {
            isHome: Boolean(
              homeWorkspaceId &&
                groups.some(
                  (group) =>
                    resolveGroupWorkspaceAppearanceKey(group, activeServer.id) === workspaceKey &&
                    group.workspace.id === homeWorkspaceId
                )
            ),
          }
        );
        const nextIcon = typeof patch.icon === "string" && patch.icon.trim() ? patch.icon.trim() : previous.icon;
        const nextColor =
          typeof patch.color === "string" && isValidFolderColor(patch.color)
            ? patch.color
            : previous.color;
        return {
          ...current,
          general: {
            ...current.general,
            workspaceRailAppearances: {
              ...current.general.workspaceRailAppearances,
              [workspaceKey]: {
                icon: nextIcon,
                color: nextColor,
              },
            },
          },
        };
      });
    },
    [activeServer.id, groups, homeWorkspaceId, updateSettings]
  );

  const updateServerAppearance = useCallback(
    (serverId: string, patch: Partial<ServerRailAppearance>, fallbackIndex: number) => {
      updateSettings((current) => {
        const previous = getServerRailAppearance(
          current.general.serverRailAppearances,
          serverId,
          fallbackIndex
        );
        const nextIcon =
          typeof patch.icon === "string" && patch.icon.trim() ? patch.icon.trim() : previous.icon;
        const nextColor =
          typeof patch.color === "string" && isValidFolderColor(patch.color)
            ? patch.color
            : previous.color;
        const nextNickname =
          patch.nickname === undefined
            ? previous.nickname
            : patch.nickname.trim().slice(0, 80) || undefined;
        return {
          ...current,
          general: {
            ...current.general,
            serverRailAppearances: {
              ...current.general.serverRailAppearances,
              [serverId]: {
                icon: nextIcon,
                color: nextColor,
                ...(nextNickname ? { nickname: nextNickname } : {}),
              },
            },
          },
        };
      });
    },
    [updateSettings]
  );

  const renameFolder = useCallback(
    (folder: ChatFolderState) => {
      setEditingFolderId(folder.id);
    },
    []
  );

  const deleteFolder = useCallback(
    (folder: ChatFolderState) => {
      const rootLabel = isStandaloneChatFolderScope(folder.workspaceId)
        ? "Chats"
        : "this workspace root";
      const confirmed = window.confirm(
        `Delete "${folder.name}"? Chats move back to ${rootLabel}.`
      );
      if (!confirmed) {
        return;
      }
      updateSettings((current) => {
        const releasedIds = folder.conversationIds;
        const previousRoot = current.general.chatRootOrderByScope[folder.workspaceId] ?? [];
        const nextRoot = [...previousRoot];
        for (const id of releasedIds) {
          if (!nextRoot.includes(id)) {
            nextRoot.push(id);
          }
        }
        return {
          ...current,
          general: {
            ...current.general,
            chatFolders: current.general.chatFolders.filter((item) => item.id !== folder.id),
            chatRootOrderByScope:
              nextRoot.length > 0
                ? {
                    ...current.general.chatRootOrderByScope,
                    [folder.workspaceId]: nextRoot,
                  }
                : current.general.chatRootOrderByScope,
          },
        };
      });
      setEditingFolderId((current) => (current === folder.id ? null : current));
    },
    [updateSettings]
  );

  const moveConversationToFolder = useCallback(
    (
      conversationId: string,
      scopeId: string,
      folderId: string | null,
      options?: {
        targetConversationId?: string | null;
        placement?: ChatFolderPlacement;
      }
    ) => {
      updateSettings((current) => {
        const knownRootIds = collectScopeRootConversationIds(scopeId, {
          includeConversationId: folderId === null ? conversationId : undefined,
        });
        return {
          ...current,
          general: {
            ...current.general,
            chatFolders: moveConversationInChatFolders(current.general.chatFolders, {
              scopeId,
              conversationId,
              folderId,
              targetConversationId: options?.targetConversationId,
              placement: options?.placement,
            }),
            chatRootOrderByScope: updateRootOrderForMove(current.general.chatRootOrderByScope, {
              scopeId,
              conversationId,
              folderId,
              targetConversationId: options?.targetConversationId,
              placement: options?.placement,
              knownRootIds,
            }),
          },
        };
      });
    },
    [collectScopeRootConversationIds, updateSettings]
  );

  const handleConversationDrop = useCallback(
    (
      event: ReactDragEvent<HTMLElement>,
      scopeId: string,
      folderId: string | null,
      targetConversationId?: string | null
    ) => {
      if (draggingFolderId) {
        return;
      }
      const conversationId =
        event.dataTransfer.getData(AGENT_RAIL_CONVERSATION_DRAG_TYPE) || draggingConversationId;
      if (!conversationId) {
        return;
      }
      const source = findRailConversationById(conversationId);
      if (!source) {
        return;
      }
      const sourceScope = resolveConversationFolderScope(source);
      if (sourceScope !== scopeId) {
        return;
      }
      event.preventDefault();
      event.stopPropagation();
      setDraggingConversationId(null);
      let placement: ChatFolderPlacement = "after";
      if (targetConversationId) {
        const rect = event.currentTarget.getBoundingClientRect();
        placement = event.clientY > rect.top + rect.height / 2 ? "after" : "before";
      }
      moveConversationToFolder(conversationId, scopeId, folderId, {
        targetConversationId,
        placement,
      });
    },
    [
      draggingConversationId,
      draggingFolderId,
      findRailConversationById,
      moveConversationToFolder,
      resolveConversationFolderScope,
    ]
  );

  const handleFolderDragStart = useCallback(
    (event: ReactDragEvent<HTMLElement>, folder: ChatFolderState) => {
      event.dataTransfer.effectAllowed = "move";
      event.dataTransfer.setData(AGENT_RAIL_FOLDER_DRAG_TYPE, folder.id);
      event.dataTransfer.setData("text/plain", folder.id);
      setDraggingFolderId(folder.id);
    },
    []
  );

  const handleFolderDragEnd = useCallback(() => {
    setDraggingFolderId(null);
  }, []);

  const handleFolderDropTargetDragOver = useCallback(
    (event: ReactDragEvent<HTMLElement>) => {
      if (!draggingFolderId && !draggingConversationId) {
        return;
      }
      event.preventDefault();
      event.dataTransfer.dropEffect = "move";
    },
    [draggingConversationId, draggingFolderId]
  );

  const handleFolderReorderDrop = useCallback(
    (event: ReactDragEvent<HTMLElement>, scopeId: string, targetFolderId: string) => {
      const sourceFolderId =
        event.dataTransfer.getData(AGENT_RAIL_FOLDER_DRAG_TYPE) || draggingFolderId;
      if (!sourceFolderId) {
        if (draggingConversationId) {
          handleConversationDrop(event, scopeId, targetFolderId);
        }
        return;
      }
      event.preventDefault();
      event.stopPropagation();
      setDraggingFolderId(null);
      const rect = event.currentTarget.getBoundingClientRect();
      const placement: ChatFolderPlacement =
        event.clientY > rect.top + rect.height / 2 ? "after" : "before";
      updateSettings((current) => ({
        ...current,
        general: {
          ...current.general,
          chatFolders: reorderChatFolders(current.general.chatFolders, {
            scopeId,
            sourceFolderId,
            targetFolderId,
            placement,
          }),
        },
      }));
    },
    [draggingConversationId, draggingFolderId, handleConversationDrop, updateSettings]
  );

  const beginConversationRename = useCallback(
    (conversation: AgentRailConversationSummary) => {
      setRenameState({
        conversationId: conversation.id,
        draft: conversation.title,
        original: conversation.title,
      });
    },
    []
  );

  const updateConversationRenameDraft = useCallback((value: string) => {
    setRenameState((current) =>
      current
        ? {
            ...current,
            draft: value,
          }
        : current
    );
  }, []);

  const cancelConversationRename = useCallback(() => {
    setRenameState(null);
  }, []);

  const commitConversationRename = useCallback(() => {
    if (!renameState) {
      return;
    }
    const nextTitle = renameState.draft.trim();
    const originalTitle = renameState.original.trim();
    const conversationId = renameState.conversationId;
    setRenameState(null);
    if (!nextTitle || nextTitle === originalTitle) {
      return;
    }
    applyOptimisticRailTitle(conversationId, nextTitle);
    void renameConversation(conversationId, nextTitle).catch(() => {
      void refreshConversationGroups();
    });
  }, [
    applyOptimisticRailTitle,
    refreshConversationGroups,
    renameConversation,
    renameState,
  ]);

  const allConversationsForSearch = useMemo<RecentChatOption[]>(() => {
    const items: RecentChatOption[] = [];
    const seen = new Set<string>();
    for (const group of groups) {
      if (group.serverId && group.serverId !== activeServer.id) {
        continue;
      }
      for (const c of group.conversations) {
        if (seen.has(c.id)) continue;
        seen.add(c.id);
        items.push({
          id: c.id,
          title: c.title,
          updatedAt: c.updatedAt,
          detail: group.workspace.name,
          badge: c.status === "running" ? "running" : c.hasPendingPermission ? "needs attention" : undefined,
        });
      }
    }
    for (const c of pinnedRailConversations) {
      if (seen.has(c.id)) continue;
      seen.add(c.id);
      const detail =
        groups.find((g) => g.workspace.id === c.workspaceId)?.workspace.name ?? "Pinned";
      items.push({
        id: c.id,
        title: c.title,
        updatedAt: c.updatedAt,
        detail,
        badge: c.status === "running" ? "running" : c.hasPendingPermission ? "needs attention" : undefined,
      });
    }
    return items.sort((a, b) => b.updatedAt - a.updatedAt);
  }, [activeServer.id, groups, pinnedRailConversations]);

  const visibleConversationIds = useMemo(() => {
    const ids = new Set<string>();
    for (const group of groups) {
      for (const conversation of group.conversations) {
        ids.add(conversation.id);
      }
    }
    for (const conversation of pinnedRailConversations) {
      ids.add(conversation.id);
    }
    return ids;
  }, [groups, pinnedRailConversations]);

  useEffect(() => {
    if (!renameState || visibleConversationIds.has(renameState.conversationId)) {
      return;
    }
    setRenameState(null);
  }, [renameState, visibleConversationIds]);

  const handleSearchSelect = useCallback(
    (conversationId: string) => {
      const pinnedMatch = pinnedRailConversations.find((c) => c.id === conversationId);
      if (pinnedMatch) {
        void openConversationSummary(pinnedMatch);
        return;
      }
      for (const group of groups) {
        const match = group.conversations.find((c) => c.id === conversationId);
        if (match) {
          void openConversationSummary(match);
          return;
        }
      }
    },
    [groups, openConversationSummary, pinnedRailConversations]
  );

  const handleConversationSelect = useCallback(
    (conversation: AgentRailConversationSummary) => {
      void openConversationSummary(conversation);
      if (isMobile) {
        toggleLeftRailCollapsed();
      }
    },
    [isMobile, openConversationSummary, toggleLeftRailCollapsed]
  );

  const exitBulkSelect = useCallback(() => {
    setBulkSelectMode(false);
    setBulkSectionId(null);
    setBulkSelectedKeys(new Set());
    setBulkAnchorIndex(null);
    setBulkSectionPinned(false);
  }, []);

  useEffect(() => {
    if (!bulkSelectMode) {
      return;
    }
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape") {
        return;
      }
      event.preventDefault();
      exitBulkSelect();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [bulkSelectMode, exitBulkSelect]);

  const enterBulkSelect = useCallback(
    (
      conversation: AgentRailConversationSummary,
      section: {
        inPinnedSection?: boolean;
        workspaceId: string;
        folderId?: string | null;
        orderedConversations: AgentRailConversationSummary[];
      }
    ) => {
      const sectionId = buildRailBulkSectionId({
        inPinnedSection: section.inPinnedSection,
        workspaceId: section.workspaceId,
        folderId: section.folderId,
      });
      const orderedKeys = orderedRailConversationKeys(section.orderedConversations);
      const targetKey = getRailConversationKey(conversation);
      const targetIndex = orderedKeys.indexOf(targetKey);
      setBulkSelectMode(true);
      setBulkSectionId(sectionId);
      setBulkSectionPinned(Boolean(section.inPinnedSection));
      setBulkSelectedKeys(new Set([targetKey]));
      setBulkAnchorIndex(targetIndex >= 0 ? targetIndex : 0);
    },
    []
  );

  const handleBulkRowClick = useCallback(
    (
      event: ReactMouseEvent<HTMLButtonElement>,
      conversation: AgentRailConversationSummary,
      section: {
        inPinnedSection?: boolean;
        workspaceId: string;
        folderId?: string | null;
        orderedConversations: AgentRailConversationSummary[];
      }
    ) => {
      event.preventDefault();
      const sectionId = buildRailBulkSectionId({
        inPinnedSection: section.inPinnedSection,
        workspaceId: section.workspaceId,
        folderId: section.folderId,
      });
      const orderedKeys = orderedRailConversationKeys(section.orderedConversations);
      const targetKey = getRailConversationKey(conversation);
      const targetIndex = orderedKeys.indexOf(targetKey);
      if (targetIndex < 0) {
        return;
      }

      const modifier = railBulkClickModifierInBulkMode(event);
      if (sectionId !== bulkSectionId) {
        setBulkSectionId(sectionId);
        setBulkSectionPinned(Boolean(section.inPinnedSection));
        setBulkSelectedKeys(new Set([targetKey]));
        setBulkAnchorIndex(targetIndex);
        return;
      }

      const { selectedKeys, anchorIndex } = applyRailBulkClick({
        orderedKeys,
        selectedKeys: bulkSelectedKeys,
        anchorIndex: bulkAnchorIndex,
        targetIndex,
        modifier,
      });
      setBulkSelectedKeys(selectedKeys);
      setBulkAnchorIndex(anchorIndex);
    },
    [bulkAnchorIndex, bulkSectionId, bulkSelectedKeys]
  );

  const toggleBulkSelectConversation = useCallback(
    (
      conversation: AgentRailConversationSummary,
      section: {
        inPinnedSection?: boolean;
        workspaceId: string;
        folderId?: string | null;
        orderedConversations: AgentRailConversationSummary[];
      }
    ) => {
      const sectionId = buildRailBulkSectionId({
        inPinnedSection: section.inPinnedSection,
        workspaceId: section.workspaceId,
        folderId: section.folderId,
      });
      const orderedKeys = orderedRailConversationKeys(section.orderedConversations);
      const targetKey = getRailConversationKey(conversation);
      const targetIndex = orderedKeys.indexOf(targetKey);
      if (targetIndex < 0) {
        return;
      }

      if (!bulkSelectMode) {
        enterBulkSelect(conversation, section);
        return;
      }

      if (sectionId !== bulkSectionId) {
        setBulkSectionId(sectionId);
        setBulkSectionPinned(Boolean(section.inPinnedSection));
        setBulkSelectedKeys(new Set([targetKey]));
        setBulkAnchorIndex(targetIndex);
        return;
      }

      const { selectedKeys, anchorIndex } = applyRailBulkClick({
        orderedKeys,
        selectedKeys: bulkSelectedKeys,
        anchorIndex: bulkAnchorIndex,
        targetIndex,
        modifier: "toggle",
      });
      setBulkSelectedKeys(selectedKeys);
      setBulkAnchorIndex(anchorIndex);
    },
    [bulkAnchorIndex, bulkSectionId, bulkSelectMode, bulkSelectedKeys, enterBulkSelect]
  );

  const railConversationByKey = useMemo(() => {
    const map = new Map<string, AgentRailConversationSummary>();
    for (const conversation of pinnedRailConversations) {
      map.set(getRailConversationKey(conversation), conversation);
    }
    for (const group of groups) {
      for (const conversation of group.conversations) {
        map.set(getRailConversationKey(conversation), conversation);
      }
    }
    return map;
  }, [groups, pinnedRailConversations]);

  const bulkSelectedConversations = useMemo(
    () =>
      [...bulkSelectedKeys]
        .map((key) => railConversationByKey.get(key))
        .filter((conversation): conversation is AgentRailConversationSummary =>
          Boolean(conversation)
        ),
    [bulkSelectedKeys, railConversationByKey]
  );

  const handleBulkArchive = useCallback(() => {
    for (const conversation of bulkSelectedConversations) {
      archiveConversation(conversation.id);
    }
    exitBulkSelect();
  }, [archiveConversation, bulkSelectedConversations, exitBulkSelect]);

  const handleBulkPin = useCallback(() => {
    for (const conversation of bulkSelectedConversations) {
      pinConversation(conversation.id);
    }
    exitBulkSelect();
  }, [bulkSelectedConversations, exitBulkSelect, pinConversation]);

  const handleBulkUnpin = useCallback(() => {
    for (const conversation of bulkSelectedConversations) {
      unpinConversation(conversation.id);
    }
    exitBulkSelect();
  }, [bulkSelectedConversations, exitBulkSelect, unpinConversation]);

  type RailConversationRowSection = {
    inPinnedSection?: boolean;
    workspaceId: string;
    folderId?: string | null;
    orderedConversations: AgentRailConversationSummary[];
  };

  const isConversationChatSelected = useCallback(
    (conversation: AgentRailConversationSummary) =>
      !bulkSelectMode &&
      conversation.id === selectedConversationId &&
      conversation.workspaceId === activeWorkspaceId &&
      (!conversation.serverId || conversation.serverId === activeServer.id),
    [activeServer.id, activeWorkspaceId, bulkSelectMode, selectedConversationId]
  );

  const handleOpenConversationInEditor = useCallback(
    (conversation: AgentRailConversationSummary, group?: "left" | "right") => {
      setPendingEditorOpen({ conversation, group });
      void openConversationSummary(conversation).catch(() => {
        setPendingEditorOpen((current) =>
          current?.conversation.id === conversation.id &&
          current.group === group
            ? null
            : current
        );
      });
    },
    [openConversationSummary]
  );

  useEffect(() => {
    if (!pendingEditorOpen) {
      return;
    }
    if (activeWorkspaceId !== pendingEditorOpen.conversation.workspaceId) {
      return;
    }
    if (selectedConversationId !== pendingEditorOpen.conversation.id) {
      return;
    }
	openAgentConversation({
      conversationId: pendingEditorOpen.conversation.id,
      title: pendingEditorOpen.conversation.title,
      ...(pendingEditorOpen.group ? { group: pendingEditorOpen.group } : {}),
    });
    setPendingEditorOpen(null);
    if (isMobile) {
      toggleLeftRailCollapsed();
    }
  }, [
  activeWorkspaceId,
  isMobile,
  openAgentConversation,
  pendingEditorOpen,
  selectedConversationId,
  toggleLeftRailCollapsed,
]);

  const buildConversationMenuItems = useCallback(
    (
      conversation: AgentRailConversationSummary,
      options?: {
        inPinnedSection?: boolean;
        folderId?: string | null;
        orderedConversations?: AgentRailConversationSummary[];
      }
    ): WorkbenchMenuItem[] => {
      const inPinned = options?.inPinnedSection ?? false;
      const orderedConversations = options?.orderedConversations ?? [conversation];
      const conversationId = conversation.id;
      const folderScopeId = resolveConversationFolderScope(conversation);
      const workspaceFolders = getChatFoldersForScope(
        settings.general.chatFolders,
        folderScopeId
      );
      const currentFolder = workspaceFolders.find((folder) =>
        folder.conversationIds.includes(conversationId)
      );
      const rootLabel = isStandaloneChatFolderScope(folderScopeId)
        ? "Move to Chats Root"
        : "Move to Workspace Root";
      const moveItems: WorkbenchMenuItem[] = [
        { type: "sep" },
        {
          type: "item",
          id: "move-new-folder",
          label: "Move to New Folder...",
          onSelect: () =>
            createFolderForWorkspace(folderScopeId, {
              conversationId,
            }),
        },
        ...(workspaceFolders.length > 0
          ? [
              {
                type: "item" as const,
                id: "move-root",
                label: rootLabel,
                disabled: !currentFolder,
                onSelect: () => moveConversationToFolder(conversationId, folderScopeId, null),
              },
              ...workspaceFolders.map(
                (folder): WorkbenchMenuItem => ({
                  type: "item",
                  id: `move-folder-${folder.id}`,
                  label: `Move to ${folder.name}`,
                  disabled: currentFolder?.id === folder.id,
                  onSelect: () =>
                    moveConversationToFolder(conversationId, folderScopeId, folder.id),
                })
              ),
            ]
          : []),
      ];
      return [
        {
          type: "item",
          id: "rename",
          label: "Rename",
          onSelect: () => beginConversationRename(conversation),
        },
        {
          type: "item",
          id: "open-editor",
          label: "Open in Editor",
          onSelect: () => handleOpenConversationInEditor(conversation),
        },
        {
          type: "item",
          id: "open-editor-side",
          label: "Open in Side-by-Side Editor",
          onSelect: () => handleOpenConversationInEditor(conversation, "right"),
        },
        { type: "sep" },
        inPinned
          ? {
              type: "item",
              id: "unpin",
              label: "Unpin",
              onSelect: () => unpinConversation(conversationId),
            }
          : {
              type: "item",
              id: "pin",
              label: "Pin",
              onSelect: () => pinConversation(conversationId),
            },
        ...moveItems,
        { type: "sep" },
        {
          type: "item",
          id: "bulk-select",
          label: bulkSelectMode
            ? bulkSelectedKeys.has(getRailConversationKey(conversation))
              ? "Remove from selection"
              : "Add to selection"
            : "Bulk select",
          onSelect: () =>
            toggleBulkSelectConversation(conversation, {
              inPinnedSection: inPinned,
              workspaceId: conversation.workspaceId,
              folderId: options?.folderId ?? null,
              orderedConversations,
            }),
        },
        {
          type: "item",
          id: "archive",
          label: "Archive",
          onSelect: () => archiveConversation(conversationId),
        },
        {
          type: "item",
          id: "fork",
          label: "Fork",
          disabled: conversation.status === "running" || conversation.status === "awaiting_permission",
          onSelect: () => {
            void forkConversation(conversationId).catch(() => undefined);
          },
        },
      ];
    },
    [
      archiveConversation,
      beginConversationRename,
      bulkSelectMode,
      bulkSelectedKeys,
      createFolderForWorkspace,
      toggleBulkSelectConversation,
      forkConversation,
      handleOpenConversationInEditor,
      moveConversationToFolder,
      pinConversation,
      resolveConversationFolderScope,
      settings.general.chatFolders,
      unpinConversation,
    ]
  );

  const handleConversationContextMenu = useCallback(
    (
      e: ReactMouseEvent,
      conversation: AgentRailConversationSummary,
      options?: {
        inPinnedSection?: boolean;
        folderId?: string | null;
        orderedConversations?: AgentRailConversationSummary[];
      }
    ) => {
      openAt(e, buildConversationMenuItems(conversation, options));
    },
    [buildConversationMenuItems, openAt]
  );

  const handleConversationOverflowMenu = useCallback(
    (
      conversation: AgentRailConversationSummary,
      anchorEl: HTMLElement,
      options?: {
        inPinnedSection?: boolean;
        folderId?: string | null;
        orderedConversations?: AgentRailConversationSummary[];
      }
    ) => {
      const rect = anchorEl.getBoundingClientRect();
      openAtPoint(
        rect.right - 8,
        rect.bottom + 4,
        buildConversationMenuItems(conversation, options)
      );
    },
    [buildConversationMenuItems, openAtPoint]
  );

  const buildFolderMenuItems = useCallback(
    (folder: ChatFolderState): WorkbenchMenuItem[] => [
      {
        type: "item",
        id: "customize-folder",
        label: "Customize Folder...",
        onSelect: () => renameFolder(folder),
      },
      { type: "sep" },
      {
        type: "item",
        id: "delete-folder",
        label: "Delete Folder",
        onSelect: () => deleteFolder(folder),
      },
    ],
    [deleteFolder, renameFolder]
  );

  const handleFolderContextMenu = useCallback(
    (event: ReactMouseEvent, folder: ChatFolderState) => {
      openAt(event, buildFolderMenuItems(folder));
    },
    [buildFolderMenuItems, openAt]
  );

  const pinnedSection: ReactNode = useMemo(() => {
    if (pinnedRailConversations.length === 0) {
      return null;
    }
    const isPinnedHeaderCollapsed = collapsedWorkspaceIds.has(PINNED_SECTION_WORKSPACE_ID);
    return (
      <section className="pb-[12px]">
        <div className="group flex items-center gap-[2px] px-px pb-[4px]">
          <button
            type="button"
            onClick={() => toggleWorkspaceCollapsed(PINNED_SECTION_WORKSPACE_ID)}
            className="group/wshead flex min-w-0 flex-1 items-center gap-[4px] rounded-[var(--radius-tab)] py-[2px] text-left"
          >
            <span className="relative grid size-[10px] shrink-0 place-items-center">
              <Pin
                className="col-start-1 row-start-1 size-[10px] text-[var(--text-disabled)] group-hover/wshead:opacity-0"
                strokeWidth={2}
              />
              <ChevronRight
                className={`col-start-1 row-start-1 size-[10px] text-[var(--text-disabled)] opacity-0 group-hover/wshead:opacity-100 group-hover/wshead:text-[var(--text-secondary)] ${
                  isPinnedHeaderCollapsed ? "" : "rotate-90"
                }`}
                strokeWidth={2}
              />
            </span>
            <span className="truncate font-sans text-[10.5px] font-medium text-[var(--text-disabled)] group-hover/wshead:text-[var(--text-primary)]">
              Pinned
            </span>
          </button>
        </div>
        {!isPinnedHeaderCollapsed ? (
          <div className="flex flex-col gap-[2px]">
            {pinnedRailConversations.map((conversation, index) => {
              const pinnedSection: RailConversationRowSection = {
                inPinnedSection: true,
                workspaceId: conversation.workspaceId,
                orderedConversations: pinnedRailConversations,
              };
              const railKey = getRailConversationKey(conversation);
              return (
                <AgentConversationRow
                  key={conversation.conversationKey ?? conversation.id}
                  conversation={conversation}
                  rowIndex={index}
                  selected={isConversationChatSelected(conversation)}
                  bulkSelectMode={bulkSelectMode}
                  bulkSelected={bulkSelectMode && bulkSelectedKeys.has(railKey)}
                  editing={renameState?.conversationId === conversation.id}
                  editValue={renameState?.draft}
                  onBeginRename={() => beginConversationRename(conversation)}
                  onEditValueChange={updateConversationRenameDraft}
                  onCommitRename={commitConversationRename}
                  onCancelRename={cancelConversationRename}
                  onSelect={(event) => {
                    if (bulkSelectMode) {
                      handleBulkRowClick(event, conversation, pinnedSection);
                      return;
                    }
                    handleConversationSelect(conversation);
                  }}
                  onContextMenu={(e, currentConversation) =>
                    handleConversationContextMenu(e, currentConversation, {
                      inPinnedSection: true,
                      orderedConversations: pinnedRailConversations,
                    })
                  }
                  showOverflowMenu={experimentalIpadCustomButtons}
                  onOverflowMenu={(anchor) =>
                    handleConversationOverflowMenu(conversation, anchor, {
                      inPinnedSection: true,
                      orderedConversations: pinnedRailConversations,
                    })
                  }
                />
              );
            })}
          </div>
        ) : null}
      </section>
    );
  }, [
    beginConversationRename,
    cancelConversationRename,
    collapsedWorkspaceIds,
    commitConversationRename,
    experimentalIpadCustomButtons,
    handleConversationOverflowMenu,
    bulkSelectMode,
    bulkSelectedKeys,
    handleBulkRowClick,
    handleConversationSelect,
    handleConversationContextMenu,
    isConversationChatSelected,
    pinnedRailConversations,
    renameState?.conversationId,
    renameState?.draft,
    toggleWorkspaceCollapsed,
    updateConversationRenameDraft,
  ]);

  const chatsSection: ReactNode = useMemo(() => {
    const isChatsHeaderCollapsed = collapsedWorkspaceIds.has(CHATS_SECTION_WORKSPACE_ID);
    const chatsFolders = getChatFoldersForScope(
      settings.general.chatFolders,
      STANDALONE_CHATS_FOLDER_SCOPE
    );
    const { folderConversations, rootConversations } = partitionConversationsByFolders(
      standaloneChatConversations,
      chatsFolders,
      settings.general.chatRootOrderByScope[STANDALONE_CHATS_FOLDER_SCOPE]
    );
    const renderConversationRow = (
      conversation: AgentRailConversationSummary,
      index: number,
      folderId: string | null,
      orderedConversations: AgentRailConversationSummary[]
    ) => {
      const chatsRowSection: RailConversationRowSection = {
        inPinnedSection: false,
        workspaceId: conversation.workspaceId,
        folderId,
        orderedConversations,
      };
      const railKey = getRailConversationKey(conversation);
      return (
        <AgentConversationRow
          key={conversation.conversationKey ?? conversation.id}
          conversation={conversation}
          rowIndex={index}
          selected={isConversationChatSelected(conversation)}
          bulkSelectMode={bulkSelectMode}
          bulkSelected={bulkSelectMode && bulkSelectedKeys.has(railKey)}
          editing={renameState?.conversationId === conversation.id}
          editValue={renameState?.draft}
          onBeginRename={() => beginConversationRename(conversation)}
          onEditValueChange={updateConversationRenameDraft}
          onCommitRename={commitConversationRename}
          onCancelRename={cancelConversationRename}
          onSelect={(event) => {
            if (bulkSelectMode) {
              handleBulkRowClick(event, conversation, chatsRowSection);
              return;
            }
            handleConversationSelect(conversation);
          }}
          onDragStart={bulkSelectMode ? undefined : handleConversationDragStart}
          onDragEnd={bulkSelectMode ? undefined : handleConversationDragEnd}
          onDragOver={
            bulkSelectMode
              ? undefined
              : (event) => handleFolderDropTargetDragOver(event)
          }
          onDrop={
            bulkSelectMode
              ? undefined
              : (event) =>
                  handleConversationDrop(
                    event,
                    STANDALONE_CHATS_FOLDER_SCOPE,
                    folderId,
                    conversation.id
                  )
          }
          onContextMenu={(e, currentConversation) =>
            handleConversationContextMenu(e, currentConversation, {
              inPinnedSection: false,
              folderId,
              orderedConversations,
            })
          }
          showOverflowMenu={experimentalIpadCustomButtons}
          onOverflowMenu={(anchor) =>
            handleConversationOverflowMenu(conversation, anchor, {
              inPinnedSection: false,
              folderId,
              orderedConversations,
            })
          }
        />
      );
    };
    return (
      <section className="pb-[12px]">
        <div className="group flex items-center gap-[2px] px-px pb-[4px]">
          <button
            type="button"
            onClick={() => toggleWorkspaceCollapsed(CHATS_SECTION_WORKSPACE_ID)}
            className="group/wshead flex min-w-0 flex-1 items-center gap-[4px] rounded-[var(--radius-tab)] py-[2px] text-left"
          >
            <span className="relative grid size-[10px] shrink-0 place-items-center">
              <MessageSquare
                className="col-start-1 row-start-1 size-[10px] text-[var(--text-disabled)] group-hover/wshead:opacity-0"
                strokeWidth={2}
              />
              <ChevronRight
                className={`col-start-1 row-start-1 size-[10px] text-[var(--text-disabled)] opacity-0 group-hover/wshead:opacity-100 group-hover/wshead:text-[var(--text-secondary)] ${
                  isChatsHeaderCollapsed ? "" : "rotate-90"
                }`}
                strokeWidth={2}
              />
            </span>
            <span className="truncate font-sans text-[10.5px] font-medium text-[var(--text-disabled)] group-hover/wshead:text-[var(--text-primary)]">
              Chats
            </span>
          </button>
          <button
            type="button"
            onClick={() => createFolderForWorkspace(STANDALONE_CHATS_FOLDER_SCOPE)}
            className="flex size-[var(--d2-rail-control-size)] shrink-0 items-center justify-center rounded-[var(--agent-control-radius)] text-[var(--text-disabled)] opacity-0 transition-colors group-hover:opacity-100 hover:bg-[var(--agent-card-bg)] hover:text-[var(--text-primary)]"
            aria-label="New chats folder"
            title="New folder"
          >
            <FolderPlus className="size-[12px]" strokeWidth={1.5} />
          </button>
          <button
            type="button"
            onClick={handleNewStandaloneChat}
            className="flex size-[var(--d2-rail-control-size)] shrink-0 items-center justify-center rounded-[var(--agent-control-radius)] text-[var(--text-disabled)] opacity-0 transition-colors group-hover:opacity-100 hover:bg-[var(--agent-card-bg)] hover:text-[var(--text-primary)]"
            aria-label="Start new chat without workspace"
            title="New chat (no workspace)"
          >
            <Plus className="size-[12px]" strokeWidth={1.5} />
          </button>
        </div>
        {!isChatsHeaderCollapsed ? (
          <div
            className="flex flex-col gap-[2px]"
            onDragOver={handleFolderDropTargetDragOver}
            onDrop={(event) =>
              handleConversationDrop(event, STANDALONE_CHATS_FOLDER_SCOPE, null)
            }
          >
            {standaloneChatConversations.length === 0 && chatsFolders.length === 0 ? (
              <button
                type="button"
                onClick={handleNewStandaloneChat}
                className="rounded-[var(--radius-tab)] px-[8px] py-[6px] text-left font-sans text-[12px] text-[var(--text-disabled)] transition-colors hover:bg-[var(--accent-bg)] hover:text-[var(--text-secondary)]"
              >
                New chat without a workspace
              </button>
            ) : (
              <>
                {chatsFolders.map((folder) => {
                  const isFolderCollapsed = collapsedFolderIds.has(folder.id);
                  const Icon = getFolderIcon(folder.icon);
                  const conversationsInFolder = folderConversations.get(folder.id) ?? [];
                  return (
                    <div
                      key={folder.id}
                      className={`rounded-[var(--agent-control-radius)] ${
                        draggingConversationId || draggingFolderId === folder.id
                          ? "bg-[var(--bg-card)]"
                          : ""
                      } ${draggingFolderId === folder.id ? "opacity-60" : ""}`}
                      onDragOver={handleFolderDropTargetDragOver}
                      onDrop={(event) =>
                        handleFolderReorderDrop(event, STANDALONE_CHATS_FOLDER_SCOPE, folder.id)
                      }
                    >
                      <div
                        draggable
                        onDragStart={(event) => handleFolderDragStart(event, folder)}
                        onDragEnd={handleFolderDragEnd}
                        className="group/folder flex h-[24px] w-full min-w-0 items-center rounded-[var(--agent-control-radius)] text-[var(--text-secondary)] hover:bg-[var(--agent-card-bg)] hover:text-[var(--text-primary)]"
                        onContextMenu={(event) => handleFolderContextMenu(event, folder)}
                      >
                        <button
                          type="button"
                          onClick={() => toggleFolderCollapsed(folder.id)}
                          className="flex h-full min-w-0 flex-1 items-center gap-[6px] px-[9px] text-left"
                          title={`${folder.name} (${conversationsInFolder.length})`}
                        >
                          <ChevronRight
                            className={`size-[10px] shrink-0 text-[var(--text-disabled)] transition-transform ${
                              isFolderCollapsed ? "" : "rotate-90"
                            }`}
                            strokeWidth={2}
                          />
                          <Icon
                            className="size-[13px] shrink-0"
                            color={folder.color}
                            strokeWidth={1.8}
                          />
                          <span className="min-w-0 flex-1 truncate font-sans text-[12.5px]">
                            {folder.name}
                          </span>
                          <span className="shrink-0 font-sans text-[10px] text-[var(--text-disabled)]">
                            {conversationsInFolder.length}
                          </span>
                        </button>
                        <button
                          type="button"
                          onClick={(event) => {
                            event.preventDefault();
                            event.stopPropagation();
                            setEditingFolderId((current) =>
                              current === folder.id ? null : folder.id
                            );
                          }}
                          className="mr-[3px] flex size-[var(--d2-rail-control-size)] shrink-0 items-center justify-center rounded-[var(--agent-control-radius)] text-[var(--text-disabled)] opacity-0 hover:bg-[var(--bg-card)] hover:text-[var(--text-primary)] group-hover/folder:opacity-100 focus-visible:opacity-100"
                          title={`Customize ${folder.name}`}
                          aria-label={`Customize ${folder.name}`}
                        >
                          <Settings className="size-[12px]" strokeWidth={1.7} />
                        </button>
                      </div>
                      {editingFolderId === folder.id ? (
                        <RailIconCustomizePanel
                          title={folder.name}
                          icon={folder.icon}
                          color={folder.color}
                          showNameField
                          name={folder.name}
                          onClose={() => setEditingFolderId(null)}
                          onUpdate={(patch) =>
                            updateFolder(folder.id, (current) => ({
                              ...current,
                              ...patch,
                              name:
                                typeof patch.name === "string"
                                  ? patch.name.trim().slice(0, 80) || "Folder"
                                  : current.name,
                              color:
                                typeof patch.color === "string" &&
                                isValidFolderColor(patch.color)
                                  ? patch.color
                                  : current.color,
                            }))
                          }
                        />
                      ) : null}
                      {!isFolderCollapsed ? (
                        <div
                          className="ml-[13px] mt-[2px] flex flex-col gap-[2px] border-l border-[var(--border-subtle)] pl-[5px]"
                          onDragOver={handleFolderDropTargetDragOver}
                          onDrop={(event) =>
                            handleConversationDrop(
                              event,
                              STANDALONE_CHATS_FOLDER_SCOPE,
                              folder.id
                            )
                          }
                        >
                          {conversationsInFolder.length === 0 ? (
                            <div className="px-[9px] py-[5px] font-sans text-[12px] text-[var(--text-disabled)]">
                              Empty folder
                            </div>
                          ) : (
                            conversationsInFolder.map((conversation, index) =>
                              renderConversationRow(
                                conversation,
                                index,
                                folder.id,
                                conversationsInFolder
                              )
                            )
                          )}
                        </div>
                      ) : null}
                    </div>
                  );
                })}
                {rootConversations.map((conversation, index) =>
                  renderConversationRow(conversation, index, null, rootConversations)
                )}
              </>
            )}
          </div>
        ) : null}
      </section>
    );
  }, [
    beginConversationRename,
    bulkSelectMode,
    bulkSelectedKeys,
    cancelConversationRename,
    collapsedFolderIds,
    collapsedWorkspaceIds,
    commitConversationRename,
    createFolderForWorkspace,
    draggingConversationId,
    draggingFolderId,
    editingFolderId,
    experimentalIpadCustomButtons,
    handleBulkRowClick,
    handleConversationContextMenu,
    handleConversationDragEnd,
    handleConversationDragStart,
    handleConversationDrop,
    handleConversationOverflowMenu,
    handleConversationSelect,
    handleFolderContextMenu,
    handleFolderDragEnd,
    handleFolderDragStart,
    handleFolderDropTargetDragOver,
    handleFolderReorderDrop,
    handleNewStandaloneChat,
    isConversationChatSelected,
    renameState?.conversationId,
    renameState?.draft,
    settings.general.chatFolders,
    settings.general.chatRootOrderByScope,
    standaloneChatConversations,
    toggleFolderCollapsed,
    toggleWorkspaceCollapsed,
    updateConversationRenameDraft,
    updateFolder,
  ]);

  const workspaceGroupsSection: ReactNode = (
      <>
        {visibleGroups.map((group) => {
                const groupKey = resolveGroupWorkspaceAppearanceKey(group, activeServer.id);
                const isHomeWorkspace = Boolean(
                  homeWorkspaceId &&
                  group.workspace.id === homeWorkspaceId &&
                  (!group.serverId || group.serverId === activeServer.id)
                );
                const workspaceAppearance = getWorkspaceRailAppearance(
                  workspaceRailAppearances,
                  groupKey,
                  { isHome: isHomeWorkspace }
                );
                const workspaceActionsEnabled =
                  agentRailSettings.groupBy === "workspace" &&
                  !group.serverAuthRequired &&
                  (!group.serverId || group.serverId === activeServer.id);
                const groupMachineIds = new Set(
                  [
                    ...(group.serverIds ?? []),
                    ...group.conversations.map((conversation) => conversation.serverId),
                  ].filter((serverId): serverId is string => Boolean(serverId))
                );
                if (group.serverId) {
                  groupMachineIds.add(group.serverId);
                }
                const showConversationMachine = groupMachineIds.size > 1;
                const groupMachineLabel =
                  groupMachineIds.size > 1
                    ? `${groupMachineIds.size} machines`
                    : group.serverId && machineOptions.length > 1
                      ? machineOptions.find((machine) => machine.id === group.serverId)?.label
                      : null;
                const isWorkspaceCollapsed = collapsedWorkspaceIds.has(groupKey);
                const workspaceFolders = getChatFoldersForScope(
                  settings.general.chatFolders,
                  group.workspace.id
                );
                const {
                  folderConversations,
                  rootConversations,
                } = partitionConversationsByFolders(
                  group.conversations,
                  workspaceFolders,
                  settings.general.chatRootOrderByScope[group.workspace.id]
                );
                const branchLabel = workspaceBranchLabel(group.workspace.id, group.workspace.root);
                const workspaceIsGitRepo =
                  group.workspace.id === activeWorkspaceId
                    ? gitStatus?.isGitRepo
                    : group.repository?.isGitRepo;
                const workspaceCurrentBranch =
                  group.workspace.id === activeWorkspaceId
                    ? gitStatus?.currentBranch
                    : group.repository?.currentBranch;
                return (
                <section
                  key={groupKey}
                  onDragOver={handleWorkspaceDragOver}
                  onDrop={(event) => handleWorkspaceDrop(event, groupKey)}
                  className={`pb-[12px] ${
                    draggingWorkspaceId === groupKey ? "opacity-60" : ""
                  }`}
                >
                  <div
                    draggable
                    onDragStart={(event) => handleWorkspaceDragStart(event, groupKey)}
                    onDragEnd={handleWorkspaceDragEnd}
                    className="group flex items-center gap-[2px] px-px pb-[4px]"
                  >
                    <button
                      type="button"
                      onClick={() => toggleWorkspaceCollapsed(groupKey)}
                      className="group/wshead flex min-w-0 flex-1 items-center gap-[4px] rounded-[var(--radius-tab)] py-[2px] text-left"
                    >
                      <WorkspaceRailHeaderIcon
                        appearance={workspaceAppearance}
                        collapsed={isWorkspaceCollapsed}
                        onCustomize={() => {
                          setEditingWorkspaceKey((current) =>
                            current === groupKey ? null : groupKey
                          );
                        }}
                      />
                      <span className="truncate font-sans text-[10.5px] font-medium text-[var(--text-disabled)] group-hover/wshead:text-[var(--text-primary)]">
                        {group.workspace.name}
                      </span>
                      {groupMachineLabel && agentRailSettings.groupBy !== "server" ? (
                        <span className="max-w-[86px] shrink truncate rounded-[var(--radius-tab)] bg-[var(--bg-card)] px-[5px] py-px font-sans text-[9px] text-[var(--text-disabled)]">
                          {groupMachineLabel}
                        </span>
                      ) : null}
                      {branchLabel ? (
                        <span className="max-w-[120px] shrink truncate rounded-[var(--radius-tab)] border border-[var(--border-subtle)] px-[5px] py-[1px] font-mono text-[9.5px] text-[var(--text-disabled)]">
                          {branchLabel}
                        </span>
                      ) : null}
                    </button>
                    {workspaceActionsEnabled ? (
                      <>
                        <button
                          type="button"
                          onClick={() =>
                            void handleNewOrchestrationWorktree(
                              group.workspace.id,
                              group.workspace.name,
                              workspaceCurrentBranch,
                              workspaceIsGitRepo
                            )
                          }
                          className="flex size-[16px] shrink-0 items-center justify-center rounded-[var(--radius-tab)] text-[var(--text-disabled)] opacity-0 group-hover:opacity-100 hover:bg-[var(--bg-card)] hover:text-[var(--text-primary)]"
                          aria-label={`Start Orchestration Mode in a new worktree for ${group.workspace.name}`}
                          title={`Start Orchestration Mode in a new worktree for ${group.workspace.name}`}
                        >
                          <GitBranchPlus className="size-[12px]" strokeWidth={2} />
                        </button>
                        <button
                          type="button"
                          onClick={() => void handleNewChatForWorkspace(group.workspace.id)}
                          className="flex size-[16px] shrink-0 items-center justify-center rounded-[var(--radius-tab)] text-[var(--text-disabled)] opacity-0 group-hover:opacity-100 hover:bg-[var(--bg-card)] hover:text-[var(--text-primary)]"
                          aria-label={`New chat in ${group.workspace.name}`}
                          title={`New chat in ${group.workspace.name}`}
                        >
                          <Plus className="size-[12px]" strokeWidth={2} />
                        </button>
                      </>
                    ) : null}
                  </div>
                  {editingWorkspaceKey === groupKey ? (
                    <RailIconCustomizePanel
                      title={group.workspace.name}
                      icon={workspaceAppearance.icon}
                      color={workspaceAppearance.color}
                      showNameField={false}
                      onClose={() => setEditingWorkspaceKey(null)}
                      onUpdate={(patch) =>
                        updateWorkspaceAppearance(groupKey, patch)
                      }
                    />
                  ) : null}
                  {!isWorkspaceCollapsed ? (
                    <div
                      className="flex flex-col gap-[2px]"
                      onDragOver={handleFolderDropTargetDragOver}
                      onDrop={(event) => handleConversationDrop(event, group.workspace.id, null)}
                    >
                      {workspaceFolders.map((folder) => {
                        const isFolderCollapsed = collapsedFolderIds.has(folder.id);
                        const Icon = getFolderIcon(folder.icon);
                        const folderConversationList =
                          folderConversations.get(folder.id) ?? [];
                        return (
                          <div
                            key={folder.id}
                            className={`rounded-[var(--agent-control-radius)] ${
                              draggingConversationId || draggingFolderId === folder.id
                                ? "bg-[var(--bg-card)]"
                                : ""
                            } ${draggingFolderId === folder.id ? "opacity-60" : ""}`}
                            onDragOver={handleFolderDropTargetDragOver}
                            onDrop={(event) =>
                              handleFolderReorderDrop(event, group.workspace.id, folder.id)
                            }
                          >
                            <div
                              draggable
                              onDragStart={(event) => handleFolderDragStart(event, folder)}
                              onDragEnd={handleFolderDragEnd}
                              className="group/folder flex h-[24px] w-full min-w-0 items-center rounded-[var(--agent-control-radius)] text-[var(--text-secondary)] hover:bg-[var(--agent-card-bg)] hover:text-[var(--text-primary)]"
                              onContextMenu={(event) => handleFolderContextMenu(event, folder)}
                            >
                              <button
                                type="button"
                                onClick={() => toggleFolderCollapsed(folder.id)}
                                className="flex h-full min-w-0 flex-1 items-center gap-[6px] px-[9px] text-left"
                                title={`${folder.name} (${folderConversationList.length})`}
                              >
                                <ChevronRight
                                  className={`size-[10px] shrink-0 text-[var(--text-disabled)] transition-transform ${
                                    isFolderCollapsed ? "" : "rotate-90"
                                  }`}
                                  strokeWidth={2}
                                />
                                <Icon
                                  className="size-[13px] shrink-0"
                                  color={folder.color}
                                  strokeWidth={1.8}
                                />
                                <span className="min-w-0 flex-1 truncate font-sans text-[12.5px]">
                                  {folder.name}
                                </span>
                                <span className="shrink-0 font-sans text-[10px] text-[var(--text-disabled)]">
                                  {folderConversationList.length}
                                </span>
                              </button>
                              <button
                                type="button"
                                onClick={(event) => {
                                  event.preventDefault();
                                  event.stopPropagation();
                                  setEditingFolderId((current) =>
                                    current === folder.id ? null : folder.id
                                  );
                                }}
                                className="mr-[3px] flex size-[var(--d2-rail-control-size)] shrink-0 items-center justify-center rounded-[var(--agent-control-radius)] text-[var(--text-disabled)] opacity-0 hover:bg-[var(--bg-card)] hover:text-[var(--text-primary)] group-hover/folder:opacity-100 focus-visible:opacity-100"
                                title={`Customize ${folder.name}`}
                                aria-label={`Customize ${folder.name}`}
                              >
                                <Settings className="size-[12px]" strokeWidth={1.7} />
                              </button>
                            </div>
                            {editingFolderId === folder.id ? (
                              <RailIconCustomizePanel
                                title={folder.name}
                                icon={folder.icon}
                                color={folder.color}
                                showNameField
                                name={folder.name}
                                onClose={() => setEditingFolderId(null)}
                                onUpdate={(patch) =>
                                  updateFolder(folder.id, (current) => ({
                                    ...current,
                                    ...patch,
                                    name:
                                      typeof patch.name === "string"
                                        ? patch.name.trim().slice(0, 80) || "Folder"
                                        : current.name,
                                    color:
                                      typeof patch.color === "string" &&
                                      isValidFolderColor(patch.color)
                                        ? patch.color
                                        : current.color,
                                  }))
                                }
                              />
                            ) : null}
                            {!isFolderCollapsed ? (
                              <div
                                className="ml-[13px] mt-[2px] flex flex-col gap-[2px] border-l border-[var(--border-subtle)] pl-[5px]"
                                onDragOver={handleFolderDropTargetDragOver}
                                onDrop={(event) =>
                                  handleConversationDrop(event, group.workspace.id, folder.id)
                                }
                              >
                                {folderConversationList.length === 0 ? (
                                  <div className="px-[9px] py-[5px] font-sans text-[12px] text-[var(--text-disabled)]">
                                    Empty folder
                                  </div>
                                ) : (
                                  folderConversationList.map((conversation, index) => {
                                    const folderSection: RailConversationRowSection = {
                                      workspaceId: group.workspace.id,
                                      folderId: folder.id,
                                      orderedConversations: folderConversationList,
                                    };
                                    const railKey = getRailConversationKey(conversation);
                                    return (
                                      <AgentConversationRow
                                        key={conversation.conversationKey ?? conversation.id}
                                        conversation={conversation}
                                        showMachineBadge={showConversationMachine}
                                        rowIndex={index}
                                        selected={isConversationChatSelected(conversation)}
                                        bulkSelectMode={bulkSelectMode}
                                        bulkSelected={bulkSelectMode && bulkSelectedKeys.has(railKey)}
                                        editing={renameState?.conversationId === conversation.id}
                                        editValue={renameState?.draft}
                                        onBeginRename={() => beginConversationRename(conversation)}
                                        onEditValueChange={updateConversationRenameDraft}
                                        onCommitRename={commitConversationRename}
                                        onCancelRename={cancelConversationRename}
                                        onSelect={(event) => {
                                          if (bulkSelectMode) {
                                            handleBulkRowClick(event, conversation, folderSection);
                                            return;
                                          }
                                          handleConversationSelect(conversation);
                                        }}
                                        onDragStart={
                                          bulkSelectMode ? undefined : handleConversationDragStart
                                        }
                                        onDragEnd={
                                          bulkSelectMode ? undefined : handleConversationDragEnd
                                        }
                                        onDragOver={
                                          bulkSelectMode
                                            ? undefined
                                            : (event) => handleFolderDropTargetDragOver(event)
                                        }
                                        onDrop={
                                          bulkSelectMode
                                            ? undefined
                                            : (event) =>
                                                handleConversationDrop(
                                                  event,
                                                  group.workspace.id,
                                                  folder.id,
                                                  conversation.id
                                                )
                                        }
                                        onContextMenu={(e, currentConversation) =>
                                          handleConversationContextMenu(e, currentConversation, {
                                            inPinnedSection: false,
                                            folderId: folder.id,
                                            orderedConversations: folderConversationList,
                                          })
                                        }
                                        showOverflowMenu={experimentalIpadCustomButtons}
                                        onOverflowMenu={(anchor) =>
                                          handleConversationOverflowMenu(conversation, anchor, {
                                            inPinnedSection: false,
                                            folderId: folder.id,
                                            orderedConversations: folderConversationList,
                                          })
                                        }
                                      />
                                    );
                                  })
                                )}
                              </div>
                            ) : null}
                          </div>
                        );
                      })}
                      {rootConversations.map((conversation, index) => {
                          const rootSection: RailConversationRowSection = {
                            workspaceId: group.workspace.id,
                            folderId: null,
                            orderedConversations: rootConversations,
                          };
                          const railKey = getRailConversationKey(conversation);
                          return (
                            <AgentConversationRow
                              key={conversation.conversationKey ?? conversation.id}
                              conversation={conversation}
                              showMachineBadge={showConversationMachine}
                              rowIndex={index}
                              selected={isConversationChatSelected(conversation)}
                              bulkSelectMode={bulkSelectMode}
                              bulkSelected={bulkSelectMode && bulkSelectedKeys.has(railKey)}
                              editing={renameState?.conversationId === conversation.id}
                              editValue={renameState?.draft}
                              onBeginRename={() => beginConversationRename(conversation)}
                              onEditValueChange={updateConversationRenameDraft}
                              onCommitRename={commitConversationRename}
                              onCancelRename={cancelConversationRename}
                              onSelect={(event) => {
                                if (bulkSelectMode) {
                                  handleBulkRowClick(event, conversation, rootSection);
                                  return;
                                }
                                handleConversationSelect(conversation);
                              }}
                              onDragStart={
                                bulkSelectMode ? undefined : handleConversationDragStart
                              }
                              onDragEnd={bulkSelectMode ? undefined : handleConversationDragEnd}
                              onDragOver={
                                bulkSelectMode
                                  ? undefined
                                  : (event) => handleFolderDropTargetDragOver(event)
                              }
                              onDrop={
                                bulkSelectMode
                                  ? undefined
                                  : (event) =>
                                      handleConversationDrop(
                                        event,
                                        group.workspace.id,
                                        null,
                                        conversation.id
                                      )
                              }
                              onContextMenu={(e, currentConversation) =>
                                handleConversationContextMenu(e, currentConversation, {
                                  inPinnedSection: false,
                                  folderId: null,
                                  orderedConversations: rootConversations,
                                })
                              }
                              showOverflowMenu={experimentalIpadCustomButtons}
                              onOverflowMenu={(anchor) =>
                                handleConversationOverflowMenu(conversation, anchor, {
                                  inPinnedSection: false,
                                  folderId: null,
                                  orderedConversations: rootConversations,
                                })
                              }
                            />
                          );
                        })}
                    </div>
                  ) : null}
                </section>
              );
            })}
      </>
  );

  const orderedRailSections = useMemo(() => {
    const nodes: ReactNode[] = [];
    for (const sectionId of railSectionOrder) {
      if (sectionId === "pinned") {
        if (pinnedSection) nodes.push(<div key="pinned">{pinnedSection}</div>);
      } else if (sectionId === "chats") {
        nodes.push(<div key="chats">{chatsSection}</div>);
      } else if (sectionId === "workspaces") {
        nodes.push(<div key="workspaces">{workspaceGroupsSection}</div>);
      }
    }
    return nodes;
  }, [chatsSection, pinnedSection, railSectionOrder, workspaceGroupsSection]);

  const desktopRailCollapsed = leftRailCollapsed && !isMobile;
  const railHasContent =
    pinnedRailConversations.length > 0 ||
    standaloneChatConversations.length > 0 ||
    visibleGroups.length > 0 ||
    railSectionOrder.includes("chats");

  return (
    <>
      {!desktopRailCollapsed ? (
        <div
          className="flex h-full flex-col bg-[var(--agent-panel-bg)]"
        >
          {bulkSelectMode ? (
            <AgentRailBulkSelectBar
              selectedCount={bulkSelectedKeys.size}
              showPin={!bulkSectionPinned}
              showUnpin={bulkSectionPinned}
              topBarPadClass={railTopBarPadClass}
              onArchive={handleBulkArchive}
              onPin={handleBulkPin}
              onUnpin={handleBulkUnpin}
              onCancel={exitBulkSelect}
            />
          ) : (
            <div
              className={`flex shrink-0 items-center gap-[8px] pt-[11px] ${railTopBarPadClass}`}
              data-electron-drag-host
            >
              <button
                type="button"
                onClick={toggleLeftRailCollapsed}
                data-electron-no-drag
                className="flex size-[var(--d2-rail-control-size)] shrink-0 items-center justify-center rounded-[var(--agent-control-radius)] text-[var(--text-secondary)] transition-colors hover:bg-[var(--agent-card-bg)] hover:text-[var(--text-primary)]"
                aria-label="Collapse workspace rail"
                title="Collapse workspace rail"
              >
                <PanelLeftClose className="size-[16px]" strokeWidth={1.5} />
              </button>
              <button
                type="button"
                onClick={() => setRecentChatsOpen(true)}
                data-electron-no-drag
                className="flex size-[var(--d2-rail-control-size)] shrink-0 items-center justify-center rounded-[var(--agent-control-radius)] text-[var(--text-secondary)] transition-colors hover:bg-[var(--agent-card-bg)] hover:text-[var(--text-primary)]"
                aria-label="Search all chats"
                title="Search all chats"
              >
                <Search className="size-[16px]" strokeWidth={1.5} />
              </button>
              <button
                type="button"
                onClick={handleNewChat}
                data-perf="agent-rail-new-chat"
                data-electron-no-drag
                className="ml-auto flex size-[var(--d2-rail-control-size)] shrink-0 items-center justify-center rounded-[var(--agent-control-radius)] text-[var(--text-secondary)] transition-colors hover:bg-[var(--agent-card-bg)] hover:text-[var(--text-primary)]"
                aria-label="Start new chat"
                title="Start new chat"
              >
                <Plus className="size-[16px]" strokeWidth={1.5} />
              </button>
            </div>
          )}

          {!leftRailCollapsed ? (
            <>
              <AgentRailConversationListScroll measureKey={railListScrollMeasureKey}>
          {railLoading ? (
            <div className="flex min-h-[120px] flex-col items-center justify-center gap-[8px] px-[10px] text-center font-sans text-[13px] text-[var(--text-secondary)]">
              <span>Loading chats...</span>
              {railLoadError ? (
                <>
                  <span className="text-[12px] text-[var(--text-disabled)]">{railLoadError}</span>
                  <button
                    type="button"
                    onClick={() => void refreshConversationGroups()}
                    className="rounded-[var(--radius-tab)] border border-[var(--border-card)] px-[10px] py-[5px] text-[12px] text-[var(--text-primary)] transition-colors hover:bg-[var(--bg-card)]"
                  >
                    Retry
                  </button>
                </>
              ) : null}
            </div>
          ) : railLoadError ? (
            <div className="flex min-h-[120px] flex-col items-center justify-center gap-[8px] px-[10px] text-center font-sans text-[13px] text-[var(--text-secondary)]">
              <span>{railLoadError}</span>
              <button
                type="button"
                onClick={() => void refreshConversationGroups()}
                className="rounded-[var(--radius-tab)] border border-[var(--border-card)] px-[10px] py-[5px] text-[12px] text-[var(--text-primary)] transition-colors hover:bg-[var(--bg-card)]"
              >
                Retry
              </button>
            </div>
          ) : !railHasContent ? (
            <div className="flex min-h-[120px] flex-col items-center justify-center gap-[8px] px-[10px] text-center font-sans text-[13px] text-[var(--text-secondary)]">
              <span>
                {railFilterActive
                  ? "No conversations match the current filters."
                  : "No agent conversations yet."}
              </span>
              {railFilterActive ? (
                <button
                  type="button"
                  onClick={clearRailFilters}
                  className="rounded-[var(--radius-tab)] border border-[var(--border-card)] px-[10px] py-[5px] text-[12px] text-[var(--text-primary)] transition-colors hover:bg-[var(--bg-card)]"
                >
                  Clear filters
                </button>
              ) : null}
            </div>
          ) : (
            <>{orderedRailSections}</>
          )}
              </AgentRailConversationListScroll>
              {editingServerId === activeServer.id && !isLocalDeviceServer(activeServer) ? (
                <div className="shrink-0 px-[11px] pb-[4px]">
                  <RailIconCustomizePanel
                    title={activeServer.label}
                    icon={activeServerAppearance.icon}
                    color={activeServerAppearance.color}
                    showNameField
                    name={activeServerAppearance.nickname ?? ""}
                    nameFieldLabel="Server nickname"
                    allowEmptyName
                    onClose={() => setEditingServerId(null)}
                    onUpdate={(patch) =>
                      updateServerAppearance(
                        activeServer.id,
                        {
                          icon: patch.icon,
                          color: patch.color,
                          nickname: patch.name,
                        },
                        servers.findIndex((server) => server.id === activeServer.id)
                      )
                    }
                  />
                </div>
              ) : null}
              <div className="flex shrink-0 items-center gap-[8px] px-[11px] py-[10px]">
                <button
                  ref={accountAnchorRef}
                  type="button"
                  onClick={() => {
                    setFilterMenuOpen(false);
                    setServerPickerOpen((open) => !open);
                  }}
                  onContextMenu={(event) => {
                    if (isLocalDeviceServer(activeServer)) {
                      return;
                    }
                    event.preventDefault();
                    event.stopPropagation();
                    setFilterMenuOpen(false);
                    setServerPickerOpen(false);
                    setEditingServerId((current) =>
                      current === activeServer.id ? null : activeServer.id
                    );
                  }}
                  className="flex min-w-0 flex-1 items-center gap-[8px] rounded-[var(--radius-tab)] py-[2px] text-left hover:bg-[var(--bg-card)]"
                  aria-label={`Switch server (${activeServerDisplayLabel})`}
                  aria-expanded={serverPickerOpen}
                  aria-haspopup="menu"
                  title={activeServerDisplayLabel}
                >
                  {isLocalDeviceServer(activeServer) ? (
                    <CircleUserRound
                      className="size-[var(--d2-rail-control-size)] shrink-0 text-[var(--text-secondary)]"
                      strokeWidth={1.5}
                      aria-hidden
                    />
                  ) : (
                    <WorkspaceFolderIcon
                      iconName={activeServerAppearance.icon}
                      color={activeServerAppearance.color}
                      className="size-[var(--d2-rail-control-size)] shrink-0"
                      strokeWidth={1.5}
                    />
                  )}
                  <span className="min-w-0 flex-1 truncate font-sans text-[13px] text-[var(--text-primary)]">
                    {activeServerDisplayLabel}
                  </span>
                  <ChevronDown
                    className="size-[14px] shrink-0 text-[var(--text-secondary)]"
                    strokeWidth={1.5}
                    aria-hidden
                  />
                </button>
                <button
                  ref={filterAnchorRef}
                  type="button"
                  onClick={(e) => {
                    e.stopPropagation();
                    setFilterMenuOpen((open) => !open);
                  }}
                  className={`flex size-[var(--d2-rail-control-size)] shrink-0 items-center justify-center rounded-[var(--radius-tab)] transition-colors hover:bg-[var(--bg-card)] hover:text-[var(--text-primary)] ${
                    railControlActive ? "text-[var(--accent)]" : "text-[var(--text-secondary)]"
                  }`}
                  aria-label="Filter and sort conversations"
                  aria-expanded={filterMenuOpen}
                  title={`Sort: ${sortSummary}; Filter: ${filterSummary}`}
                >
                  <ListFilter className="size-[16px]" strokeWidth={1.5} />
                </button>
                <button
                  type="button"
                  onClick={openSettingsView}
                  className="flex size-[var(--d2-rail-control-size)] shrink-0 items-center justify-center rounded-[var(--radius-tab)] text-[var(--text-secondary)] transition-colors hover:bg-[var(--bg-card)] hover:text-[var(--text-primary)]"
                  aria-label="Open settings"
                  title="Open settings"
                >
                  <Settings className="size-[16px]" strokeWidth={1.5} />
                </button>
              </div>
            </>
          ) : null}
        </div>
      ) : null}

      <ServerPickerPopover
        open={serverPickerOpen}
        onClose={() => setServerPickerOpen(false)}
        anchorRef={accountAnchorRef}
        label="Switch server"
        selectedServerId={activeServer.id}
        servers={servers}
        serverStatusById={serverStatusById}
        serverRailAppearances={serverRailAppearances}
        onSelect={handleActiveServerChange}
        placement="above"
      />

      <RecentChatsModal
        items={allConversationsForSearch}
        open={recentChatsOpen}
        onClose={() => setRecentChatsOpen(false)}
        onSelectConversation={handleSearchSelect}
        placeholder="Search conversations on this server..."
        emptyLabel="No conversations found"
        screenReaderTitle="Search agent conversations"
        inputLabel="Search agent conversations"
      />

      <AgentRailFilterMenuPortal
        open={filterMenuOpen}
        onClose={() => setFilterMenuOpen(false)}
        anchorRef={filterAnchorRef}
        railFilterToggles={railFilterToggles}
        setRailFilterToggle={setRailFilterToggle}
        clearRailFilters={clearRailFilters}
        railFilterActive={railFilterActive}
        workspaceSortMode={workspaceSortMode}
        setWorkspaceSortMode={setWorkspaceSortMode}
        workspaceCustomOrderActive={workspaceCustomOrderIds.length > 0}
        resetWorkspaceCustomOrder={resetWorkspaceCustomOrder}
        groupBy={agentRailSettings.groupBy}
        setGroupBy={setAgentRailGroupBy}
        machines={machineOptions}
        hiddenMachineIds={agentRailSettings.hiddenServerIds}
        setMachineVisible={setMachineVisible}
        showIcons={agentRailSettings.showIcons}
        setShowIcons={(value) => patchAgentRailSettings({ showIcons: value })}
        sectionOrder={agentRailSettings.sectionOrder ?? ["pinned", "chats", "workspaces"]}
        hiddenSections={agentRailSettings.hiddenSections ?? []}
        setSectionOrder={setRailSectionOrder}
        setSectionHidden={setRailSectionHidden}
      />
    </>
  );
}
