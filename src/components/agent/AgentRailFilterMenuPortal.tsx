"use client";

import {
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type RefObject,
} from "react";
import { createPortal } from "react-dom";
import {
  AGENT_RAIL_FILTER_TOGGLE_KEYS,
  type AgentRailFilterToggleKey,
  type AgentRailFilterToggleState,
} from "@/lib/agent-rail";
import { useClickOutside } from "@/hooks/useClickOutside";
import {
  popoverMenuAccentActionClass,
  popoverMenuFormRowClass,
  popoverMenuListClass,
  popoverMenuPanelClass,
  popoverMenuSectionLabelClass,
  popoverMenuSeparatorClass,
} from "@/components/ui/popover-menu-ui";
import type { WorkspaceSortMode } from "@/lib/global-settings";
import type { AgentRailGroupByMode, AgentRailSectionId } from "@/lib/global-settings";
import { AGENT_RAIL_SECTION_IDS } from "@/lib/global-settings";
const FILTER_TOGGLE_LABELS: Record<AgentRailFilterToggleKey, string> = {
  archived: "Archived",
  running: "Running",
  needs_attention: "Needs attention",
  pinned: "Pinned",
  unread: "Unread",
  read: "Read",
  external: "External sources",
};

const WORKSPACE_SORT_OPTIONS: Array<{ value: WorkspaceSortMode; label: string }> = [
  { value: "recent", label: "Recently opened" },
  { value: "alphabetical", label: "Alphabetical" },
  { value: "custom", label: "Custom order" },
];

const GROUP_BY_OPTIONS: Array<{ value: AgentRailGroupByMode; label: string }> = [
  { value: "workspace", label: "Workspace" },
  { value: "repository", label: "Repository" },
  { value: "updated", label: "Updated" },
  { value: "status", label: "Status" },
];

type AgentRailFilterMenuPortalProps = {
  open: boolean;
  onClose: () => void;
  anchorRef: RefObject<HTMLElement | null>;
  railFilterToggles: AgentRailFilterToggleState;
  setRailFilterToggle: (key: AgentRailFilterToggleKey, value: boolean) => void;
  clearRailFilters: () => void;
  railFilterActive: boolean;
  workspaceSortMode: WorkspaceSortMode;
  setWorkspaceSortMode: (mode: WorkspaceSortMode) => void;
  workspaceCustomOrderActive: boolean;
  resetWorkspaceCustomOrder: () => void;
  groupBy: AgentRailGroupByMode;
  setGroupBy: (mode: AgentRailGroupByMode) => void;
  showIcons: boolean;
  setShowIcons: (value: boolean) => void;
  sectionOrder: AgentRailSectionId[];
  hiddenSections: AgentRailSectionId[];
  setSectionOrder: (order: AgentRailSectionId[]) => void;
  setSectionHidden: (sectionId: AgentRailSectionId, hidden: boolean) => void;
};

const SECTION_LABELS: Record<AgentRailSectionId, string> = {
  pinned: "Pinned",
  chats: "Chats",
  workspaces: "Workspaces",
};

export function AgentRailFilterMenuPortal({
  open,
  onClose,
  anchorRef,
  railFilterToggles,
  setRailFilterToggle,
  clearRailFilters,
  railFilterActive,
  workspaceSortMode,
  setWorkspaceSortMode,
  workspaceCustomOrderActive,
  resetWorkspaceCustomOrder,
  groupBy,
  setGroupBy,
  showIcons,
  setShowIcons,
  sectionOrder,
  hiddenSections,
  setSectionOrder,
  setSectionHidden,
}: AgentRailFilterMenuPortalProps) {
  const filterPanelRef = useRef<HTMLDivElement>(null);
  const [filterMenuPos, setFilterMenuPos] = useState({ top: 0, left: 0 });

  useLayoutEffect(() => {
    if (!open || !anchorRef.current) {
      return;
    }

    const updatePosition = () => {
      const anchor = anchorRef.current;
      const panel = filterPanelRef.current;
      if (!anchor || !panel) {
        return;
      }
      const r = anchor.getBoundingClientRect();
      const GAP = 6;
      const MARGIN = 8;
      const rect = panel.getBoundingClientRect();
      const h = rect.height;
      const w = rect.width;

      let top = r.bottom + GAP;
      if (top + h > window.innerHeight - MARGIN) {
        top = r.top - h - GAP;
      }
      top = Math.min(top, window.innerHeight - h - MARGIN);
      top = Math.max(MARGIN, top);

      let left = r.left;
      if (left + w > window.innerWidth - MARGIN) {
        left = window.innerWidth - w - MARGIN;
      }
      left = Math.max(MARGIN, left);

      setFilterMenuPos({ top, left });
    };

    updatePosition();
    window.addEventListener("resize", updatePosition);
    window.addEventListener("scroll", updatePosition, true);
    return () => {
      window.removeEventListener("resize", updatePosition);
      window.removeEventListener("scroll", updatePosition, true);
    };
  }, [open, anchorRef]);

  useClickOutside(filterPanelRef, onClose, open, [anchorRef]);

  useEffect(() => {
    if (!open) {
      return;
    }
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        onClose();
      }
    };
    document.addEventListener("keydown", onKey, true);
    return () => document.removeEventListener("keydown", onKey, true);
  }, [open, onClose]);

  if (!open) {
    return null;
  }

  return createPortal(
    <div
      ref={filterPanelRef}
      role="dialog"
      aria-label="Workspace sorting and conversation filters"
      className={`fixed z-[10040] min-w-[236px] transition-opacity ${popoverMenuPanelClass}`}
      style={{ top: filterMenuPos.top, left: filterMenuPos.left }}
      onPointerDown={(e) => e.stopPropagation()}
    >
      <div className={popoverMenuListClass}>
      <div className={popoverMenuSectionLabelClass}>Group by</div>
      <div className="flex flex-col" onPointerDown={(e) => e.stopPropagation()}>
        {GROUP_BY_OPTIONS.map((option) => (
          <label
            key={option.value}
            className={popoverMenuFormRowClass}
          >
            <input
              type="radio"
              name="agent-rail-group-by"
              checked={groupBy === option.value}
              onChange={() => setGroupBy(option.value)}
              className="size-[14px] shrink-0 border border-[var(--border-subtle)] accent-[var(--accent)]"
            />
            <span className="min-w-0 flex-1">{option.label}</span>
          </label>
        ))}
      </div>
      <div className={popoverMenuSeparatorClass} />
      <div className={popoverMenuSectionLabelClass}>Sort workspaces</div>
      <div className="flex flex-col" onPointerDown={(e) => e.stopPropagation()}>
        {WORKSPACE_SORT_OPTIONS.map((option) => (
          <label
            key={option.value}
            className={popoverMenuFormRowClass}
          >
            <input
              type="radio"
              name="agent-rail-workspace-sort"
              checked={workspaceSortMode === option.value}
              onChange={() => setWorkspaceSortMode(option.value)}
              className="size-[14px] shrink-0 border border-[var(--border-subtle)] accent-[var(--accent)]"
            />
            <span className="min-w-0 flex-1">{option.label}</span>
          </label>
        ))}
      </div>
      <button
        type="button"
        disabled={!workspaceCustomOrderActive}
        onClick={() => resetWorkspaceCustomOrder()}
        className={popoverMenuAccentActionClass}
      >
        Reset custom order
      </button>
      <div className={popoverMenuSeparatorClass} />
      <div className={popoverMenuSectionLabelClass}>Display</div>
      <div className="flex flex-col" onPointerDown={(e) => e.stopPropagation()}>
        <label className={popoverMenuFormRowClass}>
          <input
            type="checkbox"
            checked={showIcons}
            onChange={(ev) => setShowIcons(ev.target.checked)}
            className="size-[14px] shrink-0 rounded border border-[var(--border-subtle)] accent-[var(--accent)]"
          />
          <span className="min-w-0 flex-1">Show icons</span>
        </label>
      </div>
      <div className={popoverMenuSeparatorClass} />
      <div className={popoverMenuSectionLabelClass}>Rail sections</div>
      <div className="flex flex-col gap-[2px]" onPointerDown={(e) => e.stopPropagation()}>
        {AGENT_RAIL_SECTION_IDS.map((sectionId) => {
          const hidden = hiddenSections.includes(sectionId);
          const canHide = sectionId !== "workspaces";
          const index = sectionOrder.indexOf(sectionId);
          return (
            <div key={sectionId} className={`${popoverMenuFormRowClass} gap-[6px]`}>
              {canHide ? (
                <input
                  type="checkbox"
                  checked={!hidden}
                  onChange={(ev) => setSectionHidden(sectionId, !ev.target.checked)}
                  className="size-[14px] shrink-0 rounded border border-[var(--border-subtle)] accent-[var(--accent)]"
                  aria-label={`Show ${SECTION_LABELS[sectionId]}`}
                />
              ) : (
                <span className="size-[14px] shrink-0" />
              )}
              <span className="min-w-0 flex-1">{SECTION_LABELS[sectionId]}</span>
              <button
                type="button"
                disabled={index <= 0}
                onClick={() => {
                  if (index <= 0) return;
                  const next = [...sectionOrder];
                  const prev = next[index - 1]!;
                  next[index - 1] = sectionId;
                  next[index] = prev;
                  setSectionOrder(next);
                }}
                className="rounded px-[4px] text-[11px] text-[var(--text-secondary)] disabled:opacity-30 hover:bg-[var(--accent-bg)] hover:text-[var(--text-primary)]"
                aria-label={`Move ${SECTION_LABELS[sectionId]} up`}
              >
                Up
              </button>
              <button
                type="button"
                disabled={index < 0 || index >= sectionOrder.length - 1}
                onClick={() => {
                  if (index < 0 || index >= sectionOrder.length - 1) return;
                  const next = [...sectionOrder];
                  const after = next[index + 1]!;
                  next[index + 1] = sectionId;
                  next[index] = after;
                  setSectionOrder(next);
                }}
                className="rounded px-[4px] text-[11px] text-[var(--text-secondary)] disabled:opacity-30 hover:bg-[var(--accent-bg)] hover:text-[var(--text-primary)]"
                aria-label={`Move ${SECTION_LABELS[sectionId]} down`}
              >
                Down
              </button>
            </div>
          );
        })}
      </div>
      <div className={popoverMenuSeparatorClass} />
      <div className={popoverMenuSectionLabelClass}>Filter conversations</div>
      <div className="flex flex-col" onPointerDown={(e) => e.stopPropagation()}>
        {AGENT_RAIL_FILTER_TOGGLE_KEYS.map((key) => (
          <label
            key={key}
            className={popoverMenuFormRowClass}
          >
            <input
              type="checkbox"
              checked={railFilterToggles[key]}
              onChange={(ev) => setRailFilterToggle(key, ev.target.checked)}
              className="size-[14px] shrink-0 rounded border border-[var(--border-subtle)] accent-[var(--accent)]"
            />
            <span className="min-w-0 flex-1">{FILTER_TOGGLE_LABELS[key]}</span>
          </label>
        ))}
      </div>
      <div className={popoverMenuSeparatorClass} />
      <button
        type="button"
        disabled={!railFilterActive}
        onClick={() => clearRailFilters()}
        className={popoverMenuAccentActionClass}
      >
        Clear all filters
      </button>
      </div>
    </div>,
    document.body
  );
}
