"use client";

import { PanelLeftOpen, Plus, Search } from "lucide-react";
import { useAgentShellState } from "@/components/agent/AgentShellStateContext";
import { AGENT_RAIL_OPEN_SEARCH_EVENT } from "@/components/agent/agent-rail-events";

/**
 * When the left rail Panel is collapsed (0% width), show expand / search / new-chat above the shell.
 * Filter, settings, and account stay in the expanded rail footer only — not duplicated here while minimized.
 */
export function AgentWorkspaceRailCollapsedOverlay() {
  const { isMobile, leftRailCollapsed, toggleLeftRailCollapsed, startNewConversation } =
    useAgentShellState();

  if (isMobile || !leftRailCollapsed) {
    return null;
  }

  const openSearch = () => {
    window.dispatchEvent(new CustomEvent(AGENT_RAIL_OPEN_SEARCH_EVENT));
  };

  const btnClass =
    "flex size-[18px] shrink-0 items-center justify-center rounded-[var(--radius-tab)] text-[var(--text-secondary)] transition-colors hover:bg-[var(--bg-card)] hover:text-[var(--text-primary)]";

  return (
    <div
      className="pointer-events-none absolute left-[11px] top-[11px] z-[50]"
      aria-label="Workspace rail quick actions"
    >
      <div className="pointer-events-auto flex items-center gap-[5px]">
        <button
          type="button"
          onClick={toggleLeftRailCollapsed}
          className={btnClass}
          aria-label="Expand workspace rail"
          title="Expand workspace rail"
        >
          <PanelLeftOpen className="size-[16px]" strokeWidth={1.5} />
        </button>
        <button
          type="button"
          onClick={openSearch}
          className={btnClass}
          aria-label="Search all chats"
          title="Search all chats"
        >
          <Search className="size-[16px]" strokeWidth={1.5} />
        </button>
        <button
          type="button"
          onClick={startNewConversation}
          className={btnClass}
          aria-label="Start new chat"
          title="Start new chat"
        >
          <Plus className="size-[16px]" strokeWidth={1.5} />
        </button>
      </div>
    </div>
  );
}
