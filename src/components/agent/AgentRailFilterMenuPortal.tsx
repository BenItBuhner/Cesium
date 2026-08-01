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
import { ChevronDown, ChevronUp } from "lucide-react";
import {
  AGENT_RAIL_FILTER_TOGGLE_KEYS,
  type AgentRailFilterToggleKey,
  type AgentRailFilterToggleState,
} from "@/lib/agent-rail";
import { useClickOutside } from "@/hooks/useClickOutside";
import {
  popoverMenuListClass,
  popoverMenuPanelClass,
  popoverMenuSectionLabelClass,
  popoverMenuSeparatorClass,
} from "@/components/ui/popover-menu-ui";
import type { WorkspaceSortMode } from "@/lib/global-settings";
import type { AgentRailGroupByMode, AgentRailSectionId } from "@/lib/global-settings";
import { AGENT_RAIL_SECTION_IDS } from "@/lib/global-settings";
import type { AgentRailRowDetailMode } from "@/lib/agent-rail-status";

const FILTER_TOGGLE_LABELS: Record<AgentRailFilterToggleKey, string> = {
  archived: "Archived",
  running: "Running",
  needs_attention: "Needs attention",
  pinned: "Pinned",
  unread: "Unread",
  read: "Read",
  external: "External",
};

const WORKSPACE_SORT_OPTIONS: Array<{ value: WorkspaceSortMode; label: string }> = [
  { value: "recent", label: "Recent" },
  { value: "alphabetical", label: "A–Z" },
  { value: "machine", label: "Machine" },
  { value: "custom", label: "Custom" },
];

const GROUP_BY_OPTIONS: Array<{
  value: AgentRailGroupByMode;
  label: string;
  hint: string;
}> = [
  { value: "workspace", label: "Workspace", hint: "Grouped by project workspace" },
  { value: "priority", label: "Priority", hint: "One flat list, urgent first — no workspaces or folders" },
  { value: "repository", label: "Repository", hint: "Grouped by git repository" },
  { value: "server", label: "Machine", hint: "Grouped by connected machine" },
  { value: "updated", label: "Updated", hint: "Grouped by last activity" },
  { value: "status", label: "Status", hint: "Grouped by raw conversation status" },
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

const SECTION_LABELS: Record<AgentRailSectionId, string> = {
  attention: "Needs attention",
  pinned: "Pinned",
  chats: "Chats",
  workspaces: "Workspaces",
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
  workspaceSortMode: WorkspaceSortMode;
  setWorkspaceSortMode: (mode: WorkspaceSortMode) => void;
  workspaceCustomOrderActive: boolean;
  resetWorkspaceCustomOrder: () => void;
  groupBy: AgentRailGroupByMode;
  setGroupBy: (mode: AgentRailGroupByMode) => void;
  machines: Array<{ id: string; label: string }>;
  hiddenMachineIds: string[];
  setMachineVisible: (serverId: string, visible: boolean) => void;
  showIcons: boolean;
  setShowIcons: (value: boolean) => void;
  rowDetail: AgentRailRowDetailMode;
  setRowDetail: (mode: AgentRailRowDetailMode) => void;
  sectionOrder: AgentRailSectionId[];
  hiddenSections: AgentRailSectionId[];
  setSectionOrder: (order: AgentRailSectionId[]) => void;
  setSectionHidden: (sectionId: AgentRailSectionId, hidden: boolean) => void;
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
  machines,
  hiddenMachineIds,
  setMachineVisible,
  showIcons,
  setShowIcons,
  rowDetail,
  setRowDetail,
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

  const groupByHint = GROUP_BY_OPTIONS.find((option) => option.value === groupBy)?.hint;
  const rowDetailHint = ROW_DETAIL_OPTIONS.find(
    (option) => option.value === rowDetail
  )?.hint;
  const priorityMode = groupBy === "priority";
  const activeFilterCount = AGENT_RAIL_FILTER_TOGGLE_KEYS.filter(
    (key) => railFilterToggles[key]
  ).length;

  return createPortal(
    <div
      ref={filterPanelRef}
      role="dialog"
      aria-label="Rail view, sections, and conversation filters"
      className={`fixed z-[10040] w-[248px] transition-opacity ${popoverMenuPanelClass}`}
      style={{ top: filterMenuPos.top, left: filterMenuPos.left }}
      onPointerDown={(e) => e.stopPropagation()}
    >
      <div className={popoverMenuListClass}>
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

        {!priorityMode ? (
          <>
            <div className={popoverMenuSectionLabelClass}>Sort workspaces</div>
            <PillRow>
              {WORKSPACE_SORT_OPTIONS.map((option) => (
                <OptionPill
                  key={option.value}
                  active={workspaceSortMode === option.value}
                  label={option.label}
                  onSelect={() => setWorkspaceSortMode(option.value)}
                />
              ))}
            </PillRow>
            {workspaceCustomOrderActive ? (
              <button
                type="button"
                onClick={() => resetWorkspaceCustomOrder()}
                className="px-[10px] pb-[2px] pt-[3px] text-left font-sans text-[10.5px] text-[var(--accent)] hover:underline"
              >
                Reset custom order
              </button>
            ) : null}
          </>
        ) : null}

        <div className={popoverMenuSeparatorClass} />
        <div className={popoverMenuSectionLabelClass}>Sections</div>
        <div className="flex flex-col" onPointerDown={(e) => e.stopPropagation()}>
          {AGENT_RAIL_SECTION_IDS.map((sectionId) => {
            const hidden = hiddenSections.includes(sectionId);
            const canHide = sectionId !== "workspaces";
            const index = sectionOrder.indexOf(sectionId);
            const foldedByPriority =
              priorityMode && (sectionId === "attention" || sectionId === "chats");
            return (
              <div
                key={sectionId}
                className={`flex items-center gap-[8px] rounded-[var(--radius-tab)] px-[10px] py-[3.5px] font-sans text-[12.5px] text-[var(--text-primary)] hover:bg-[var(--accent-bg)] ${
                  foldedByPriority ? "opacity-45" : ""
                }`}
                title={
                  foldedByPriority
                    ? "Folded into the priority list while grouping by priority"
                    : undefined
                }
              >
                {canHide ? (
                  <input
                    type="checkbox"
                    checked={!hidden}
                    disabled={foldedByPriority}
                    onChange={(ev) => setSectionHidden(sectionId, !ev.target.checked)}
                    className="size-[13px] shrink-0 rounded border border-[var(--border-subtle)] accent-[var(--accent)]"
                    aria-label={`Show ${SECTION_LABELS[sectionId]}`}
                  />
                ) : (
                  <span className="size-[13px] shrink-0" />
                )}
                <span className="min-w-0 flex-1 truncate">
                  {SECTION_LABELS[sectionId]}
                </span>
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
                  className="grid size-[18px] shrink-0 place-items-center rounded text-[var(--text-secondary)] hover:bg-[var(--accent-bg)] hover:text-[var(--text-primary)] disabled:opacity-25"
                  aria-label={`Move ${SECTION_LABELS[sectionId]} up`}
                >
                  <ChevronUp className="size-[12px]" strokeWidth={2} aria-hidden />
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
                  className="grid size-[18px] shrink-0 place-items-center rounded text-[var(--text-secondary)] hover:bg-[var(--accent-bg)] hover:text-[var(--text-primary)] disabled:opacity-25"
                  aria-label={`Move ${SECTION_LABELS[sectionId]} down`}
                >
                  <ChevronDown className="size-[12px]" strokeWidth={2} aria-hidden />
                </button>
              </div>
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

        {machines.length > 1 ? (
          <>
            <div className={popoverMenuSeparatorClass} />
            <div className={`${popoverMenuSectionLabelClass} flex items-center justify-between`}>
              <span>Machines</span>
              <button
                type="button"
                disabled={hiddenMachineIds.length === 0}
                onClick={() => {
                  for (const machine of machines) {
                    setMachineVisible(machine.id, true);
                  }
                }}
                className="text-[10px] normal-case tracking-normal text-[var(--accent)] disabled:opacity-35"
              >
                Show all
              </button>
            </div>
            <div className="flex flex-col" onPointerDown={(e) => e.stopPropagation()}>
              {machines.map((machine) => (
                <label
                  key={machine.id}
                  className="flex cursor-pointer items-center gap-[8px] rounded-[var(--radius-tab)] px-[10px] py-[3.5px] font-sans text-[12.5px] text-[var(--text-primary)] hover:bg-[var(--accent-bg)]"
                >
                  <input
                    type="checkbox"
                    checked={!hiddenMachineIds.includes(machine.id)}
                    onChange={(event) => setMachineVisible(machine.id, event.target.checked)}
                    className="size-[13px] shrink-0 rounded border border-[var(--border-subtle)] accent-[var(--accent)]"
                  />
                  <span className="min-w-0 flex-1 truncate">{machine.label}</span>
                </label>
              ))}
            </div>
          </>
        ) : null}

        <div className={popoverMenuSeparatorClass} />
        <div className={`${popoverMenuSectionLabelClass} flex items-center justify-between`}>
          <span>Filters{activeFilterCount > 0 ? ` · ${activeFilterCount}` : ""}</span>
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
          {AGENT_RAIL_FILTER_TOGGLE_KEYS.map((key) => (
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
