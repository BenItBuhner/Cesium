"use client";

import {
  useState,
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  type KeyboardEvent,
  type MouseEvent,
} from "react";
import { createPortal } from "react-dom";
import { ChevronDown, ChevronRight, Columns2, Globe, MoreVertical, Plus, Rows2, Terminal } from "lucide-react";
import { EditorTab } from "./EditorTab";
import { useClickOutside } from "@/hooks/useClickOutside";
import { useTabStripWheel } from "@/hooks/useTabStripWheel";
import { CHAT_TAB_DND_MIME, parseChatTabDragPayload } from "@/lib/chat-tab-dnd";
import type {
  AgentTabIndicatorByConversationId,
  EditorTab as EditorTabType,
} from "@/lib/types";
import type { EditorGroup } from "./editor-panel-state";
import {
  TAB_DND_MIME,
  parseTabDragPayload,
  resolveTabGroupColorHex,
} from "./editor-panel-state";
import type {
  EditorSplitOrientation,
  EditorStripItem,
  EditorTabGroupState,
} from "@/lib/workspace-session";

interface EditorTabsProps {
  group: EditorGroup;
  tabs: EditorTabType[];
  stripItems: EditorStripItem[];
  tabGroups: Record<string, EditorTabGroupState>;
  activeTabId: string | null;
  splitActive: boolean;
  splitOrientation: EditorSplitOrientation;
  /** Left row only: split / join + overflow. Right row when split: overflow only. */
  showSplitToolbar: boolean;
  /** When true, add leading padding on the tab strip (iPadOS window controls). */
  padStripLeadingForWindowChrome?: boolean;
  onSelectTab: (id: string) => void;
  onCloseTab: (id: string) => void;
  onSplitRight: () => void;
  onSplitDown: () => void;
  onJoinGroups: () => void;
  onCloseAllTabs: () => void;
  onCloseOtherTabs: () => void;
  onMoveTabBetweenGroups: (tabId: string, from: EditorGroup, to: EditorGroup) => void;
  onOpenConversationTab?: (conversationId: string, group: EditorGroup) => void;
  onTabContextMenu?: (e: MouseEvent, tabId: string) => void;
  onStripContextMenu?: (e: MouseEvent) => void;
  onToggleTabGroupCollapsed?: (groupId: string) => void;
  onTabGroupContextMenu?: (e: MouseEvent, groupId: string) => void;
  /** When set, opens inline rename for that tab group (avoids `window.prompt`, which breaks in embedded/previews). */
  renameTabGroupId?: string | null;
  onCommitTabGroupRename?: (groupId: string, title: string) => void;
  onCancelTabGroupRename?: () => void;
  onAddTabToGroup?: (tabId: string, groupId: string) => void;
  onMoveTabToStripIndex?: (tabId: string, toIndex: number) => void;
  /** Agent chat tabs: permission pending / running; keyed by `conversationId`. */
  agentTabIndicators?: AgentTabIndicatorByConversationId;
  /** Reserve a trailing slot so an external pane-level control can occupy the far-right edge. */
  trailingSpacerWidthPx?: number;
  onOpenFilePalette?: () => void;
  onOpenTerminal?: () => void;
  onOpenBrowser?: () => void;
}

const MENU_W = 240;
const ADD_MENU_W = 200;

function findStripInsertIndex(root: HTMLElement, clientX: number): number {
  const children = [
    ...root.querySelectorAll("[data-strip-index]"),
  ] as HTMLElement[];
  if (children.length === 0) return 0;
  for (let i = 0; i < children.length; i++) {
    const r = children[i].getBoundingClientRect();
    const mid = r.left + r.width / 2;
    if (clientX < mid) return i;
  }
  return children.length;
}

export function EditorTabs({
  group,
  tabs,
  stripItems,
  tabGroups,
  activeTabId,
  splitActive,
  splitOrientation,
  showSplitToolbar,
  padStripLeadingForWindowChrome = false,
  onSelectTab,
  onCloseTab,
  onSplitRight,
  onSplitDown,
  onJoinGroups,
  onCloseAllTabs,
  onCloseOtherTabs,
  onMoveTabBetweenGroups,
  onOpenConversationTab,
  onTabContextMenu,
  onStripContextMenu,
  onToggleTabGroupCollapsed,
  onTabGroupContextMenu,
  renameTabGroupId = null,
  onCommitTabGroupRename,
  onCancelTabGroupRename,
  onAddTabToGroup,
  onMoveTabToStripIndex,
  agentTabIndicators,
  trailingSpacerWidthPx = 0,
  onOpenFilePalette,
  onOpenTerminal,
  onOpenBrowser,
}: EditorTabsProps) {
  const [menuOpen, setMenuOpen] = useState(false);
  const [menuPos, setMenuPos] = useState({ top: 0, left: 0 });
  const moreTriggerRef = useRef<HTMLDivElement>(null);
  const menuPopoverRef = useRef<HTMLDivElement>(null);
  const [addMenuOpen, setAddMenuOpen] = useState(false);
  const [addMenuPos, setAddMenuPos] = useState({ top: 0, left: 0 });
  const addTriggerRef = useRef<HTMLDivElement>(null);
  const addMenuPopoverRef = useRef<HTMLDivElement>(null);
  const stripRef = useRef<HTMLDivElement>(null);
  const dragScrollLastTs = useRef(0);
  const [editingGroupId, setEditingGroupId] = useState<string | null>(null);
  const [editGroupTitle, setEditGroupTitle] = useState("");
  const tabGroupRenameInputRef = useRef<HTMLInputElement>(null);

  useTabStripWheel(stripRef, { speed: 2.1 });

  useEffect(() => {
    if (!renameTabGroupId) {
      setEditingGroupId(null);
      setEditGroupTitle("");
      return;
    }
    const g = tabGroups[renameTabGroupId];
    if (!g) {
      onCancelTabGroupRename?.();
      return;
    }
    setEditingGroupId(renameTabGroupId);
    setEditGroupTitle(g.title);
    // Only re-seed when the rename target id changes — not when `tabGroups` identity updates during typing.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [renameTabGroupId]);

  useEffect(() => {
    if (!editingGroupId) {
      return;
    }
    const id = requestAnimationFrame(() => {
      tabGroupRenameInputRef.current?.focus();
      tabGroupRenameInputRef.current?.select();
    });
    return () => cancelAnimationFrame(id);
  }, [editingGroupId]);

  function commitTabGroupRename() {
    if (!editingGroupId) {
      return;
    }
    const gid = editingGroupId;
    const next = editGroupTitle.trim();
    setEditingGroupId(null);
    setEditGroupTitle("");
    if (next) {
      onCommitTabGroupRename?.(gid, next);
    } else {
      onCancelTabGroupRename?.();
    }
  }

  function cancelTabGroupRenameEditing() {
    setEditingGroupId(null);
    setEditGroupTitle("");
    onCancelTabGroupRename?.();
  }

  const closeMenu = useCallback(() => setMenuOpen(false), []);

  useLayoutEffect(() => {
    if (!menuOpen || !moreTriggerRef.current) return;
    const rect = moreTriggerRef.current.getBoundingClientRect();
    const left = Math.max(
      8,
      Math.min(rect.right - MENU_W, window.innerWidth - MENU_W - 8)
    );
    setMenuPos({ top: rect.bottom + 4, left });
  }, [menuOpen]);

  useClickOutside(moreTriggerRef, closeMenu, menuOpen, [menuPopoverRef]);

  const closeAddMenu = useCallback(() => setAddMenuOpen(false), []);

  useLayoutEffect(() => {
    if (!addMenuOpen || !addTriggerRef.current) return;
    const rect = addTriggerRef.current.getBoundingClientRect();
    const left = Math.max(
      8,
      Math.min(rect.right - ADD_MENU_W, window.innerWidth - ADD_MENU_W - 8)
    );
    setAddMenuPos({ top: rect.bottom + 4, left });
  }, [addMenuOpen]);

  useClickOutside(addTriggerRef, closeAddMenu, addMenuOpen, [addMenuPopoverRef]);

  const hasTabs = tabs.length > 0;
  const canCloseOthers = tabs.length > 1;
  const hasStripGroups = stripItems.some((it) => it.type === "group");
  const dragEnabled = splitActive || hasStripGroups || tabs.length >= 2;

  function handleStripDragOver(e: React.DragEvent) {
    const types = [...e.dataTransfer.types];
    const isTabDrag = types.includes(TAB_DND_MIME);
    const isChatTabDrag = types.includes(CHAT_TAB_DND_MIME);

    if ((dragEnabled || splitActive) && isTabDrag) {
      e.preventDefault();
      e.dataTransfer.dropEffect = "move";
    }

    if (isChatTabDrag && onOpenConversationTab) {
      e.preventDefault();
      e.dataTransfer.dropEffect = "move";
    }

    if ((!isTabDrag && !isChatTabDrag) || !stripRef.current) return;
    const scroller = stripRef.current;
    if (scroller.scrollWidth <= scroller.clientWidth + 1) return;

    const now = performance.now();
    if (now - dragScrollLastTs.current < 14) return;
    dragScrollLastTs.current = now;

    const rect = scroller.getBoundingClientRect();
    const x = e.clientX;
    const zone = 64;
    const maxDelta = 56;

    if (x < rect.left + zone) {
      const t = (rect.left + zone - x) / zone;
      scroller.scrollLeft -= maxDelta * t;
    } else if (x > rect.right - zone) {
      const t = (x - (rect.right - zone)) / zone;
      scroller.scrollLeft += maxDelta * t;
    }
  }

  function handleStripDrop(e: React.DragEvent) {
    const tabPayload = parseTabDragPayload(e.dataTransfer.getData(TAB_DND_MIME));
    if (tabPayload && tabPayload.group === group && dragEnabled) {
      const target = e.target as HTMLElement | null;
      const groupHost = target?.closest?.("[data-tab-group-id]");
      const groupIdAttr = groupHost?.getAttribute("data-tab-group-id");
      if (groupIdAttr && onAddTabToGroup && tabPayload.tabId !== undefined) {
        e.preventDefault();
        onAddTabToGroup(tabPayload.tabId, groupIdAttr);
        return;
      }
      if (stripRef.current && onMoveTabToStripIndex) {
        const dropIdx = findStripInsertIndex(stripRef.current, e.clientX);
        e.preventDefault();
        onMoveTabToStripIndex(tabPayload.tabId, dropIdx);
        return;
      }
    }

    if (splitActive && tabPayload) {
      e.preventDefault();
      if (tabPayload.group !== group) {
        onMoveTabBetweenGroups(tabPayload.tabId, tabPayload.group, group);
      }
      return;
    }

    const chatPayload = parseChatTabDragPayload(
      e.dataTransfer.getData(CHAT_TAB_DND_MIME)
    );
    if (chatPayload && onOpenConversationTab) {
      e.preventDefault();
      onOpenConversationTab(chatPayload.tabId, group);
    }
  }

  function renderTabButton(
    tab: EditorTabType,
    opts: {
      stripIndex: number;
      fromGroupId: string | null;
      nestedInGroup: boolean;
    }
  ) {
    const convId = tab.conversationId;
    const ind = convId ? agentTabIndicators?.[convId] : undefined;
    const needsAttention = Boolean(ind?.needsAttention);
    const running = Boolean(ind?.running) && !needsAttention;
    const unreadCompletion =
      Boolean(ind?.unreadCompletion) && !needsAttention && !running;
    return (
      <EditorTab
        key={`${opts.fromGroupId ?? "s"}-${tab.id}`}
        tab={tab}
        group={group}
        isActive={tab.id === activeTabId}
        dragEnabled={dragEnabled}
        stripIndex={opts.stripIndex}
        fromGroupId={opts.fromGroupId}
        nestedInGroup={opts.nestedInGroup}
        agentNeedsAttention={needsAttention}
        agentRunning={running}
        agentUnreadCompletion={unreadCompletion}
        onSelect={onSelectTab}
        onClose={onCloseTab}
        onContextMenu={
          onTabContextMenu ? (ev) => onTabContextMenu(ev, tab.id) : undefined
        }
      />
    );
  }

  return (
    <div className="flex h-[var(--tab-height)] items-center overflow-hidden bg-[var(--bg-panel)]">
      <div
        ref={stripRef}
        className={`hide-scrollbar-x flex min-h-[36px] min-w-0 flex-1 items-center gap-[4px] py-[2px] pr-[2px] ${
          padStripLeadingForWindowChrome
            ? "pl-[var(--editor-window-chrome-tab-inset)]"
            : "pl-[2px]"
        }`}
        onDragOver={handleStripDragOver}
        onDrop={handleStripDrop}
        onContextMenu={(e) => {
          if (e.target !== e.currentTarget) return;
          onStripContextMenu?.(e);
        }}
      >
        {stripItems.map((item, stripIndex) => {
          if (item.type === "tab") {
            const tab = tabs.find((t) => t.id === item.tabId);
            if (!tab) return null;
            return (
              <div
                key={`strip-tab-${item.tabId}`}
                data-strip-index={stripIndex}
                className="shrink-0"
              >
                {renderTabButton(tab, {
                  stripIndex,
                  fromGroupId: null,
                  nestedInGroup: false,
                })}
              </div>
            );
          }

          const g = tabGroups[item.groupId];
          if (!g) return null;
          const accent = resolveTabGroupColorHex(g.color);
          const groupActive =
            Boolean(activeTabId) && g.tabIds.includes(activeTabId!);
          const Chev = g.collapsed ? ChevronRight : ChevronDown;

          const accentRing = groupActive ? accent : `${accent}80`;
          return (
            <div
              key={`strip-group-${item.groupId}`}
              data-strip-index={stripIndex}
              className="flex shrink-0 items-stretch rounded-[var(--radius-tab)]"
              style={{
                boxShadow: `0 0 0 1px ${accentRing}, inset 0 0 0 1px var(--border-subtle)`,
                background: "var(--bg-tab-inactive)",
              }}
              data-tab-group-id={g.id}
              onDragOver={(e) => {
                if (dragEnabled && [...e.dataTransfer.types].includes(TAB_DND_MIME)) {
                  e.preventDefault();
                  e.dataTransfer.dropEffect = "move";
                }
              }}
              onDrop={(e) => {
                const p = parseTabDragPayload(e.dataTransfer.getData(TAB_DND_MIME));
                if (p && p.group === group && onAddTabToGroup) {
                  e.preventDefault();
                  e.stopPropagation();
                  onAddTabToGroup(p.tabId, g.id);
                }
              }}
            >
              <div className="flex min-h-[36px] flex-row items-stretch">
                <button
                  type="button"
                  data-tab-group-id={g.id}
                  onClick={() => {
                    if (editingGroupId === g.id) {
                      return;
                    }
                    onToggleTabGroupCollapsed?.(g.id);
                  }}
                  onContextMenu={(e) => {
                    e.stopPropagation();
                    onTabGroupContextMenu?.(e, g.id);
                  }}
                  className={`flex shrink-0 items-center gap-[4px] rounded-l-[var(--radius-tab)] px-[8px] font-sans text-[12px] transition-colors hover:bg-white/[0.06] ${
                    groupActive ? "text-[var(--text-primary)]" : "text-[var(--text-secondary)]"
                  }`}
                  aria-expanded={!g.collapsed}
                >
                  <Chev className="size-[14px] shrink-0 opacity-70" strokeWidth={1.5} />
                  {editingGroupId === g.id ? (
                    <input
                      ref={tabGroupRenameInputRef}
                      value={editGroupTitle}
                      aria-label="Tab group name"
                      className="max-w-[min(200px,calc(100%-22px))] min-w-[40px] shrink bg-transparent font-sans text-[12px] outline-none"
                      onClick={(e) => e.stopPropagation()}
                      onChange={(e) => setEditGroupTitle(e.target.value)}
                      onBlur={() => commitTabGroupRename()}
                      onKeyDown={(e: KeyboardEvent<HTMLInputElement>) => {
                        if (e.key === "Enter") {
                          e.preventDefault();
                          commitTabGroupRename();
                        } else if (e.key === "Escape") {
                          e.preventDefault();
                          cancelTabGroupRenameEditing();
                        }
                      }}
                    />
                  ) : (
                    <span className="max-w-[120px] truncate">{g.title}</span>
                  )}
                </button>
                {!g.collapsed &&
                  g.tabIds.map((tid) => {
                    const tab = tabs.find((t) => t.id === tid);
                    if (!tab) return null;
                    return (
                      <div key={`g-${g.id}-${tid}`} className="flex items-stretch">
                        {renderTabButton(tab, {
                          stripIndex,
                          fromGroupId: g.id,
                          nestedInGroup: true,
                        })}
                      </div>
                    );
                  })}
              </div>
            </div>
          );
        })}
        {tabs.length === 0 && splitActive && (
          <span className="px-[10px] font-sans text-[12px] text-[var(--text-disabled)]">
            Drop a tab here
          </span>
        )}
      </div>

      <div className="flex h-[var(--tab-height)] shrink-0 items-center gap-[4px] px-[11px]">
        {onOpenFilePalette && (
          <div ref={addTriggerRef} className="flex shrink-0 items-center gap-[4px]">
            <button
              type="button"
              onClick={() => {
                onOpenFilePalette();
                closeAddMenu();
              }}
              className="flex size-[28px] items-center justify-center rounded-[var(--radius-tab)] text-[var(--text-secondary)] transition-colors hover:bg-white/[0.04] hover:text-[var(--text-primary)]"
              aria-label="Open file"
            >
              <Plus className="size-[18px]" strokeWidth={1.5} aria-hidden />
            </button>
            {(onOpenTerminal || onOpenBrowser) && (
              <button
                type="button"
                onClick={() => setAddMenuOpen((o) => !o)}
                className="flex size-[28px] items-center justify-center rounded-[var(--radius-tab)] text-[var(--text-secondary)] transition-colors hover:bg-white/[0.04] hover:text-[var(--text-primary)]"
                aria-label="More new tab options"
                aria-expanded={addMenuOpen}
                aria-haspopup="menu"
              >
                <ChevronDown className="size-[14px]" strokeWidth={1.5} aria-hidden />
              </button>
            )}
          </div>
        )}
        {showSplitToolbar && (
          <button
            type="button"
            onClick={splitActive ? onJoinGroups : onSplitRight}
            className="flex size-[28px] shrink-0 items-center justify-center rounded-[var(--radius-tab)] text-[var(--text-secondary)] transition-colors hover:bg-white/[0.04] hover:text-[var(--text-primary)]"
            aria-label={splitActive ? "Join editor groups" : "Split editor to the right"}
            aria-pressed={splitActive}
          >
            <Columns2 className="size-[18px]" strokeWidth={1.5} aria-hidden />
          </button>
        )}

        <div ref={moreTriggerRef} className="flex size-[28px] shrink-0 items-center justify-center">
          <button
            type="button"
            onClick={() => setMenuOpen((o) => !o)}
            className="flex size-[28px] items-center justify-center rounded-[var(--radius-tab)] text-[var(--text-secondary)] transition-colors hover:bg-white/[0.04] hover:text-[var(--text-primary)]"
            aria-label="Editor group actions"
            aria-expanded={menuOpen}
            aria-haspopup="menu"
          >
            <MoreVertical className="size-[18px]" strokeWidth={1.5} aria-hidden />
          </button>
        </div>
        {trailingSpacerWidthPx > 0 ? (
          <div
            aria-hidden
            className="h-[18px] shrink-0"
            style={{ width: `${trailingSpacerWidthPx}px` }}
          />
        ) : null}
      </div>

      {addMenuOpen &&
        createPortal(
          <div
            ref={addMenuPopoverRef}
            role="menu"
            className="fixed z-[9999] w-[200px] rounded-[var(--radius-card)] border border-[var(--border-card)] bg-[var(--bg-panel)] py-[4px]"
            style={{ top: addMenuPos.top, left: addMenuPos.left }}
            onPointerDown={(e) => e.stopPropagation()}
          >
            {onOpenTerminal && (
              <button
                type="button"
                role="menuitem"
                onClick={() => {
                  onOpenTerminal();
                  closeAddMenu();
                }}
                className="flex w-full items-center gap-[8px] px-[12px] py-[6px] text-left font-sans text-[13px] text-[var(--text-primary)] transition-colors hover:bg-white/[0.06]"
              >
                <Terminal className="size-[14px] shrink-0 text-[var(--text-secondary)]" strokeWidth={1.5} />
                <span className="flex-1">New Terminal</span>
              </button>
            )}
            {onOpenBrowser && (
              <button
                type="button"
                role="menuitem"
                onClick={() => {
                  onOpenBrowser();
                  closeAddMenu();
                }}
                className="flex w-full items-center gap-[8px] px-[12px] py-[6px] text-left font-sans text-[13px] text-[var(--text-primary)] transition-colors hover:bg-white/[0.06]"
              >
                <Globe className="size-[14px] shrink-0 text-[var(--text-secondary)]" strokeWidth={1.5} />
                <span className="flex-1">New Browser Tab</span>
              </button>
            )}
          </div>,
          document.body
        )}

      {menuOpen &&
        createPortal(
          <div
            ref={menuPopoverRef}
            role="menu"
            className="fixed z-[9999] w-[240px] rounded-[var(--radius-card)] border border-[var(--border-card)] bg-[var(--bg-panel)] py-[4px]"
            style={{ top: menuPos.top, left: menuPos.left }}
            onPointerDown={(e) => e.stopPropagation()}
          >
            {splitActive && (
              <>
                <button
                  type="button"
                  role="menuitem"
                  onClick={() => {
                    onJoinGroups();
                    closeMenu();
                  }}
                  className="flex w-full items-center gap-[8px] px-[12px] py-[6px] text-left font-sans text-[13px] text-[var(--text-primary)] transition-colors hover:bg-white/[0.06]"
                >
                  <Columns2 className="size-[14px] shrink-0 text-[var(--text-secondary)]" strokeWidth={1.5} />
                  <span className="flex-1">Join Editor Groups</span>
                </button>
                <button
                  type="button"
                  role="menuitem"
                  disabled={splitOrientation === "horizontal"}
                  onClick={() => {
                    if (splitOrientation !== "horizontal") {
                      onSplitRight();
                    }
                    closeMenu();
                  }}
                  className="flex w-full items-center gap-[8px] px-[12px] py-[6px] text-left font-sans text-[13px] text-[var(--text-primary)] transition-colors hover:bg-white/[0.06] disabled:cursor-not-allowed disabled:opacity-40"
                >
                  <Columns2
                    className="size-[14px] shrink-0 text-[var(--text-secondary)]"
                    strokeWidth={1.5}
                  />
                  <span className="flex-1">Use Side-by-side Layout</span>
                </button>
                <button
                  type="button"
                  role="menuitem"
                  disabled={splitOrientation === "vertical"}
                  onClick={() => {
                    if (splitOrientation !== "vertical") {
                      onSplitDown();
                    }
                    closeMenu();
                  }}
                  className="flex w-full items-center gap-[8px] px-[12px] py-[6px] text-left font-sans text-[13px] text-[var(--text-primary)] transition-colors hover:bg-white/[0.06] disabled:cursor-not-allowed disabled:opacity-40"
                >
                  <Rows2
                    className="size-[14px] shrink-0 text-[var(--text-secondary)]"
                    strokeWidth={1.5}
                  />
                  <span className="flex-1">Use Stacked Layout</span>
                </button>
                <div className="my-[4px] h-px bg-[var(--border-subtle)]" aria-hidden />
              </>
            )}
            {!splitActive && showSplitToolbar && (
              <>
                <button
                  type="button"
                  role="menuitem"
                  onClick={() => {
                    onSplitRight();
                    closeMenu();
                  }}
                  className="flex w-full items-center gap-[8px] px-[12px] py-[6px] text-left font-sans text-[13px] text-[var(--text-primary)] transition-colors hover:bg-white/[0.06]"
                >
                  <Columns2 className="size-[14px] shrink-0 text-[var(--text-secondary)]" strokeWidth={1.5} />
                  <span className="flex-1">Split Editor Right</span>
                </button>
                <button
                  type="button"
                  role="menuitem"
                  onClick={() => {
                    onSplitDown();
                    closeMenu();
                  }}
                  className="flex w-full items-center gap-[8px] px-[12px] py-[6px] text-left font-sans text-[13px] text-[var(--text-primary)] transition-colors hover:bg-white/[0.06]"
                >
                  <Rows2 className="size-[14px] shrink-0 text-[var(--text-secondary)]" strokeWidth={1.5} />
                  <span className="flex-1">Split Editor Down</span>
                </button>
                <div className="my-[4px] h-px bg-[var(--border-subtle)]" aria-hidden />
              </>
            )}

            <button
              type="button"
              role="menuitem"
              disabled={!canCloseOthers}
              onClick={() => {
                if (canCloseOthers) onCloseOtherTabs();
                closeMenu();
              }}
              className="flex w-full px-[12px] py-[6px] text-left font-sans text-[13px] text-[var(--text-primary)] transition-colors hover:bg-white/[0.06] disabled:cursor-not-allowed disabled:opacity-40"
            >
              Close Other Editors in Group
            </button>
            <button
              type="button"
              role="menuitem"
              disabled={!hasTabs}
              onClick={() => {
                if (hasTabs) onCloseAllTabs();
                closeMenu();
              }}
              className="flex w-full px-[12px] py-[6px] text-left font-sans text-[13px] text-[var(--text-primary)] transition-colors hover:bg-white/[0.06] disabled:cursor-not-allowed disabled:opacity-40"
            >
              Close All Editors in Group
            </button>
          </div>,
          document.body
        )}
    </div>
  );
}
