"use client";

import { useCallback, useMemo } from "react";
import { ExternalLink, LayoutPanelTop, Plus } from "lucide-react";
import { useWorkspace } from "@/contexts/WorkspaceContext";
import type { WorkspaceWindowRecord } from "@/lib/types";
import { buildWorkspaceWindowUrl } from "@/lib/workspace-windows";

function formatWindowMeta(windowRecord: WorkspaceWindowRecord): string {
  const lastFocusedAt = windowRecord.lastFocusedAt ?? windowRecord.lastOpenedAt;
  const minutesAgo = Math.max(0, Math.round((Date.now() - lastFocusedAt) / 60_000));
  if (minutesAgo <= 1) {
    return "Active just now";
  }
  if (minutesAgo < 60) {
    return `Active ${minutesAgo}m ago`;
  }
  const hoursAgo = Math.round(minutesAgo / 60);
  return `Active ${hoursAgo}h ago`;
}

export function WorkspaceWindowsList() {
  const {
    activeWorkspaceId,
    activeWindowId,
    workspaceWindows,
    createWorkspaceWindow,
    updateWorkspaceWindow,
  } = useWorkspace();

  const visibleWindows = useMemo(
    () => workspaceWindows.filter((windowRecord) => !windowRecord.closedAt),
    [workspaceWindows]
  );

  const openWindow = useCallback(
    (windowRecord: WorkspaceWindowRecord) => {
      if (!activeWorkspaceId) {
        return;
      }
      void updateWorkspaceWindow(windowRecord.id, {
        lastFocusedAt: Date.now(),
      }).catch(() => {
        // Ignore best-effort activity updates before opening.
      });
      const nextWindow = window.open(
        buildWorkspaceWindowUrl(window.location.origin, activeWorkspaceId, windowRecord.id),
        "_blank",
        "noopener,noreferrer"
      );
      if (!nextWindow) {
        return;
      }
      nextWindow.focus();
    },
    [activeWorkspaceId, updateWorkspaceWindow]
  );

  const handleCreateWindow = useCallback(async () => {
    if (!activeWorkspaceId) {
      return;
    }
    const createdWindow = await createWorkspaceWindow();
    const nextWindow = window.open(
      buildWorkspaceWindowUrl(window.location.origin, activeWorkspaceId, createdWindow.id),
      "_blank",
      "noopener,noreferrer"
    );
    if (nextWindow) {
      nextWindow.focus();
    }
  }, [activeWorkspaceId, createWorkspaceWindow]);

  return (
    <div className="shrink-0 border-t border-[var(--border-subtle)] px-[11px] py-[8px]">
      <div className="mb-[6px] flex items-center justify-between gap-[8px]">
        <div className="flex items-center gap-[6px] font-sans text-[12px] font-medium text-[var(--text-secondary)]">
          <LayoutPanelTop className="size-[13px]" strokeWidth={1.6} aria-hidden />
          <span>Workspace windows</span>
        </div>
        <button
          type="button"
          onClick={() => void handleCreateWindow()}
          className="flex items-center gap-[4px] rounded-[var(--radius-tab)] px-[6px] py-[2px] font-sans text-[11px] text-[var(--text-secondary)] transition-colors hover:bg-[var(--accent-bg)] hover:text-[var(--text-primary)]"
        >
          <Plus className="size-[12px]" strokeWidth={1.8} aria-hidden />
          <span>New</span>
        </button>
      </div>
      <div className="space-y-[4px]">
        {visibleWindows.length === 0 ? (
          <p className="rounded-[var(--radius-tab)] border border-dashed border-[var(--border-subtle)] px-[8px] py-[7px] font-sans text-[12px] text-[var(--text-secondary)]">
            Create a dedicated window to keep another editor layout around.
          </p>
        ) : (
          visibleWindows.map((windowRecord) => {
            const isActive = windowRecord.id === activeWindowId;
            return (
              <button
                key={windowRecord.id}
                type="button"
                onClick={() => openWindow(windowRecord)}
                className={`flex w-full items-start gap-[8px] rounded-[var(--radius-tab)] px-[8px] py-[7px] text-left transition-colors ${
                  isActive
                    ? "bg-[var(--accent-bg)]"
                    : "hover:bg-white/[0.04]"
                }`}
              >
                <div className="min-w-0 flex-1">
                  <div className="truncate font-sans text-[12px] font-medium text-[var(--text-primary)]">
                    {windowRecord.label}
                  </div>
                  <div className="font-sans text-[11px] text-[var(--text-secondary)]">
                    {isActive ? "Open in this tab" : formatWindowMeta(windowRecord)}
                  </div>
                </div>
                <ExternalLink
                  className="mt-[1px] size-[12px] shrink-0 text-[var(--text-secondary)]"
                  strokeWidth={1.7}
                  aria-hidden
                />
              </button>
            );
          })
        )}
      </div>
    </div>
  );
}
