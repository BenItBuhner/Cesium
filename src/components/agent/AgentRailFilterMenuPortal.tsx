"use client";

import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type ReactNode,
  type RefObject,
} from "react";
import { createPortal } from "react-dom";
import { Check, ChevronRight } from "lucide-react";
import {
  AGENT_RAIL_ENVIRONMENT_FILTER_KEYS,
  AGENT_RAIL_ENVIRONMENT_FILTER_LABELS,
  AGENT_RAIL_SOURCE_FILTER_KEYS,
  AGENT_RAIL_SOURCE_FILTER_LABELS,
  AGENT_RAIL_STATUS_FILTER_KEYS,
  AGENT_RAIL_STATUS_FILTER_LABELS,
  type AgentRailEnvironmentFilterKey,
  type AgentRailFilterState,
  type AgentRailSourceFilterKey,
  type AgentRailStatusFilterKey,
} from "@/lib/agent-rail";
import { useClickOutside } from "@/hooks/useClickOutside";
import {
  popoverMenuListClass,
  popoverMenuPanelClass,
  popoverMenuSectionLabelClass,
  popoverMenuSeparatorClass,
} from "@/components/ui/popover-menu-ui";
import {
  AGENT_RAIL_GROUP_BY_LABELS,
  AGENT_RAIL_GROUP_BY_MODES,
  AGENT_RAIL_ORDER_BY_LABELS,
  AGENT_RAIL_ORDER_BY_MODES,
  type AgentRailGroupByMode,
  type AgentRailOrderByMode,
  type AgentRailSectionId,
} from "@/lib/global-settings";
import type { AgentRailRowDetailMode } from "@/lib/agent-rail-status";

type SubmenuId = "grouping" | "ordering" | "show" | "status" | "environment" | "source";

const GROUP_BY_HINTS: Record<AgentRailGroupByMode, string> = {
  workspace: "Group conversations by their workspace",
  repository: "Group by git repository",
  updated: "Group into Today / This week / Older",
  status: "Group by raw conversation status",
  server: "Group by source machine",
  priority: "One flat list, urgent first",
};

const SECTION_LABELS: Record<
  Extract<AgentRailSectionId, "attention" | "running" | "pinned">,
  string
> = {
  attention: "Needs attention",
  running: "Running",
  pinned: "Pinned",
};

const MENU_ROW_CLASS =
  "flex h-[26px] w-full cursor-default items-center gap-[8px] rounded-[var(--radius-tab)] px-[8px] text-left font-sans text-[12.5px] text-[var(--text-primary)] outline-none transition-colors hover:bg-[var(--accent-bg)] focus-visible:bg-[var(--accent-bg)] disabled:cursor-not-allowed disabled:opacity-40";

function CheckSlot({ checked }: { checked: boolean }) {
  return (
    <span className="grid size-[14px] shrink-0 place-items-center">
      {checked ? (
        <Check className="size-[12px] text-[var(--text-primary)]" strokeWidth={2} aria-hidden />
      ) : null}
    </span>
  );
}

function CheckRow({
  checked,
  disabled,
  label,
  onToggle,
  title,
}: {
  checked: boolean;
  disabled?: boolean;
  label: string;
  onToggle: () => void;
  title?: string;
}) {
  return (
    <button
      type="button"
      role="menuitemcheckbox"
      aria-checked={checked}
      disabled={disabled}
      title={title}
      className={MENU_ROW_CLASS}
      onClick={(event) => {
        event.preventDefault();
        event.stopPropagation();
        onToggle();
      }}
    >
      <span className="min-w-0 flex-1 truncate">{label}</span>
      <CheckSlot checked={checked} />
    </button>
  );
}

function RadioRow({
  active,
  disabled,
  label,
  onSelect,
  title,
}: {
  active: boolean;
  disabled?: boolean;
  label: string;
  onSelect: () => void;
  title?: string;
}) {
  return (
    <button
      type="button"
      role="menuitemradio"
      aria-checked={active}
      disabled={disabled}
      title={title}
      className={MENU_ROW_CLASS}
      onClick={(event) => {
        event.preventDefault();
        event.stopPropagation();
        onSelect();
      }}
    >
      <span className="min-w-0 flex-1 truncate">{label}</span>
      <CheckSlot checked={active} />
    </button>
  );
}

type AgentRailFilterMenuPortalProps = {
  open: boolean;
  onClose: () => void;
  anchorRef: RefObject<HTMLElement | null>;
  groupBy: AgentRailGroupByMode;
  setGroupBy: (mode: AgentRailGroupByMode) => void;
  orderBy: AgentRailOrderByMode;
  setOrderBy: (mode: AgentRailOrderByMode) => void;
  rowDetail: AgentRailRowDetailMode;
  setRowDetail: (mode: AgentRailRowDetailMode) => void;
  showIcons: boolean;
  setShowIcons: (value: boolean) => void;
  showEnvironment: boolean;
  setShowEnvironment: (value: boolean) => void;
  showWorkspace: boolean;
  setShowWorkspace: (value: boolean) => void;
  showBranch: boolean;
  setShowBranch: (value: boolean) => void;
  showMachine: boolean;
  setShowMachine: (value: boolean) => void;
  hiddenSections: AgentRailSectionId[];
  setSectionHidden: (sectionId: AgentRailSectionId, hidden: boolean) => void;
  filters: AgentRailFilterState;
  setFilters: (next: AgentRailFilterState) => void;
  clearFilters: () => void;
  filterActive: boolean;
  /** Connected machines; the Environment submenu lists them when > 1. */
  machines: Array<{ id: string; label: string }>;
  hiddenServerIds: string[];
  setMachineHidden: (serverId: string, hidden: boolean) => void;
  onCollapseAll: () => void;
  onMarkAllRead: () => void;
};

export function AgentRailFilterMenuPortal({
  open,
  onClose,
  anchorRef,
  groupBy,
  setGroupBy,
  orderBy,
  setOrderBy,
  rowDetail,
  setRowDetail,
  showIcons,
  setShowIcons,
  showEnvironment,
  setShowEnvironment,
  showWorkspace,
  setShowWorkspace,
  showBranch,
  setShowBranch,
  showMachine,
  setShowMachine,
  hiddenSections,
  setSectionHidden,
  filters,
  setFilters,
  clearFilters,
  filterActive,
  machines,
  hiddenServerIds,
  setMachineHidden,
  onCollapseAll,
  onMarkAllRead,
}: AgentRailFilterMenuPortalProps) {
  const filterPanelRef = useRef<HTMLDivElement>(null);
  const submenuPanelRef = useRef<HTMLDivElement>(null);
  const submenuAnchorRectRef = useRef<DOMRect | null>(null);
  const [filterMenuPos, setFilterMenuPos] = useState({ top: 0, left: 0 });
  const [openSubmenu, setOpenSubmenu] = useState<SubmenuId | null>(null);
  const [submenuPos, setSubmenuPos] = useState({ top: 0, left: 0 });

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
      setOpenSubmenu(null);
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

  const openSubmenuAt = useCallback((id: SubmenuId, rowEl: HTMLElement) => {
    submenuAnchorRectRef.current = rowEl.getBoundingClientRect();
    setOpenSubmenu((current) => (current === id ? current : id));
  }, []);

  // Flyout placement: right of the parent row, flipped left / clamped when it
  // would leave the viewport. Runs after render so the panel height is real.
  useLayoutEffect(() => {
    if (!openSubmenu) {
      return;
    }
    const rowRect = submenuAnchorRectRef.current;
    const panel = submenuPanelRef.current;
    if (!rowRect || !panel) {
      return;
    }
    const MARGIN = 8;
    const GAP = 2;
    const rect = panel.getBoundingClientRect();
    let left = rowRect.right + GAP;
    if (left + rect.width > window.innerWidth - MARGIN) {
      left = rowRect.left - rect.width - GAP;
    }
    left = Math.max(MARGIN, left);
    let top = rowRect.top - 4;
    if (top + rect.height > window.innerHeight - MARGIN) {
      top = window.innerHeight - rect.height - MARGIN;
    }
    top = Math.max(MARGIN, top);
    setSubmenuPos((current) =>
      current.top === top && current.left === left ? current : { top, left }
    );
  }, [openSubmenu]);

  const toggleHiddenStatus = useCallback(
    (key: AgentRailStatusFilterKey) => {
      const hidden = filters.hiddenStatuses.includes(key);
      setFilters({
        ...filters,
        hiddenStatuses: hidden
          ? filters.hiddenStatuses.filter((k) => k !== key)
          : [...filters.hiddenStatuses, key],
      });
    },
    [filters, setFilters]
  );

  const toggleHiddenEnvironment = useCallback(
    (key: AgentRailEnvironmentFilterKey) => {
      const hidden = filters.hiddenEnvironments.includes(key);
      setFilters({
        ...filters,
        hiddenEnvironments: hidden
          ? filters.hiddenEnvironments.filter((k) => k !== key)
          : [...filters.hiddenEnvironments, key],
      });
    },
    [filters, setFilters]
  );

  const toggleHiddenSource = useCallback(
    (key: AgentRailSourceFilterKey) => {
      const hidden = filters.hiddenSources.includes(key);
      setFilters({
        ...filters,
        hiddenSources: hidden
          ? filters.hiddenSources.filter((k) => k !== key)
          : [...filters.hiddenSources, key],
      });
    },
    [filters, setFilters]
  );

  if (!open) {
    return null;
  }

  const priorityMode = groupBy === "priority";
  const statusFiltered = filters.hiddenStatuses.length > 0;
  const environmentFiltered =
    filters.hiddenEnvironments.length > 0 || hiddenServerIds.length > 0;
  const sourceFiltered = filters.hiddenSources.length > 0;

  const submenuRow = (id: SubmenuId, label: string, value?: string, dot?: boolean) => (
    <button
      type="button"
      aria-haspopup="menu"
      aria-expanded={openSubmenu === id}
      className={`${MENU_ROW_CLASS} ${openSubmenu === id ? "bg-[var(--accent-bg)]" : ""}`}
      onMouseEnter={(event) => openSubmenuAt(id, event.currentTarget)}
      onClick={(event) => {
        event.preventDefault();
        event.stopPropagation();
        if (openSubmenu === id) {
          setOpenSubmenu(null);
        } else {
          openSubmenuAt(id, event.currentTarget);
        }
      }}
    >
      <span className="min-w-0 flex-1 truncate">{label}</span>
      {dot ? (
        <span
          className="size-[4px] shrink-0 rounded-full bg-[var(--accent)]"
          aria-label="Filtered"
        />
      ) : null}
      {value ? (
        <span className="shrink-0 font-sans text-[11.5px] text-[var(--text-disabled)]">
          {value}
        </span>
      ) : null}
      <ChevronRight
        className="size-[12px] shrink-0 text-[var(--text-disabled)]"
        strokeWidth={2}
        aria-hidden
      />
    </button>
  );

  const closeSubmenusRowProps = {
    onMouseEnter: () => setOpenSubmenu(null),
  };

  const submenuContent: ReactNode =
    openSubmenu === "grouping" ? (
      <>
        {AGENT_RAIL_GROUP_BY_MODES.map((mode) => (
          <RadioRow
            key={mode}
            active={groupBy === mode}
            label={AGENT_RAIL_GROUP_BY_LABELS[mode]}
            title={GROUP_BY_HINTS[mode]}
            onSelect={() => setGroupBy(mode)}
          />
        ))}
      </>
    ) : openSubmenu === "ordering" ? (
      <>
        {AGENT_RAIL_ORDER_BY_MODES.map((mode) => (
          <RadioRow
            key={mode}
            active={priorityMode ? mode === "status" : orderBy === mode}
            disabled={priorityMode}
            title={
              priorityMode
                ? "Priority grouping always sorts by status"
                : mode === "status"
                  ? "Urgent conversations first inside each group"
                  : "Most recently updated first"
            }
            label={AGENT_RAIL_ORDER_BY_LABELS[mode]}
            onSelect={() => setOrderBy(mode)}
          />
        ))}
      </>
    ) : openSubmenu === "show" ? (
      <>
        <CheckRow
          checked={rowDetail !== "compact"}
          label="Details"
          title="Grow a detail line when a row needs you (approval, question, failure, unread result)"
          onToggle={() =>
            setRowDetail(rowDetail === "compact" ? "balanced" : "compact")
          }
        />
        <CheckRow
          checked={rowDetail === "expanded"}
          label="Updated"
          title="Show the last-updated time on every row"
          onToggle={() =>
            setRowDetail(rowDetail === "expanded" ? "balanced" : "expanded")
          }
        />
        <div className={popoverMenuSeparatorClass} />
        <CheckRow
          checked={showEnvironment}
          label="Environment"
          title="Cloud badge on conversations running on a vendor cloud"
          onToggle={() => setShowEnvironment(!showEnvironment)}
        />
        <CheckRow
          checked={showWorkspace}
          label="Workspace"
          title="Workspace name on rows in cross-workspace sections"
          onToggle={() => setShowWorkspace(!showWorkspace)}
        />
        <CheckRow
          checked={showBranch}
          label="Branch"
          title="Git branch badge on conversations inside a repository"
          onToggle={() => setShowBranch(!showBranch)}
        />
        <CheckRow
          checked={showMachine}
          label="Machine"
          title="Source-machine badge on conversations from other engines"
          onToggle={() => setShowMachine(!showMachine)}
        />
        <CheckRow
          checked={showIcons}
          label="Workspace icons"
          onToggle={() => setShowIcons(!showIcons)}
        />
        <div className={popoverMenuSeparatorClass} />
        <div className={popoverMenuSectionLabelClass}>Sections</div>
        {(["attention", "running"] as const).map((sectionId) => {
          const foldedByPriority =
            priorityMode && (sectionId === "attention" || sectionId === "running");
          return (
            <CheckRow
              key={sectionId}
              checked={!hiddenSections.includes(sectionId)}
              disabled={foldedByPriority}
              title={
                foldedByPriority
                  ? "Folded into the priority list while grouping by priority"
                  : undefined
              }
              label={SECTION_LABELS[sectionId]}
              onToggle={() =>
                setSectionHidden(sectionId, !hiddenSections.includes(sectionId))
              }
            />
          );
        })}
      </>
    ) : openSubmenu === "status" ? (
      <>
        {AGENT_RAIL_STATUS_FILTER_KEYS.map((key) => (
          <CheckRow
            key={key}
            checked={!filters.hiddenStatuses.includes(key)}
            label={AGENT_RAIL_STATUS_FILTER_LABELS[key]}
            onToggle={() => toggleHiddenStatus(key)}
          />
        ))}
      </>
    ) : openSubmenu === "environment" ? (
      <>
        {AGENT_RAIL_ENVIRONMENT_FILTER_KEYS.map((key) => (
          <CheckRow
            key={key}
            checked={!filters.hiddenEnvironments.includes(key)}
            label={AGENT_RAIL_ENVIRONMENT_FILTER_LABELS[key]}
            onToggle={() => toggleHiddenEnvironment(key)}
          />
        ))}
        {machines.length > 1 ? (
          <>
            <div className={popoverMenuSeparatorClass} />
            {machines.map((machine) => (
              <CheckRow
                key={machine.id}
                checked={!hiddenServerIds.includes(machine.id)}
                label={machine.label}
                onToggle={() =>
                  setMachineHidden(machine.id, !hiddenServerIds.includes(machine.id))
                }
              />
            ))}
          </>
        ) : null}
      </>
    ) : openSubmenu === "source" ? (
      <>
        {AGENT_RAIL_SOURCE_FILTER_KEYS.map((key) => (
          <CheckRow
            key={key}
            checked={!filters.hiddenSources.includes(key)}
            label={AGENT_RAIL_SOURCE_FILTER_LABELS[key]}
            onToggle={() => toggleHiddenSource(key)}
          />
        ))}
      </>
    ) : null;

  return createPortal(
    <div
      ref={filterPanelRef}
      role="menu"
      aria-label="Rail view and conversation filters"
      className={`fixed z-[10040] w-[208px] transition-opacity ${popoverMenuPanelClass}`}
      style={{ top: filterMenuPos.top, left: filterMenuPos.left }}
      onPointerDown={(e) => e.stopPropagation()}
    >
      <div className={popoverMenuListClass}>
        {submenuRow("grouping", "Grouping", AGENT_RAIL_GROUP_BY_LABELS[groupBy])}
        {submenuRow(
          "ordering",
          "Ordering",
          AGENT_RAIL_ORDER_BY_LABELS[priorityMode ? "status" : orderBy]
        )}
        {submenuRow("show", "Show")}

        <div className={popoverMenuSeparatorClass} {...closeSubmenusRowProps} />
        <div
          className={`${popoverMenuSectionLabelClass} flex items-center justify-between`}
          {...closeSubmenusRowProps}
        >
          <span>Filters</span>
          <button
            type="button"
            disabled={!filterActive}
            onClick={() => clearFilters()}
            className="text-[10px] normal-case tracking-normal text-[var(--accent)] disabled:opacity-35"
          >
            Reset
          </button>
        </div>
        {submenuRow("status", "Status", undefined, statusFiltered)}
        {submenuRow("environment", "Environment", undefined, environmentFiltered)}
        {submenuRow("source", "Source", undefined, sourceFiltered)}
        <div {...closeSubmenusRowProps}>
          <CheckRow
            checked={filters.archived}
            label="Archived"
            title="Browse archived conversations instead of active ones"
            onToggle={() => setFilters({ ...filters, archived: !filters.archived })}
          />
        </div>

        <div className={popoverMenuSeparatorClass} {...closeSubmenusRowProps} />
        <button
          type="button"
          className={MENU_ROW_CLASS}
          {...closeSubmenusRowProps}
          onClick={(event) => {
            event.preventDefault();
            event.stopPropagation();
            onCollapseAll();
            onClose();
          }}
        >
          <span className="min-w-0 flex-1 truncate">Collapse All</span>
        </button>
        <button
          type="button"
          className={MENU_ROW_CLASS}
          {...closeSubmenusRowProps}
          onClick={(event) => {
            event.preventDefault();
            event.stopPropagation();
            onMarkAllRead();
            onClose();
          }}
        >
          <span className="min-w-0 flex-1 truncate">Mark All as Read</span>
        </button>
      </div>

      {openSubmenu && submenuContent ? (
        <div
          ref={submenuPanelRef}
          role="menu"
          className={`fixed z-[10041] w-[196px] ${popoverMenuPanelClass}`}
          style={{ top: submenuPos.top, left: submenuPos.left }}
          onPointerDown={(e) => e.stopPropagation()}
        >
          <div className={popoverMenuListClass}>{submenuContent}</div>
        </div>
      ) : null}
    </div>,
    document.body
  );
}
