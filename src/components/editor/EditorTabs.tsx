"use client";

import { useState, useCallback, useLayoutEffect, useRef, type MouseEvent } from "react";
import { createPortal } from "react-dom";
import { Columns2, MoreVertical, Rows2 } from "lucide-react";
import { EditorTab } from "./EditorTab";
import { useClickOutside } from "@/hooks/useClickOutside";
import { useTabStripWheel } from "@/hooks/useTabStripWheel";
import type { EditorTab as EditorTabType } from "@/lib/types";
import type { EditorGroup } from "./editor-panel-state";
import { TAB_DND_MIME, parseTabDragPayload } from "./editor-panel-state";
import type { EditorSplitOrientation } from "@/lib/workspace-session";

interface EditorTabsProps {
  group: EditorGroup;
  tabs: EditorTabType[];
  activeTabId: string | null;
  splitActive: boolean;
  splitOrientation: EditorSplitOrientation;
  /** Left row only: split / join + overflow. Right row when split: overflow only. */
  showSplitToolbar: boolean;
  onSelectTab: (id: string) => void;
  onCloseTab: (id: string) => void;
  onSplitRight: () => void;
  onSplitDown: () => void;
  onJoinGroups: () => void;
  onCloseAllTabs: () => void;
  onCloseOtherTabs: () => void;
  onMoveTabBetweenGroups: (tabId: string, from: EditorGroup, to: EditorGroup) => void;
  onTabContextMenu?: (e: MouseEvent, tabId: string) => void;
  onStripContextMenu?: (e: MouseEvent) => void;
}

const MENU_W = 240;

export function EditorTabs({
  group,
  tabs,
  activeTabId,
  splitActive,
  splitOrientation,
  showSplitToolbar,
  onSelectTab,
  onCloseTab,
  onSplitRight,
  onSplitDown,
  onJoinGroups,
  onCloseAllTabs,
  onCloseOtherTabs,
  onMoveTabBetweenGroups,
  onTabContextMenu,
  onStripContextMenu,
}: EditorTabsProps) {
  const [menuOpen, setMenuOpen] = useState(false);
  const [menuPos, setMenuPos] = useState({ top: 0, left: 0 });
  const moreTriggerRef = useRef<HTMLDivElement>(null);
  const menuPopoverRef = useRef<HTMLDivElement>(null);
  const stripRef = useRef<HTMLDivElement>(null);
  const dragScrollLastTs = useRef(0);

  useTabStripWheel(stripRef, { speed: 2.1 });

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

  const hasTabs = tabs.length > 0;
  const canCloseOthers = tabs.length > 1;

  function handleStripDragOver(e: React.DragEvent) {
    const types = [...e.dataTransfer.types];
    const isTabDrag = types.includes(TAB_DND_MIME);

    if (splitActive && isTabDrag) {
      e.preventDefault();
      e.dataTransfer.dropEffect = "move";
    }

    if (!isTabDrag || !stripRef.current) return;
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
    if (!splitActive) return;
    e.preventDefault();
    const payload = parseTabDragPayload(e.dataTransfer.getData(TAB_DND_MIME));
    if (!payload || payload.group === group) return;
    onMoveTabBetweenGroups(payload.tabId, payload.group, group);
  }

  return (
    <div className="flex h-[var(--tab-height)] items-center overflow-hidden bg-[var(--bg-panel)]">
      <div
        ref={stripRef}
        className="hide-scrollbar-x flex min-h-[36px] min-w-0 flex-1 items-center gap-0 p-[2px]"
        onDragOver={handleStripDragOver}
        onDrop={handleStripDrop}
        onContextMenu={(e) => {
          if (e.target !== e.currentTarget) return;
          onStripContextMenu?.(e);
        }}
      >
        {tabs.map((tab) => (
          <EditorTab
            key={tab.id}
            tab={tab}
            group={group}
            isActive={tab.id === activeTabId}
            dragEnabled={splitActive}
            onSelect={onSelectTab}
            onClose={onCloseTab}
            onContextMenu={
              onTabContextMenu ? (ev) => onTabContextMenu(ev, tab.id) : undefined
            }
          />
        ))}
        {tabs.length === 0 && splitActive && (
          <span className="px-[10px] font-sans text-[12px] text-[var(--text-disabled)]">
            Drop a tab here
          </span>
        )}
      </div>

      <div className="flex h-[var(--tab-height)] shrink-0 items-center gap-[8px] px-[11px]">
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
      </div>

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
