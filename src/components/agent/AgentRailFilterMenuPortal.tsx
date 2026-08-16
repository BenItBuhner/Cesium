"use client";

import {
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type ReactNode,
  type RefObject,
} from "react";
import { createPortal } from "react-dom";
import type { AgentRailFilterToggleKey, AgentRailFilterToggleState } from "@/lib/agent-rail";
import { useClickOutside } from "@/hooks/useClickOutside";
import {
  popoverMenuListClass,
  popoverMenuPanelClass,
  popoverMenuSectionLabelClass,
  popoverMenuSeparatorClass,
} from "@/components/ui/popover-menu-ui";
import type {
  AgentRailGroupByMode,
  AgentRailSectionId,
  AgentRailViewPreset,
} from "@/lib/global-settings";
import type { AgentRailRowDetailMode } from "@/lib/agent-rail-status";

const FILTER_TOGGLE_KEYS = ["archived", "unread"] as const satisfies AgentRailFilterToggleKey[];

const FILTER_TOGGLE_LABELS: Record<(typeof FILTER_TOGGLE_KEYS)[number], string> = {
  archived: "Archived",
  unread: "Unread",
};

const GROUP_BY_OPTIONS: Array<{
  value: AgentRailGroupByMode;
  label: string;
  hint: string;
}> = [
  { value: "workspace", label: "Workspace", hint: "Grouped by workspace" },
  { value: "priority", label: "Priority", hint: "One list, urgent first" },
];

const ROW_DETAIL_OPTIONS: Array<{
  value: AgentRailRowDetailMode;
  label: string;
  hint: string;
}> = [
  { value: "compact", label: "Compact", hint: "Titles and status dots only" },
  { value: "balanced", label: "Balanced", hint: "Detail only when something needs you" },
  { value: "expanded", label: "Expanded", hint: "Every row shows status or time" },
];

const PRESET_OPTIONS: Array<{ value: AgentRailViewPreset; label: string }> = [
  { value: "default", label: "Default" },
  { value: "inbox", label: "Inbox" },
  { value: "compact", label: "Compact" },
];

const SECTION_LABELS: Record<Extract<AgentRailSectionId, "attention" | "pinned">, string> = {
  attention: "Needs attention",
  pinned: "Pinned",
};

function OptionPill({
  active,
  label,
  onSelect,
  title,
}: {
  active: boolean;
  label: string;
  onSelect: () => void;
  title?: string;
}) {
  return (
    <button
      type="button"
      onClick={onSelect}
      title={title}
      aria-pressed={active}
      className={`rounded-full border px-[9px] py-[3px] font-sans text-[11.5px] leading-[15px] transition-colors ${
        active
          ? "border-transparent bg-[var(--accent)] text-[var(--bg-panel)]"
          : "border-[var(--border-subtle)] text-[var(--text-secondary)] hover:bg-[var(--accent-bg)] hover:text-[var(--text-primary)]"
      }`}
    >
      {label}
    </button>
  );
}

function PillRow({ children }: { children: ReactNode }) {
  return (
    <div
      className="flex flex-wrap gap-[5px] px-[10px] py-[3px]"
      onPointerDown={(e) => e.stopPropagation()}
    >
      {children}
    </div>
  );
}

function HintLine({ text }: { text: string }) {
  return (
    <div className="px-[10px] pb-[4px] pt-[3px] font-sans text-[10.5px] leading-[14px] text-[var(--text-disabled)]">
      {text}
    </div>
  );
}

type AgentRailFilterMenuPortalProps = {
  open: boolean;
  onClose: () => void;
  anchorRef: RefObject<HTMLElement | null>;
  railFilterToggles: AgentRailFilterToggleState;
  setRailFilterToggle: (key: AgentRailFilterToggleKey, value: boolean) => void;
  clearRailFilters: () => void;
  railFilterActive: boolean;
  groupBy: AgentRailGroupByMode;
  setGroupBy: (mode: AgentRailGroupByMode) => void;
  showIcons: boolean;
  setShowIcons: (value: boolean) => void;
  rowDetail: AgentRailRowDetailMode;
  setRowDetail: (mode: AgentRailRowDetailMode) => void;
  hiddenSections: AgentRailSectionId[];
  setSectionHidden: (sectionId: AgentRailSectionId, hidden: boolean) => void;
  viewPreset: AgentRailViewPreset | null;
  onSelectPreset: (preset: AgentRailViewPreset) => void;
};

export function AgentRailFilterMenuPortal({
  open,
  onClose,
  anchorRef,
  railFilterToggles,
  setRailFilterToggle,
  clearRailFilters,
  railFilterActive,
  groupBy,
  setGroupBy,
  showIcons,
  setShowIcons,
  rowDetail,
  setRowDetail,
  hiddenSections,
  setSectionHidden,
  viewPreset,
  onSelectPreset,
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

  const groupByHint = GROUP_BY_OPTIONS.find((option) => option.value === groupBy)?.hint;
  const rowDetailHint = ROW_DETAIL_OPTIONS.find(
    (option) => option.value === rowDetail
  )?.hint;
  const priorityMode = groupBy === "priority";
  const visibleFilterCount = FILTER_TOGGLE_KEYS.filter((key) => railFilterToggles[key]).length;

  return createPortal(
    <div
      ref={filterPanelRef}
      role="dialog"
      aria-label="Rail view and conversation filters"
      className={`fixed z-[10040] w-[248px] transition-opacity ${popoverMenuPanelClass}`}
      style={{ top: filterMenuPos.top, left: filterMenuPos.left }}
      onPointerDown={(e) => e.stopPropagation()}
    >
      <div className={popoverMenuListClass}>
        <div className={popoverMenuSectionLabelClass}>Preset</div>
        <PillRow>
          {PRESET_OPTIONS.map((option) => (
            <OptionPill
              key={option.value}
              active={viewPreset === option.value}
              label={option.label}
              onSelect={() => onSelectPreset(option.value)}
            />
          ))}
        </PillRow>

        <div className={popoverMenuSectionLabelClass}>Group by</div>
        <PillRow>
          {GROUP_BY_OPTIONS.map((option) => (
            <OptionPill
              key={option.value}
              active={groupBy === option.value}
              label={option.label}
              title={option.hint}
              onSelect={() => setGroupBy(option.value)}
            />
          ))}
        </PillRow>
        {groupByHint ? <HintLine text={groupByHint} /> : null}

        <div className={popoverMenuSectionLabelClass}>Row detail</div>
        <PillRow>
          {ROW_DETAIL_OPTIONS.map((option) => (
            <OptionPill
              key={option.value}
              active={rowDetail === option.value}
              label={option.label}
              title={option.hint}
              onSelect={() => setRowDetail(option.value)}
            />
          ))}
        </PillRow>
        {rowDetailHint ? <HintLine text={rowDetailHint} /> : null}

        <div className={popoverMenuSeparatorClass} />
        <div className={popoverMenuSectionLabelClass}>Sections</div>
        <div className="flex flex-col" onPointerDown={(e) => e.stopPropagation()}>
          {(["attention", "pinned"] as const).map((sectionId) => {
            const hidden = hiddenSections.includes(sectionId);
            const foldedByPriority = priorityMode && sectionId === "attention";
            return (
              <label
                key={sectionId}
                className={`flex cursor-pointer items-center gap-[8px] rounded-[var(--radius-tab)] px-[10px] py-[3.5px] font-sans text-[12.5px] text-[var(--text-primary)] hover:bg-[var(--accent-bg)] ${
                  foldedByPriority ? "opacity-45" : ""
                }`}
                title={
                  foldedByPriority
                    ? "Folded into the priority list while grouping by priority"
                    : undefined
                }
              >
                <input
                  type="checkbox"
                  checked={!hidden}
                  disabled={foldedByPriority}
                  onChange={(ev) => setSectionHidden(sectionId, !ev.target.checked)}
                  className="size-[13px] shrink-0 rounded border border-[var(--border-subtle)] accent-[var(--accent)]"
                />
                <span className="min-w-0 flex-1 truncate">{SECTION_LABELS[sectionId]}</span>
              </label>
            );
          })}
          <label className="flex cursor-pointer items-center gap-[8px] rounded-[var(--radius-tab)] px-[10px] py-[3.5px] font-sans text-[12.5px] text-[var(--text-primary)] hover:bg-[var(--accent-bg)]">
            <input
              type="checkbox"
              checked={showIcons}
              onChange={(ev) => setShowIcons(ev.target.checked)}
              className="size-[13px] shrink-0 rounded border border-[var(--border-subtle)] accent-[var(--accent)]"
            />
            <span className="min-w-0 flex-1">Workspace icons</span>
          </label>
        </div>

        <div className={popoverMenuSeparatorClass} />
        <div className={`${popoverMenuSectionLabelClass} flex items-center justify-between`}>
          <span>Filters{visibleFilterCount > 0 ? ` · ${visibleFilterCount}` : ""}</span>
          <button
            type="button"
            disabled={!railFilterActive}
            onClick={() => clearRailFilters()}
            className="text-[10px] normal-case tracking-normal text-[var(--accent)] disabled:opacity-35"
          >
            Clear
          </button>
        </div>
        <PillRow>
          {FILTER_TOGGLE_KEYS.map((key) => (
            <OptionPill
              key={key}
              active={railFilterToggles[key]}
              label={FILTER_TOGGLE_LABELS[key]}
              onSelect={() => setRailFilterToggle(key, !railFilterToggles[key])}
            />
          ))}
        </PillRow>
        <div className="pb-[3px]" />
      </div>
    </div>,
    document.body
  );
}
