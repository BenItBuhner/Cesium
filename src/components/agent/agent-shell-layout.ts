export const AGENT_LEFT_RAIL_EXPANDED_WIDTH = 290;
/** @deprecated Historic constant; collapsed rail uses 0% width — see `AgentWorkspaceRailCollapsedOverlay`. */
export const AGENT_LEFT_RAIL_COLLAPSED_WIDTH = 0;
/** Collapsed rail takes no flex space; quick actions use `AgentWorkspaceRailCollapsedOverlay`. */
export const AGENT_LEFT_RAIL_COLLAPSED_SIZE_PERCENT = 0;
/** @deprecated Fixed width removed — side pane is resizable; kept for approximate defaults. */
export const AGENT_RIGHT_PANE_WIDTH = 764;

export const AGENT_SHELL_PANEL_IDS = {
  rail: "agent-shell-rail",
  center: "agent-shell-center",
  side: "agent-shell-side",
} as const;

/** Default horizontal layout (~290px rail, ~764px side on ~1660px-wide shell). */
export const AGENT_SHELL_DEFAULT_LAYOUT: Record<string, number> = {
  [AGENT_SHELL_PANEL_IDS.rail]: 17,
  [AGENT_SHELL_PANEL_IDS.center]: 37,
  [AGENT_SHELL_PANEL_IDS.side]: 46,
};

export function normalizeAgentShellDesktopLayout(
  value: unknown
): Record<string, number> | null {
  if (!value || typeof value !== "object") {
    return null;
  }
  const entries = Object.entries(value).filter(
    ([panelId, size]) =>
      typeof panelId === "string" &&
      panelId.length > 0 &&
      typeof size === "number" &&
      Number.isFinite(size)
  );
  if (entries.length === 0) {
    return null;
  }
  return Object.fromEntries(entries);
}

/** Let the center surface use the full panel width; message/content blocks handle their own centering. */
export const AGENT_CENTER_STAGE_CLASS = "w-full";
export const AGENT_CENTER_CONTENT_CLASS = "mx-auto w-full max-w-[min(876px,calc(100%-24px))]";
