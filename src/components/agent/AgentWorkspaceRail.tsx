"use client";

import {
  ChevronRight,
  CircleUserRound,
  ListFilter,
  PanelLeftClose,
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

const PINNED_SECTION_WORKSPACE_ID = "__agentPinned__";

const COLLAPSED_WORKSPACES_STORAGE_KEY = "opencursor.agent-rail-collapsed-workspaces";

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

const FILTER_TOGGLE_LABELS: Record<AgentRailFilterToggleKey, string> = {
  archived: "Archived",
  running: "Running",
  needs_attention: "Needs attention",
  pinned: "Pinned",
  unread: "Unread",
  read: "Read",
};

export function AgentWorkspaceRail() {
  const { session: authSession } = useAuth();
  const { openSettingsView } = useShellView();
  const accountLabel = authSession?.username?.trim() || "Guest";
  const { renameConversation } = useAgentConversations();
  const { openAgentConversation } = useOpenInEditor();
  const {
    groups,
    leftRailCollapsed,
    railLoading,
    setRightPaneOpen,
    selectedConversationId,
    startNewConversation,
    toggleLeftRailCollapsed,
    openConversationSummary,
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
  const { activeWorkspaceId, openWorkspaceById } = useWorkspace();
  const { openAt } = useWorkbenchContextMenu();
  const filterAnchorRef = useRef<HTMLButtonElement>(null);
  const [filterMenuOpen, setFilterMenuOpen] = useState(false);
  const [collapsedWorkspaceIds, setCollapsedWorkspaceIds] = useState<Set<string>>(new Set());
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

  useLayoutEffect(() => {
    setCollapsedWorkspaceIds(readCollapsedWorkspaceIdsFromStorage());
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

  const filterSummary = useMemo(() => {
    if (!railFilterActive) {
      return "Non-archived chats";
    }
    return AGENT_RAIL_FILTER_TOGGLE_KEYS.filter((k) => railFilterToggles[k])
      .map((k) => FILTER_TOGGLE_LABELS[k])
      .join(", ");
  }, [railFilterActive, railFilterToggles]);

  const visibleGroups = useMemo(
    () =>
      groups.filter(
        (group) => group.workspace.id === activeWorkspaceId || group.conversations.length > 0
      ),
    [activeWorkspaceId, groups]
  );

  const handleNewChat = useCallback(() => {
    startNewConversation();
  }, [startNewConversation]);

  const handleNewChatForWorkspace = useCallback(
    async (workspaceId: string) => {
      if (workspaceId !== activeWorkspaceId) {
        await openWorkspaceById(workspaceId);
      }
      startNewConversation();
    },
    [activeWorkspaceId, openWorkspaceById, startNewConversation]
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
    void renameConversation(conversationId, nextTitle);
  }, [renameConversation, renameState]);

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
    setRightPaneOpen(true);
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
    setRightPaneOpen,
    toggleLeftRailCollapsed,
  ]);

  const handleConversationContextMenu = useCallback(
    (
      e: ReactMouseEvent,
      conversation: AgentRailConversationSummary,
      options?: { inPinnedSection?: boolean }
    ) => {
      const inPinned = options?.inPinnedSection ?? false;
      const conversationId = conversation.id;
      const items: WorkbenchMenuItem[] = [
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
        { type: "sep" },
        {
          type: "item",
          id: "archive",
          label: "Archive",
          onSelect: () => archiveConversation(conversationId),
        },
      ];
      openAt(e, items);
    },
    [
      archiveConversation,
      beginConversationRename,
      handleOpenConversationInEditor,
      openAt,
      pinConversation,
      unpinConversation,
    ]
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
            {pinnedRailConversations.map((conversation) => {
              const selected =
                conversation.id === selectedConversationId &&
                conversation.workspaceId === activeWorkspaceId;
              return (
                <AgentConversationRow
                  key={conversation.id}
                  conversation={conversation}
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
        <div className="flex h-full flex-col bg-[var(--bg-panel)]">
          <div className="flex shrink-0 items-center gap-[8px] px-[11px] pt-[11px]">
            <button
              type="button"
              onClick={toggleLeftRailCollapsed}
              className="flex size-[18px] shrink-0 items-center justify-center rounded-[var(--radius-tab)] text-[var(--text-secondary)] transition-colors hover:bg-[var(--bg-card)] hover:text-[var(--text-primary)]"
              aria-label="Collapse workspace rail"
              title="Collapse workspace rail"
            >
              <PanelLeftClose className="size-[16px]" strokeWidth={1.5} />
            </button>
            <button
              type="button"
              onClick={() => setRecentChatsOpen(true)}
              className="flex size-[18px] shrink-0 items-center justify-center rounded-[var(--radius-tab)] text-[var(--text-secondary)] transition-colors hover:bg-[var(--bg-card)] hover:text-[var(--text-primary)]"
              aria-label="Search all chats"
              title="Search all chats"
            >
              <Search className="size-[16px]" strokeWidth={1.5} />
            </button>
            <button
              type="button"
              onClick={handleNewChat}
              className="ml-auto flex size-[18px] shrink-0 items-center justify-center rounded-[var(--radius-tab)] text-[var(--text-secondary)] transition-colors hover:bg-[var(--bg-card)] hover:text-[var(--text-primary)]"
              aria-label="Start new chat"
              title="Start new chat"
            >
              <Plus className="size-[16px]" strokeWidth={1.5} />
            </button>
          </div>

          {!leftRailCollapsed ? (
            <>
              <div className="hide-scrollbar-y flex min-h-0 flex-1 flex-col overflow-y-auto px-[11px] pb-[8px] pt-[12px]">
          {railLoading ? (
            <div className="flex min-h-[120px] items-center justify-center font-sans text-[13px] text-[var(--text-secondary)]">
              Loading chats...
            </div>
          ) : visibleGroups.length === 0 && pinnedRailConversations.length === 0 ? (
            <div className="flex min-h-[120px] items-center justify-center px-[10px] text-center font-sans text-[13px] text-[var(--text-secondary)]">
              No agent conversations yet.
            </div>
          ) : (
            <>
              {pinnedSection}
              {visibleGroups.map((group) => {
              const isWorkspaceCollapsed = collapsedWorkspaceIds.has(group.workspace.id);
              const { conversations } = group;
              return (
                <section key={group.workspace.id} className="pb-[12px]">
                  <div className="group flex items-center gap-[2px] px-px pb-[4px]">
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
                    <div className="flex flex-col gap-[2px]">
                      {conversations.length === 0 ? (
                        <button
                          type="button"
                          onClick={() => void handleNewChatForWorkspace(group.workspace.id)}
                          className="flex h-[30px] items-center gap-[8px] rounded-[var(--radius-tab)] px-[9px] text-left transition-colors hover:bg-[var(--bg-card)]"
                        >
                          <span className="size-[6px] shrink-0 rounded-full bg-[var(--text-disabled)]" />
                          <span className="truncate font-sans text-[13px] text-[var(--text-secondary)]">
                            Start a new chat
                          </span>
                        </button>
                      ) : (
                        conversations.map((conversation) => {
                          const selected =
                            conversation.id === selectedConversationId &&
                            conversation.workspaceId === activeWorkspaceId;
                          return (
                            <AgentConversationRow
                              key={conversation.id}
                              conversation={conversation}
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
                                  inPinnedSection: false,
                                })
                              }
                            />
                          );
                        })
                      )}
                    </div>
                  ) : null}
                </section>
              );
            })}
            </>
          )}
            </div>
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
                    railFilterActive ? "text-[var(--accent)]" : "text-[var(--text-secondary)]"
                  }`}
                  aria-label="Filter conversations"
                  aria-expanded={filterMenuOpen}
                  title={`Filter: ${filterSummary}`}
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
      />
    </>
  );
}
