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

const FILTER_TOGGLE_LABELS: Record<AgentRailFilterToggleKey, string> = {
  archived: "Archived",
  running: "Running",
  needs_attention: "Needs attention",
  pinned: "Pinned",
  unread: "Unread",
  read: "Read",
};

type AgentRailFilterMenuPortalProps = {
  open: boolean;
  onClose: () => void;
  anchorRef: RefObject<HTMLElement | null>;
  railFilterToggles: AgentRailFilterToggleState;
  setRailFilterToggle: (key: AgentRailFilterToggleKey, value: boolean) => void;
  clearRailFilters: () => void;
  railFilterActive: boolean;
};

export function AgentRailFilterMenuPortal({
  open,
  onClose,
  anchorRef,
  railFilterToggles,
  setRailFilterToggle,
  clearRailFilters,
  railFilterActive,
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
      aria-label="Conversation filters"
      className="fixed z-[10040] min-w-[232px] rounded-[var(--radius-card)] border border-[var(--border-card)] bg-[var(--bg-card)] py-[6px] shadow-[0_8px_24px_rgba(0,0,0,0.12)] dark:shadow-[0_10px_28px_rgba(0,0,0,0.45)]"
      style={{ top: filterMenuPos.top, left: filterMenuPos.left }}
    >
      <div className="px-[10px] pb-[4px] pt-[2px] font-sans text-[11px] font-medium uppercase tracking-wide text-[var(--text-disabled)]">
        Show conversations
      </div>
      <div className="flex flex-col" onPointerDown={(e) => e.stopPropagation()}>
        {AGENT_RAIL_FILTER_TOGGLE_KEYS.map((key) => (
          <label
            key={key}
            className="flex cursor-pointer items-center gap-[8px] px-[10px] py-[5px] font-sans text-[13px] text-[var(--text-primary)] transition-colors hover:bg-[var(--accent-bg)]"
          >
            <input
              type="checkbox"
              checked={railFilterToggles[key]}
              onChange={(ev) => setRailFilterToggle(key, ev.target.checked)}
              className="size-[14px] shrink-0 rounded border border-[var(--border-subtle)] accent-[var(--accent)]"
            />
            <span>{FILTER_TOGGLE_LABELS[key]}</span>
          </label>
        ))}
      </div>
      <div className="mx-[8px] my-[6px] h-px bg-[var(--border-subtle)]" />
      <button
        type="button"
        disabled={!railFilterActive}
        onClick={() => clearRailFilters()}
        className="mx-[6px] rounded-[var(--radius-tab)] px-[8px] py-[6px] text-left font-sans text-[12px] text-[var(--accent)] transition-colors hover:bg-[var(--accent-bg)] disabled:cursor-not-allowed disabled:opacity-40"
      >
        Clear all filters
      </button>
    </div>,
    document.body
  );
}
