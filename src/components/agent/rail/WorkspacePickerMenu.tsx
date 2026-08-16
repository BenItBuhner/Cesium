"use client";

import { useEffect, useLayoutEffect, useMemo, useRef, useState, type RefObject } from "react";
import { createPortal } from "react-dom";
import { Check, Folder, GitBranch, Layers, Plus } from "lucide-react";
import { VerticalFadedScroll } from "@/components/chat/VerticalFadedScroll";
import type { DirectoryWorkspaceRecord } from "@/contexts/WorkspaceDirectoryContext";
import type { WorkspaceRailAppearance } from "@/lib/global-settings";
import { isStandaloneChatWorkspace } from "@/lib/types";
import {
  getWorkspaceRailAppearance,
  WorkspaceFolderIcon,
} from "@/lib/workspace-rail-appearance";
import { shouldAutoFocusTextInput } from "@/lib/mobile-autofocus";
import { useClickOutside } from "@/hooks/useClickOutside";
import { openWorkspaceStudio } from "@/lib/workspace-studio-events";

export function WorkspacePickerRowIcon({
  appearances,
  workspaceKey,
  isHome,
  className = "size-[13px] shrink-0",
}: {
  appearances: Record<string, WorkspaceRailAppearance>;
  workspaceKey: string;
  isHome: boolean;
  className?: string;
}) {
  const appearance = getWorkspaceRailAppearance(appearances, workspaceKey, { isHome });
  return (
    <WorkspaceFolderIcon
      iconName={appearance.icon}
      color={appearance.color}
      className={className}
      strokeWidth={1.5}
    />
  );
}

export function WorkspacePickerMenu({
  open,
  onClose,
  anchorRef,
  workspaces,
  appearances,
  homeWorkspaceId,
  activeServerId,
  selectedWorkspaceKey,
  allSelected = false,
  showAllWorkspacesOption = false,
  onSelectAll,
  onSelectWorkspace,
}: {
  open: boolean;
  onClose: () => void;
  anchorRef: RefObject<HTMLElement | null>;
  workspaces: DirectoryWorkspaceRecord[];
  appearances: Record<string, WorkspaceRailAppearance>;
  homeWorkspaceId: string | null;
  activeServerId: string;
  selectedWorkspaceKey: string | null;
  allSelected?: boolean;
  showAllWorkspacesOption?: boolean;
  onSelectAll?: () => void;
  onSelectWorkspace: (workspace: DirectoryWorkspaceRecord) => void;
}) {
  const panelRef = useRef<HTMLDivElement>(null);
  const [query, setQuery] = useState("");
  const [pos, setPos] = useState({ top: 0, left: 0, width: 280 });

  useLayoutEffect(() => {
    if (!open || !anchorRef.current) {
      return;
    }
    const update = () => {
      const rect = anchorRef.current?.getBoundingClientRect();
      if (!rect) return;
      const width = Math.min(280, Math.max(220, window.innerWidth - 16));
      const left = Math.max(8, Math.min(rect.left, window.innerWidth - width - 8));
      const gap = 6;
      const estimatedHeight = panelRef.current?.offsetHeight ?? 320;
      let top = rect.bottom + gap;
      if (top + estimatedHeight > window.innerHeight - 8) {
        top = Math.max(8, rect.top - estimatedHeight - gap);
      }
      setPos({ top, left, width });
    };
    update();
    window.addEventListener("resize", update);
    window.addEventListener("scroll", update, true);
    return () => {
      window.removeEventListener("resize", update);
      window.removeEventListener("scroll", update, true);
    };
  }, [anchorRef, open, workspaces.length, query]);

  useClickOutside(panelRef, onClose, open, [anchorRef]);

  useEffect(() => {
    if (!open) {
      setQuery("");
      return;
    }
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        onClose();
      }
    };
    document.addEventListener("keydown", onKey, true);
    return () => document.removeEventListener("keydown", onKey, true);
  }, [onClose, open]);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    return workspaces.filter((workspace) => {
      if (isStandaloneChatWorkspace(workspace)) {
        return false;
      }
      if (!q) {
        return true;
      }
      return (
        workspace.name.toLowerCase().includes(q) ||
        workspace.root.toLowerCase().includes(q) ||
        workspace.serverLabel.toLowerCase().includes(q) ||
        (workspace.repository?.currentBranch ?? "").toLowerCase().includes(q)
      );
    });
  }, [query, workspaces]);

  const showDeviceLabel = useMemo(() => {
    const ids = new Set(filtered.map((workspace) => workspace.serverId));
    return ids.size > 1;
  }, [filtered]);

  if (!open) {
    return null;
  }

  return createPortal(
    <div
      ref={panelRef}
      role="dialog"
      aria-label="Choose workspace"
      className="fixed z-[10050] overflow-hidden rounded-[var(--radius-card)] border border-[var(--border-card)] bg-[var(--bg-panel)] shadow-lg"
      style={{ top: pos.top, left: pos.left, width: pos.width }}
      data-ide-input-sink
      data-perf="agent-workspace-picker-popover"
      onPointerDown={(event) => event.stopPropagation()}
    >
      <div className="border-b border-[var(--border-card)] px-[10px] py-[7px]">
        <input
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          placeholder="Search workspaces..."
          className="w-full bg-transparent font-sans text-[13px] text-[var(--text-primary)] outline-none placeholder:text-[var(--text-disabled)]"
          autoFocus={shouldAutoFocusTextInput()}
        />
      </div>
      <VerticalFadedScroll
        measureKey={`${query}\0${filtered.length}\0${showAllWorkspacesOption ? 1 : 0}`}
        scrollClassName="hide-scrollbar-y max-h-[min(320px,45vh)] min-h-0 overflow-y-auto overscroll-contain p-[4px]"
      >
        {showAllWorkspacesOption ? (
          <button
            type="button"
            onClick={() => {
              onSelectAll?.();
              onClose();
            }}
            className="flex w-full items-center gap-[8px] rounded-[var(--radius-tab)] px-[8px] py-[6px] text-left font-sans text-[12.5px] text-[var(--text-secondary)] transition-colors hover:bg-[var(--accent-bg)] hover:text-[var(--text-primary)]"
          >
            <Layers className="size-[13px] shrink-0" strokeWidth={1.5} />
            <span className="min-w-0 flex-1 truncate">All workspaces</span>
            {allSelected ? <Check className="size-[13px] shrink-0" strokeWidth={2} /> : null}
          </button>
        ) : null}
        {filtered.map((workspace) => {
          const current = !allSelected && workspace.workspaceKey === selectedWorkspaceKey;
          const isHome =
            Boolean(homeWorkspaceId) &&
            workspace.id === homeWorkspaceId &&
            workspace.serverId === activeServerId;
          const subtitle = [
            workspace.repository?.currentBranch,
            showDeviceLabel ? workspace.serverLabel : null,
          ]
            .filter(Boolean)
            .join(" · ");
          return (
            <button
              key={workspace.workspaceKey}
              type="button"
              onClick={() => {
                onSelectWorkspace(workspace);
                onClose();
              }}
              className="flex w-full items-center gap-[8px] rounded-[var(--radius-tab)] px-[8px] py-[6px] text-left font-sans text-[12.5px] text-[var(--text-secondary)] transition-colors hover:bg-[var(--accent-bg)] hover:text-[var(--text-primary)]"
            >
              <WorkspacePickerRowIcon
                appearances={appearances}
                workspaceKey={workspace.workspaceKey}
                isHome={isHome}
              />
              <span className="min-w-0 flex-1 truncate">
                <span className="block truncate text-[var(--text-primary)]">{workspace.name}</span>
                {subtitle ? (
                  <span className="mt-[1px] block truncate font-sans text-[10px] text-[var(--text-disabled)]">
                    {subtitle}
                  </span>
                ) : null}
              </span>
              {current ? <Check className="size-[13px] shrink-0" strokeWidth={2} /> : null}
            </button>
          );
        })}
        {filtered.length === 0 ? (
          <div className="px-[8px] py-[8px] font-sans text-[12px] text-[var(--text-disabled)]">
            No workspaces found
          </div>
        ) : null}
      </VerticalFadedScroll>
      <div className="border-t border-[var(--border-card)] p-[4px]">
        <button
          type="button"
          onClick={() => {
            openWorkspaceStudio("newfolder");
            onClose();
          }}
          className="flex w-full items-center gap-[8px] rounded-[var(--radius-tab)] px-[8px] py-[6px] text-left font-sans text-[12.5px] text-[var(--text-primary)] transition-colors hover:bg-[var(--accent-bg)]"
        >
          <Plus className="size-[13px] shrink-0" strokeWidth={1.5} />
          New workspace…
        </button>
        <button
          type="button"
          onClick={() => {
            openWorkspaceStudio("browse");
            onClose();
          }}
          className="flex w-full items-center gap-[8px] rounded-[var(--radius-tab)] px-[8px] py-[6px] text-left font-sans text-[12.5px] text-[var(--text-primary)] transition-colors hover:bg-[var(--accent-bg)]"
        >
          <Folder className="size-[13px] shrink-0" strokeWidth={1.5} />
          Open folder…
        </button>
        <button
          type="button"
          onClick={() => {
            openWorkspaceStudio("clone");
            onClose();
          }}
          className="flex w-full items-center gap-[8px] rounded-[var(--radius-tab)] px-[8px] py-[6px] text-left font-sans text-[12.5px] text-[var(--text-primary)] transition-colors hover:bg-[var(--accent-bg)]"
        >
          <GitBranch className="size-[13px] shrink-0" strokeWidth={1.5} />
          Clone from git…
        </button>
      </div>
    </div>,
    document.body
  );
}
