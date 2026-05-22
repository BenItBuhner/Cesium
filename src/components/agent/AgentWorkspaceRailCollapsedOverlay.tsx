"use client";

import { PanelLeftOpen, Plus, Search } from "lucide-react";
import { useAgentShellState } from "@/components/agent/AgentShellStateContext";
import { AGENT_RAIL_OPEN_SEARCH_EVENT } from "@/components/agent/agent-rail-events";
import { useUserPreferences } from "@/components/preferences/UserPreferencesProvider";

/**
 * When the left rail Panel is collapsed (0% width), show expand / search / new-chat above the shell.
 * Filter, settings, and account stay in the expanded rail footer only — not duplicated here while minimized.
 */
export function AgentWorkspaceRailCollapsedOverlay() {
  const { isMobile, leftRailCollapsed, toggleLeftRailCollapsed, startNewConversation } =
    useAgentShellState();
  const { experimentalIpadWindowedTabInset } = useUserPreferences();
  const padForWindowChrome = experimentalIpadWindowedTabInset && !isMobile;

  if (isMobile || !leftRailCollapsed) {
    return null;
  }

  const openSearch = () => {
    window.dispatchEvent(new CustomEvent(AGENT_RAIL_OPEN_SEARCH_EVENT));
  };

  const btnClass =
    "flex size-[18px] shrink-0 items-center justify-center rounded-[var(--agent-control-radius)] text-[var(--text-secondary)] transition-colors hover:bg-[var(--agent-card-bg)] hover:text-[var(--text-primary)]";

  return (
    <div
      className={`pointer-events-none absolute top-[11px] z-[50] ${
        padForWindowChrome
          ? "left-0 pl-[var(--editor-window-chrome-tab-inset)]"
          : "left-[11px]"
      }`}
      aria-label="Workspace rail quick actions"
    >
      <div className="pointer-events-auto flex items-center gap-[8px]" data-electron-drag-host>
        <button
          type="button"
          onClick={toggleLeftRailCollapsed}
          data-electron-no-drag
          className={btnClass}
          aria-label="Expand workspace rail"
          title="Expand workspace rail"
        >
          <PanelLeftOpen className="size-[16px]" strokeWidth={1.5} />
        </button>
        <button
          type="button"
          onClick={openSearch}
          data-electron-no-drag
          className={btnClass}
          aria-label="Search all chats"
          title="Search all chats"
        >
          <Search className="size-[16px]" strokeWidth={1.5} />
        </button>
        <button
          type="button"
          onClick={startNewConversation}
          data-electron-no-drag
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
