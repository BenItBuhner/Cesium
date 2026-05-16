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
import type { WorkspaceSortMode } from "@/lib/global-settings";

const FILTER_TOGGLE_LABELS: Record<AgentRailFilterToggleKey, string> = {
  archived: "Archived",
  running: "Running",
  needs_attention: "Needs attention",
  pinned: "Pinned",
  unread: "Unread",
  read: "Read",
};

const WORKSPACE_SORT_OPTIONS: Array<{ value: WorkspaceSortMode; label: string }> = [
  { value: "recent", label: "Recently opened" },
  { value: "alphabetical", label: "Alphabetical" },
  { value: "custom", label: "Custom order" },
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
      className="fixed z-[10040] min-w-[236px] rounded-[var(--radius-card)] border border-[var(--border-card)] bg-[var(--bg-panel)] py-[4px] transition-opacity"
      style={{ top: filterMenuPos.top, left: filterMenuPos.left }}
      onPointerDown={(e) => e.stopPropagation()}
    >
      <div className="px-[12px] pb-[3px] pt-[6px] font-sans text-[10px] font-medium uppercase tracking-[0.06em] text-[var(--text-disabled)]">
        Sort workspaces
      </div>
      <div className="flex flex-col" onPointerDown={(e) => e.stopPropagation()}>
        {WORKSPACE_SORT_OPTIONS.map((option) => (
          <label
            key={option.value}
            className="flex cursor-pointer items-center gap-[8px] px-[12px] py-[5px] font-sans text-[13px] font-normal text-[var(--text-primary)] transition-colors hover:bg-white/[0.06]"
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
        className="flex w-full cursor-default items-center px-[12px] py-[5px] text-left font-sans text-[13px] font-normal text-[var(--accent)] transition-colors hover:bg-white/[0.06] disabled:cursor-not-allowed disabled:opacity-40"
      >
        Reset custom order
      </button>
      <div className="my-[4px] h-px bg-[var(--border-subtle)]" />
      <div className="px-[12px] pb-[3px] pt-[2px] font-sans text-[10px] font-medium uppercase tracking-[0.06em] text-[var(--text-disabled)]">
        Filter conversations
      </div>
      <div className="flex flex-col" onPointerDown={(e) => e.stopPropagation()}>
        {AGENT_RAIL_FILTER_TOGGLE_KEYS.map((key) => (
          <label
            key={key}
            className="flex cursor-pointer items-center gap-[8px] px-[12px] py-[5px] font-sans text-[13px] font-normal text-[var(--text-primary)] transition-colors hover:bg-white/[0.06]"
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
      <div className="my-[4px] h-px bg-[var(--border-subtle)]" />
      <button
        type="button"
        disabled={!railFilterActive}
        onClick={() => clearRailFilters()}
        className="flex w-full cursor-default items-center px-[12px] py-[5px] text-left font-sans text-[13px] font-normal text-[var(--accent)] transition-colors hover:bg-white/[0.06] disabled:cursor-not-allowed disabled:opacity-40"
      >
        Clear all filters
      </button>
    </div>,
    document.body
  );
}
