"use client";

import {
  Archive,
  Bot,
  Briefcase,
  Bug,
  ChevronRight,
  CircleUserRound,
  Cloud,
  Code2,
  Cpu,
  Database,
  FileText,
  Flame,
  Folder,
  FolderOpen,
  GitBranch,
  Globe,
  Hash,
  Layers,
  ListFilter,
  MessageSquare,
  PanelLeftClose,
  Paintbrush,
  Plus,
  Rocket,
  Shield,
  Sparkles,
  Star,
  Search,
  Settings,
  Terminal,
  Wrench,
  Zap,
  type LucideIcon,
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
import type { WorkbenchMenuItem } from "@/components/ide/workbench-context-menu-types";
import { RecentChatsModal, type RecentChatOption } from "@/components/ide/RecentChatsModal";
import { AgentConversationRow } from "@/components/agent/rail/AgentConversationRow";
import { useAgentConversations } from "@/components/chat/AgentConversationsContext";
import { useOpenInEditor } from "@/components/editor/OpenInEditorContext";
import type { AgentRailConversationSummary } from "@/lib/agent-types";
import {
  AGENT_RAIL_FILTER_TOGGLE_KEYS,
  type AgentRailFilterToggleKey,
} from "@/lib/agent-rail";
import { AGENT_RAIL_OPEN_SEARCH_EVENT } from "@/components/agent/agent-rail-events";
import { AgentRailFilterMenuPortal } from "@/components/agent/AgentRailFilterMenuPortal";
import { useAuth } from "@/components/auth/AuthProvider";
import { useShellView } from "@/components/layout/ShellViewContext";
import { useAgentShellState } from "./AgentShellStateContext";
import { useWorkspace } from "@/contexts/WorkspaceContext";
import { useUserPreferences } from "@/components/preferences/UserPreferencesProvider";
import { useGlobalSettings } from "@/components/preferences/GlobalSettingsProvider";
import type { ChatFolderState, WorkspaceSortMode } from "@/lib/global-settings";
import { AGENT_NEW_CHAT_SESSION_ID } from "@/lib/workspace-session";

const PINNED_SECTION_WORKSPACE_ID = "__agentPinned__";
const AGENT_RAIL_CONVERSATION_DRAG_TYPE = "application/x-opencursor-agent-conversation";

const COLLAPSED_WORKSPACES_STORAGE_KEY = "opencursor.agent-rail-collapsed-workspaces";
const COLLAPSED_FOLDERS_STORAGE_KEY = "opencursor.agent-rail-collapsed-folders";

const FOLDER_ICON_OPTIONS: Array<{ name: string; Icon: LucideIcon }> = [
  { name: "Folder", Icon: Folder },
  { name: "FolderOpen", Icon: FolderOpen },
  { name: "Star", Icon: Star },
  { name: "Sparkles", Icon: Sparkles },
  { name: "MessageSquare", Icon: MessageSquare },
  { name: "Briefcase", Icon: Briefcase },
  { name: "Archive", Icon: Archive },
  { name: "Code2", Icon: Code2 },
  { name: "Wrench", Icon: Wrench },
  { name: "Hash", Icon: Hash },
  { name: "Bot", Icon: Bot },
  { name: "Bug", Icon: Bug },
  { name: "Cloud", Icon: Cloud },
  { name: "Cpu", Icon: Cpu },
  { name: "Database", Icon: Database },
  { name: "FileText", Icon: FileText },
  { name: "Flame", Icon: Flame },
  { name: "GitBranch", Icon: GitBranch },
  { name: "Globe", Icon: Globe },
  { name: "Layers", Icon: Layers },
  { name: "Paintbrush", Icon: Paintbrush },
  { name: "Rocket", Icon: Rocket },
  { name: "Shield", Icon: Shield },
  { name: "Terminal", Icon: Terminal },
  { name: "Zap", Icon: Zap },
];

const FOLDER_COLOR_OPTIONS = [
  "#7c3aed",
  "#2563eb",
  "#0891b2",
  "#059669",
  "#ca8a04",
  "#ea580c",
  "#dc2626",
  "#db2777",
];

function getFolderIcon(iconName: string): LucideIcon {
  return FOLDER_ICON_OPTIONS.find((option) => option.name === iconName)?.Icon ?? Folder;
}

function isValidFolderColor(value: string): boolean {
  return /^#[0-9a-f]{6}$/i.test(value);
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
};

const WORKSPACE_SORT_LABELS: Record<WorkspaceSortMode, string> = {
  recent: "Recently opened",
  alphabetical: "Alphabetical",
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
  const [fade, setFade] = useState({
    top: false,
    bottom: false,
    left: false,
    right: false,
  });

  const updateFade = useCallback(() => {
    const el = scrollRef.current;
    if (!el) {
      return;
    }
    const { scrollTop, scrollLeft, scrollWidth, clientWidth, scrollHeight, clientHeight } = el;
    const maxScrollX = scrollWidth - clientWidth;
    const maxScrollY = scrollHeight - clientHeight;
    setFade({
      top: scrollTop > 2,
      bottom: maxScrollY > 2 && scrollTop < maxScrollY - 2,
      left: scrollLeft > 2,
      right: maxScrollX > 2 && scrollLeft < maxScrollX - 2,
    });
  }, []);

  useLayoutEffect(() => {
    updateFade();
  }, [measureKey, updateFade]);

  useLayoutEffect(() => {
    const el = scrollRef.current;
    if (!el) {
      return;
    }
    const ro = new ResizeObserver(() => updateFade());
    ro.observe(el);
    return () => ro.disconnect();
  }, [updateFade]);

  const edge = "var(--bg-panel)";
  const gradTop = `linear-gradient(to bottom, ${edge}, transparent)`;
  const gradBottom = `linear-gradient(to top, ${edge}, transparent)`;
  const gradLeft = `linear-gradient(to right, ${edge}, transparent)`;
  const gradRight = `linear-gradient(to left, ${edge}, transparent)`;

  return (
    <div className="relative min-h-0 min-w-0 flex-1">
      {fade.top ? (
        <div
          className="pointer-events-none absolute inset-x-0 top-0 z-[2] h-[28px]"
          style={{ backgroundImage: gradTop }}
          aria-hidden
        />
      ) : null}
      {fade.bottom ? (
        <div
          className="pointer-events-none absolute inset-x-0 bottom-0 z-[2] h-[28px]"
          style={{ backgroundImage: gradBottom }}
          aria-hidden
        />
      ) : null}
      {fade.left ? (
        <div
          className="pointer-events-none absolute inset-y-0 left-0 z-[2] w-[28px]"
          style={{ backgroundImage: gradLeft }}
          aria-hidden
        />
      ) : null}
      {fade.right ? (
        <div
          className="pointer-events-none absolute inset-y-0 right-0 z-[2] w-[28px]"
          style={{ backgroundImage: gradRight }}
          aria-hidden
        />
      ) : null}
      <div
        ref={scrollRef}
        onScroll={updateFade}
        className="hide-scrollbar-y relative z-0 h-full min-h-0 w-full min-w-0 overflow-auto px-[11px] pb-[8px] pt-[12px]"
      >
        {children}
      </div>
    </div>
  );
}

function FolderCustomizePanel({
  folder,
  onClose,
  onUpdate,
}: {
  folder: ChatFolderState;
  onClose: () => void;
  onUpdate: (patch: Partial<Pick<ChatFolderState, "name" | "color" | "icon">>) => void;
}) {
  const ActiveIcon = getFolderIcon(folder.icon);
  return (
    <div className="ml-[13px] mt-[3px] rounded-[var(--radius-card)] border border-[var(--border-card)] bg-[var(--bg-panel)] p-[8px] shadow-[0_12px_40px_rgba(0,0,0,0.22)]">
      <div className="flex items-center gap-[8px]">
        <div
          className="flex size-[28px] shrink-0 items-center justify-center rounded-[var(--agent-control-radius)] border border-[var(--border-subtle)]"
          style={{ color: folder.color }}
          aria-hidden
        >
          <ActiveIcon className="size-[16px]" strokeWidth={1.8} />
        </div>
        <input
          value={folder.name}
          maxLength={80}
          aria-label="Folder name"
          className="h-[28px] min-w-0 flex-1 rounded-[var(--agent-control-radius)] border border-[var(--border-subtle)] bg-[var(--bg-main)] px-[8px] font-sans text-[12px] text-[var(--text-primary)] outline-none transition-colors placeholder:text-[var(--text-disabled)] focus:border-[var(--accent)]"
          onChange={(event) => {
            const nextName = event.target.value.slice(0, 80);
            onUpdate({ name: nextName || "Folder" });
          }}
          onKeyDown={(event) => {
            if (event.key === "Escape") {
              event.preventDefault();
              onClose();
            }
          }}
        />
        <button
          type="button"
          onClick={onClose}
          className="h-[28px] shrink-0 rounded-[var(--agent-control-radius)] px-[8px] font-sans text-[11px] text-[var(--text-secondary)] transition-colors hover:bg-[var(--bg-card)] hover:text-[var(--text-primary)]"
        >
          Done
        </button>
      </div>

      <div className="mt-[8px] grid grid-cols-7 gap-[4px]" aria-label="Folder icon palette">
        {FOLDER_ICON_OPTIONS.map(({ name, Icon }) => {
          const selected = folder.icon === name;
          return (
            <button
              key={name}
              type="button"
              onClick={() => onUpdate({ icon: name })}
              className={`flex size-[24px] items-center justify-center rounded-[var(--agent-control-radius)] border transition-colors ${
                selected
                  ? "border-[var(--accent)] bg-[var(--accent-bg)] text-[var(--text-primary)]"
                  : "border-transparent text-[var(--text-secondary)] hover:border-[var(--border-subtle)] hover:bg-[var(--bg-card)] hover:text-[var(--text-primary)]"
              }`}
              title={name}
              aria-label={`Use ${name} icon`}
              aria-pressed={selected}
            >
              <Icon className="size-[14px]" strokeWidth={1.8} />
            </button>
          );
        })}
      </div>

      <div className="mt-[8px] flex items-center gap-[6px]">
        <div className="flex min-w-0 flex-1 flex-wrap gap-[4px]" aria-label="Folder color palette">
          {FOLDER_COLOR_OPTIONS.map((color) => (
            <button
              key={color}
              type="button"
              onClick={() => onUpdate({ color })}
              className={`size-[18px] rounded-full border transition-transform hover:scale-110 ${
                folder.color.toLowerCase() === color.toLowerCase()
                  ? "border-[var(--text-primary)]"
                  : "border-[var(--border-card)]"
              }`}
              style={{ backgroundColor: color }}
              title={color}
              aria-label={`Use ${color} folder color`}
              aria-pressed={folder.color.toLowerCase() === color.toLowerCase()}
            />
          ))}
        </div>
        <label className="flex shrink-0 items-center gap-[5px] rounded-[var(--agent-control-radius)] border border-[var(--border-subtle)] bg-[var(--bg-main)] px-[6px] py-[3px] font-sans text-[11px] text-[var(--text-secondary)]">
          Custom
          <input
            type="color"
            value={isValidFolderColor(folder.color) ? folder.color : "#7c3aed"}
            onChange={(event) => onUpdate({ color: event.target.value })}
            className="size-[18px] cursor-pointer border-0 bg-transparent p-0"
            aria-label="Custom folder color"
          />
        </label>
      </div>
    </div>
  );
}

export function AgentWorkspaceRail() {
  const { session: authSession } = useAuth();
  const { openSettingsView } = useShellView();
  const accountLabel = authSession?.username?.trim() || "Guest";
  const { renameConversation, forkConversation } = useAgentConversations();
  const { openAgentConversation } = useOpenInEditor();
  const {
    groups,
    leftRailCollapsed,
    railLoading,
    selectedConversationId,
    startNewConversation,
    startNewChatInWorkspace,
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
  const { activeWorkspaceId, gitStatus } = useWorkspace();
  const { experimentalIpadCustomButtons, experimentalIpadWindowedTabInset } =
    useUserPreferences();
  const { settings, updateSettings } = useGlobalSettings();
  const workspaceSortMode = settings.general.workspaceSortMode;
  const workspaceCustomOrderIds = settings.general.workspaceCustomOrderIds;
  const padRailForWindowChrome = experimentalIpadWindowedTabInset && !isMobile;
  /** Only the top control row needs iPadOS window-chrome inset; list + footer stay full-width in the rail. */
  const railTopBarPadClass = padRailForWindowChrome
    ? "pl-[var(--editor-window-chrome-tab-inset)] pr-[11px]"
    : "px-[11px]";
  const { openAt, openAtPoint } = useWorkbenchContextMenu();
  const filterAnchorRef = useRef<HTMLButtonElement>(null);
  const [filterMenuOpen, setFilterMenuOpen] = useState(false);
  const [collapsedWorkspaceIds, setCollapsedWorkspaceIds] = useState<Set<string>>(new Set());
  const [collapsedFolderIds, setCollapsedFolderIds] = useState<Set<string>>(new Set());
  const [draggingWorkspaceId, setDraggingWorkspaceId] = useState<string | null>(null);
  const [draggingConversationId, setDraggingConversationId] = useState<string | null>(null);
  const [editingFolderId, setEditingFolderId] = useState<string | null>(null);
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
  const railControlActive = railFilterActive || workspaceSortMode !== "recent";

  const visibleGroups = useMemo(
    () =>
      groups.filter(
        (group) => group.workspace.id === activeWorkspaceId || group.conversations.length > 0
      ),
    [activeWorkspaceId, groups]
  );

  const setWorkspaceSortMode = useCallback(
    (mode: WorkspaceSortMode) => {
      updateSettings((current) => {
        const seededCustomOrderIds =
          mode === "custom" && current.general.workspaceCustomOrderIds.length === 0
            ? visibleGroups.map((group) => group.workspace.id)
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
    [updateSettings, visibleGroups]
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

  const reorderWorkspaceGroups = useCallback(
    (sourceWorkspaceId: string, targetWorkspaceId: string, placement: "before" | "after") => {
      const visibleWorkspaceIds = visibleGroups.map((group) => group.workspace.id);
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
    [updateSettings, visibleGroups]
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

  const handleConversationDropTargetDragOver = useCallback(
    (event: ReactDragEvent<HTMLElement>) => {
      if (!draggingConversationId) {
        return;
      }
      event.preventDefault();
      event.dataTransfer.dropEffect = "move";
    },
    [draggingConversationId]
  );

  const railListScrollMeasureKey = useMemo(
    () =>
      `${visibleGroups.length}:${pinnedRailConversations.length}:${settings.general.chatFolders.length}:${railLoading ? 1 : 0}:${renameState?.conversationId ?? ""}:${collapsedFolderIds.size}`,
    [
      visibleGroups.length,
      pinnedRailConversations.length,
      settings.general.chatFolders.length,
      railLoading,
      renameState?.conversationId,
      collapsedFolderIds.size,
    ]
  );

  const handleNewChat = useCallback(() => {
    startNewConversation();
  }, [startNewConversation]);

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
    (workspaceId: string, options?: { conversationId?: string }) => {
      const folderId = createChatFolderId();
      const conversationId = options?.conversationId;
      updateSettings((current) => {
        const workspaceFolders = current.general.chatFolders.filter(
          (folder) => folder.workspaceId === workspaceId
        );
        const nextFolder: ChatFolderState = {
          id: folderId,
          workspaceId,
          name: "New folder",
          color: FOLDER_COLOR_OPTIONS[workspaceFolders.length % FOLDER_COLOR_OPTIONS.length],
          icon: "Folder",
          sortOrder:
            workspaceFolders.reduce(
              (max, folder) => Math.max(max, folder.sortOrder),
              -1
            ) + 1,
          conversationIds: conversationId ? [conversationId] : [],
        };
        return {
          ...current,
          general: {
            ...current.general,
            chatFolders: [
              ...current.general.chatFolders.map((folder) =>
                folder.workspaceId === workspaceId && conversationId
                  ? {
                      ...folder,
                      conversationIds: folder.conversationIds.filter(
                        (id) => id !== conversationId
                      ),
                    }
                  : folder
              ),
              nextFolder,
            ],
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
    [updateSettings]
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

  const renameFolder = useCallback(
    (folder: ChatFolderState) => {
      setEditingFolderId(folder.id);
    },
    []
  );

  const deleteFolder = useCallback(
    (folder: ChatFolderState) => {
      const confirmed = window.confirm(
        `Delete "${folder.name}"? Chats move back to this workspace root.`
      );
      if (!confirmed) {
        return;
      }
      updateSettings((current) => ({
        ...current,
        general: {
          ...current.general,
          chatFolders: current.general.chatFolders.filter((item) => item.id !== folder.id),
        },
      }));
      setEditingFolderId((current) => (current === folder.id ? null : current));
    },
    [updateSettings]
  );

  const moveConversationToFolder = useCallback(
    (conversationId: string, workspaceId: string, folderId: string | null) => {
      updateSettings((current) => ({
        ...current,
        general: {
          ...current.general,
          chatFolders: current.general.chatFolders.map((folder) => {
            if (folder.workspaceId !== workspaceId) {
              return folder;
            }
            const withoutConversation = folder.conversationIds.filter(
              (id) => id !== conversationId
            );
            return {
              ...folder,
              conversationIds:
                folder.id === folderId
                  ? [...withoutConversation, conversationId]
                  : withoutConversation,
            };
          }),
        },
      }));
    },
    [updateSettings]
  );

  const handleConversationDrop = useCallback(
    (event: ReactDragEvent<HTMLElement>, workspaceId: string, folderId: string | null) => {
      const conversationId =
        event.dataTransfer.getData(AGENT_RAIL_CONVERSATION_DRAG_TYPE) || draggingConversationId;
      if (!conversationId) {
        return;
      }
      event.preventDefault();
      event.stopPropagation();
      setDraggingConversationId(null);
      moveConversationToFolder(conversationId, workspaceId, folderId);
    },
    [draggingConversationId, moveConversationToFolder]
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
  }, [groups, pinnedRailConversations]);

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
      options?: { inPinnedSection?: boolean }
    ): WorkbenchMenuItem[] => {
      const inPinned = options?.inPinnedSection ?? false;
      const conversationId = conversation.id;
      const workspaceFolders = settings.general.chatFolders
        .filter((folder) => folder.workspaceId === conversation.workspaceId)
        .sort((a, b) => a.sortOrder - b.sortOrder || a.name.localeCompare(b.name));
      const currentFolder = workspaceFolders.find((folder) =>
        folder.conversationIds.includes(conversationId)
      );
      const moveItems: WorkbenchMenuItem[] = [
        { type: "sep" },
        {
          type: "item",
          id: "move-new-folder",
          label: "Move to New Folder...",
          onSelect: () =>
            createFolderForWorkspace(conversation.workspaceId, {
              conversationId,
            }),
        },
        ...(workspaceFolders.length > 0
          ? [
              {
                type: "item" as const,
                id: "move-root",
                label: "Move to Workspace Root",
                disabled: !currentFolder,
                onSelect: () =>
                  moveConversationToFolder(conversationId, conversation.workspaceId, null),
              },
              ...workspaceFolders.map(
                (folder): WorkbenchMenuItem => ({
                  type: "item",
                  id: `move-folder-${folder.id}`,
                  label: `Move to ${folder.name}`,
                  disabled: currentFolder?.id === folder.id,
                  onSelect: () =>
                    moveConversationToFolder(conversationId, conversation.workspaceId, folder.id),
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
      createFolderForWorkspace,
      forkConversation,
      handleOpenConversationInEditor,
      moveConversationToFolder,
      pinConversation,
      settings.general.chatFolders,
      unpinConversation,
    ]
  );

  const handleConversationContextMenu = useCallback(
    (
      e: ReactMouseEvent,
      conversation: AgentRailConversationSummary,
      options?: { inPinnedSection?: boolean }
    ) => {
      openAt(e, buildConversationMenuItems(conversation, options));
    },
    [buildConversationMenuItems, openAt]
  );

  const handleConversationOverflowMenu = useCallback(
    (
      conversation: AgentRailConversationSummary,
      anchorEl: HTMLElement,
      options?: { inPinnedSection?: boolean }
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
            <ChevronRight
              className={`size-[10px] shrink-0 text-[var(--text-disabled)] transition-[transform,color] duration-150 group-hover/wshead:text-[var(--text-secondary)] ${
                isPinnedHeaderCollapsed ? "" : "rotate-90"
              }`}
              strokeWidth={2}
            />
            <span className="truncate font-sans text-[10.5px] font-medium text-[var(--text-disabled)] transition-colors group-hover/wshead:text-[var(--text-primary)]">
              Pinned
            </span>
          </button>
        </div>
        {!isPinnedHeaderCollapsed ? (
          <div className="flex flex-col gap-[2px]">
            {pinnedRailConversations.map((conversation, index) => {
              const selected =
                conversation.id === selectedConversationId &&
                conversation.workspaceId === activeWorkspaceId;
              return (
                <AgentConversationRow
                  key={conversation.id}
                  conversation={conversation}
                  rowIndex={index}
                  selected={selected}
                  editing={renameState?.conversationId === conversation.id}
                  editValue={renameState?.draft}
                  onBeginRename={() => beginConversationRename(conversation)}
                  onEditValueChange={updateConversationRenameDraft}
                  onCommitRename={commitConversationRename}
                  onCancelRename={cancelConversationRename}
                  onSelect={() => handleConversationSelect(conversation)}
                  onContextMenu={(e, currentConversation) =>
                    handleConversationContextMenu(e, currentConversation, {
                      inPinnedSection: true,
                    })
                  }
                  showOverflowMenu={experimentalIpadCustomButtons}
                  onOverflowMenu={(anchor) =>
                    handleConversationOverflowMenu(conversation, anchor, {
                      inPinnedSection: true,
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
    activeWorkspaceId,
    beginConversationRename,
    cancelConversationRename,
    collapsedWorkspaceIds,
    commitConversationRename,
    experimentalIpadCustomButtons,
    handleConversationOverflowMenu,
    handleConversationSelect,
    handleConversationContextMenu,
    pinnedRailConversations,
    renameState?.conversationId,
    renameState?.draft,
    selectedConversationId,
    toggleWorkspaceCollapsed,
    updateConversationRenameDraft,
  ]);

  const desktopRailCollapsed = leftRailCollapsed && !isMobile;

  return (
    <>
      {!desktopRailCollapsed ? (
        <div
          className="flex h-full flex-col bg-[var(--agent-panel-bg)]"
          data-electron-drag-host
        >
          <div
            className={`flex shrink-0 items-center gap-[8px] pt-[11px] ${railTopBarPadClass}`}
          >
            <button
              type="button"
              onClick={toggleLeftRailCollapsed}
              className="flex size-[18px] shrink-0 items-center justify-center rounded-[var(--agent-control-radius)] text-[var(--text-secondary)] transition-colors hover:bg-[var(--agent-card-bg)] hover:text-[var(--text-primary)]"
              aria-label="Collapse workspace rail"
              title="Collapse workspace rail"
            >
              <PanelLeftClose className="size-[16px]" strokeWidth={1.5} />
            </button>
            <button
              type="button"
              onClick={() => setRecentChatsOpen(true)}
              className="flex size-[18px] shrink-0 items-center justify-center rounded-[var(--agent-control-radius)] text-[var(--text-secondary)] transition-colors hover:bg-[var(--agent-card-bg)] hover:text-[var(--text-primary)]"
              aria-label="Search all chats"
              title="Search all chats"
            >
              <Search className="size-[16px]" strokeWidth={1.5} />
            </button>
            <button
              type="button"
              onClick={handleNewChat}
              data-perf="agent-rail-new-chat"
              className="ml-auto flex size-[18px] shrink-0 items-center justify-center rounded-[var(--agent-control-radius)] text-[var(--text-secondary)] transition-colors hover:bg-[var(--agent-card-bg)] hover:text-[var(--text-primary)]"
              aria-label="Start new chat"
              title="Start new chat"
            >
              <Plus className="size-[16px]" strokeWidth={1.5} />
            </button>
          </div>

          {!leftRailCollapsed ? (
            <>
              <AgentRailConversationListScroll measureKey={railListScrollMeasureKey}>
          {railLoading ? (
            <div className="flex min-h-[120px] items-center justify-center font-sans text-[13px] text-[var(--text-secondary)]">
              Loading chats...
            </div>
          ) : visibleGroups.length === 0 && pinnedRailConversations.length === 0 ? (
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
            <>
              {pinnedSection}
              {visibleGroups.map((group) => {
                const isWorkspaceCollapsed = collapsedWorkspaceIds.has(group.workspace.id);
                const workspaceFolders = settings.general.chatFolders
                  .filter((folder) => folder.workspaceId === group.workspace.id)
                  .sort((a, b) => a.sortOrder - b.sortOrder || a.name.localeCompare(b.name));
                const folderIdByConversationId = new Map<string, string>();
                for (const folder of workspaceFolders) {
                  for (const conversationId of folder.conversationIds) {
                    folderIdByConversationId.set(conversationId, folder.id);
                  }
                }
                const conversationsById = new Map(
                  group.conversations.map((conversation) => [conversation.id, conversation])
                );
                const rootConversations = group.conversations.filter(
                  (conversation) => !folderIdByConversationId.has(conversation.id)
                );
                const branchLabel = workspaceBranchLabel(group.workspace.id, group.workspace.root);
                return (
                <section
                  key={group.workspace.id}
                  onDragOver={handleWorkspaceDragOver}
                  onDrop={(event) => handleWorkspaceDrop(event, group.workspace.id)}
                  className={`pb-[12px] ${
                    draggingWorkspaceId === group.workspace.id ? "opacity-60" : ""
                  }`}
                >
                  <div
                    draggable
                    onDragStart={(event) => handleWorkspaceDragStart(event, group.workspace.id)}
                    onDragEnd={handleWorkspaceDragEnd}
                    className="group flex items-center gap-[2px] px-px pb-[4px]"
                  >
                    <button
                      type="button"
                      onClick={() => toggleWorkspaceCollapsed(group.workspace.id)}
                      className="group/wshead flex min-w-0 flex-1 items-center gap-[4px] rounded-[var(--radius-tab)] py-[2px] text-left"
                    >
                      <ChevronRight
                        className={`size-[10px] shrink-0 text-[var(--text-disabled)] transition-[transform,color] duration-150 group-hover/wshead:text-[var(--text-secondary)] ${
                          isWorkspaceCollapsed ? "" : "rotate-90"
                        }`}
                        strokeWidth={2}
                      />
                      <span className="truncate font-sans text-[10.5px] font-medium text-[var(--text-disabled)] transition-colors group-hover/wshead:text-[var(--text-primary)]">
                        {group.workspace.name}
                      </span>
                      {branchLabel ? (
                        <span className="max-w-[120px] shrink truncate rounded-[var(--radius-tab)] border border-[var(--border-subtle)] px-[5px] py-[1px] font-mono text-[9.5px] text-[var(--text-disabled)]">
                          {branchLabel}
                        </span>
                      ) : null}
                    </button>
                    <button
                      type="button"
                      onClick={() => void handleNewChatForWorkspace(group.workspace.id)}
                      className="flex size-[16px] shrink-0 items-center justify-center rounded-[var(--radius-tab)] text-[var(--text-disabled)] opacity-0 transition-all group-hover:opacity-100 hover:bg-[var(--bg-card)] hover:text-[var(--text-primary)]"
                      aria-label={`New chat in ${group.workspace.name}`}
                      title={`New chat in ${group.workspace.name}`}
                    >
                      <Plus className="size-[12px]" strokeWidth={2} />
                    </button>
                  </div>
                  {!isWorkspaceCollapsed ? (
                    <div
                      className="flex flex-col gap-[2px]"
                      onDragOver={handleConversationDropTargetDragOver}
                      onDrop={(event) => handleConversationDrop(event, group.workspace.id, null)}
                    >
                      {workspaceFolders.map((folder) => {
                        const isFolderCollapsed = collapsedFolderIds.has(folder.id);
                        const Icon = getFolderIcon(folder.icon);
                        const folderConversations = folder.conversationIds
                          .map((conversationId) => conversationsById.get(conversationId))
                          .filter(
                            (conversation): conversation is AgentRailConversationSummary =>
                              Boolean(conversation)
                          );
                        return (
                          <div
                            key={folder.id}
                            className={`rounded-[var(--agent-control-radius)] ${
                              draggingConversationId ? "bg-[var(--bg-card)]" : ""
                            }`}
                            onDragOver={handleConversationDropTargetDragOver}
                            onDrop={(event) =>
                              handleConversationDrop(event, group.workspace.id, folder.id)
                            }
                          >
                            <div
                              className="group/folder flex h-[24px] w-full min-w-0 items-center rounded-[var(--agent-control-radius)] text-[var(--text-secondary)] transition-colors hover:bg-[var(--agent-card-bg)] hover:text-[var(--text-primary)]"
                              onContextMenu={(event) => handleFolderContextMenu(event, folder)}
                            >
                              <button
                                type="button"
                                onClick={() => toggleFolderCollapsed(folder.id)}
                                className="flex h-full min-w-0 flex-1 items-center gap-[6px] px-[9px] text-left"
                                title={`${folder.name} (${folderConversations.length})`}
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
                                  {folderConversations.length}
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
                                className="mr-[3px] flex size-[18px] shrink-0 items-center justify-center rounded-[var(--agent-control-radius)] text-[var(--text-disabled)] opacity-0 transition-all hover:bg-[var(--bg-card)] hover:text-[var(--text-primary)] group-hover/folder:opacity-100 focus-visible:opacity-100"
                                title={`Customize ${folder.name}`}
                                aria-label={`Customize ${folder.name}`}
                              >
                                <Settings className="size-[12px]" strokeWidth={1.7} />
                              </button>
                            </div>
                            {editingFolderId === folder.id ? (
                              <FolderCustomizePanel
                                folder={folder}
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
                              <div className="ml-[13px] mt-[2px] flex flex-col gap-[2px] border-l border-[var(--border-subtle)] pl-[5px]">
                                {folderConversations.length === 0 ? (
                                  <div className="px-[9px] py-[5px] font-sans text-[12px] text-[var(--text-disabled)]">
                                    Empty folder
                                  </div>
                                ) : (
                                  folderConversations.map((conversation, index) => {
                                    const selected =
                                      conversation.id === selectedConversationId &&
                                      conversation.workspaceId === activeWorkspaceId;
                                    return (
                                      <AgentConversationRow
                                        key={conversation.id}
                                        conversation={conversation}
                                        rowIndex={index}
                                        selected={selected}
                                        editing={renameState?.conversationId === conversation.id}
                                        editValue={renameState?.draft}
                                        onBeginRename={() => beginConversationRename(conversation)}
                                        onEditValueChange={updateConversationRenameDraft}
                                        onCommitRename={commitConversationRename}
                                        onCancelRename={cancelConversationRename}
                                        onSelect={() => handleConversationSelect(conversation)}
                                        onDragStart={handleConversationDragStart}
                                        onDragEnd={handleConversationDragEnd}
                                        onContextMenu={(e, currentConversation) =>
                                          handleConversationContextMenu(e, currentConversation, {
                                            inPinnedSection: false,
                                          })
                                        }
                                        showOverflowMenu={experimentalIpadCustomButtons}
                                        onOverflowMenu={(anchor) =>
                                          handleConversationOverflowMenu(conversation, anchor, {
                                            inPinnedSection: false,
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
                          const selected =
                            conversation.id === selectedConversationId &&
                            conversation.workspaceId === activeWorkspaceId;
                          return (
                            <AgentConversationRow
                              key={conversation.id}
                              conversation={conversation}
                              rowIndex={index}
                              selected={selected}
                              editing={renameState?.conversationId === conversation.id}
                              editValue={renameState?.draft}
                              onBeginRename={() => beginConversationRename(conversation)}
                              onEditValueChange={updateConversationRenameDraft}
                              onCommitRename={commitConversationRename}
                              onCancelRename={cancelConversationRename}
                              onSelect={() => handleConversationSelect(conversation)}
                              onDragStart={handleConversationDragStart}
                              onDragEnd={handleConversationDragEnd}
                              onContextMenu={(e, currentConversation) =>
                                handleConversationContextMenu(e, currentConversation, {
                                  inPinnedSection: false,
                                })
                              }
                              showOverflowMenu={experimentalIpadCustomButtons}
                              onOverflowMenu={(anchor) =>
                                handleConversationOverflowMenu(conversation, anchor, {
                                  inPinnedSection: false,
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
          )}
              </AgentRailConversationListScroll>
              <div className="flex shrink-0 items-center gap-[8px] px-[11px] py-[10px]">
                <div
                  className="flex min-w-0 flex-1 items-center gap-[8px]"
                  title={accountLabel}
                >
                  <CircleUserRound
                    className="size-[18px] shrink-0 text-[var(--text-secondary)]"
                    strokeWidth={1.5}
                    aria-hidden
                  />
                  <span className="truncate font-sans text-[13px] text-[var(--text-primary)]">
                    {accountLabel}
                  </span>
                </div>
                <button
                  ref={filterAnchorRef}
                  type="button"
                  onClick={(e) => {
                    e.stopPropagation();
                    setFilterMenuOpen((open) => !open);
                  }}
                  className={`flex size-[18px] shrink-0 items-center justify-center rounded-[var(--radius-tab)] transition-colors hover:bg-[var(--bg-card)] hover:text-[var(--text-primary)] ${
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
                  className="flex size-[18px] shrink-0 items-center justify-center rounded-[var(--radius-tab)] text-[var(--text-secondary)] transition-colors hover:bg-[var(--bg-card)] hover:text-[var(--text-primary)]"
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

      <RecentChatsModal
        items={allConversationsForSearch}
        open={recentChatsOpen}
        onClose={() => setRecentChatsOpen(false)}
        onSelectConversation={handleSearchSelect}
        placeholder="Search across all workspaces..."
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
      />
    </>
  );
}
