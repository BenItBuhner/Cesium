export const AGENT_LEFT_RAIL_EXPANDED_WIDTH = 290;
/** @deprecated Historic constant; collapsed rail uses 0% width — see `AgentWorkspaceRailCollapsedOverlay`. */
export const AGENT_LEFT_RAIL_COLLAPSED_WIDTH = 0;
/** Collapsed rail takes no flex space; quick actions use `AgentWorkspaceRailCollapsedOverlay`. */
export const AGENT_LEFT_RAIL_COLLAPSED_SIZE_PERCENT = 0;
/** @deprecated Fixed width removed — side pane is resizable; kept for approximate defaults. */
export const AGENT_RIGHT_PANE_WIDTH = 764;
export const AGENT_SHELL_RAIL_MIN_PERCENT = 10;
export const AGENT_SHELL_RAIL_MAX_PERCENT = 42;
export const AGENT_SHELL_CENTER_MIN_PERCENT = 28;
export const AGENT_SHELL_SIDE_MIN_PERCENT = 16;
export const AGENT_SHELL_SIDE_MAX_PERCENT = 62;

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

export function extractAgentSidePaneScopedLayout(
  value: unknown
): Record<string, number> | null {
  const layout = normalizeAgentShellDesktopLayout(value);
  const side = layout?.[AGENT_SHELL_PANEL_IDS.side];
  if (typeof side !== "number" || !Number.isFinite(side)) {
    return null;
  }
  return {
    [AGENT_SHELL_PANEL_IDS.side]: side,
  };
}

export function isAgentSidePaneScopedLayout(value: unknown): boolean {
  const layout = normalizeAgentShellDesktopLayout(value);
  if (!layout) {
    return true;
  }
  const keys = Object.keys(layout);
  return keys.length === 1 && keys[0] === AGENT_SHELL_PANEL_IDS.side;
}

function clampPanelPercent(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

/**
 * Left rail sizing is shared across agent chats, while the side pane width is conversation-scoped.
 * Compose them into one valid panel-group layout that respects the shell min/max constraints.
 */
export function composeAgentShellDesktopLayout(
  sharedLayoutValue: unknown,
  scopedLayoutValue: unknown
): Record<string, number> | null {
  const sharedLayout = normalizeAgentShellDesktopLayout(sharedLayoutValue);
  const scopedLayout = normalizeAgentShellDesktopLayout(scopedLayoutValue);
  if (!sharedLayout && !scopedLayout) {
    return null;
  }

  const sharedSource = sharedLayout ?? AGENT_SHELL_DEFAULT_LAYOUT;

  const railSource =
    sharedSource[AGENT_SHELL_PANEL_IDS.rail] ??
    AGENT_SHELL_DEFAULT_LAYOUT[AGENT_SHELL_PANEL_IDS.rail];
  const rail = clampPanelPercent(
    railSource,
    AGENT_SHELL_RAIL_MIN_PERCENT,
    AGENT_SHELL_RAIL_MAX_PERCENT
  );

  const sideMax = Math.min(
    AGENT_SHELL_SIDE_MAX_PERCENT,
    100 - rail - AGENT_SHELL_CENTER_MIN_PERCENT
  );
  const sideSource =
    scopedLayout?.[AGENT_SHELL_PANEL_IDS.side] ??
    sharedSource[AGENT_SHELL_PANEL_IDS.side] ??
    AGENT_SHELL_DEFAULT_LAYOUT[AGENT_SHELL_PANEL_IDS.side];
  const side = clampPanelPercent(sideSource, AGENT_SHELL_SIDE_MIN_PERCENT, sideMax);

  return {
    [AGENT_SHELL_PANEL_IDS.rail]: rail,
    [AGENT_SHELL_PANEL_IDS.center]: 100 - rail - side,
    [AGENT_SHELL_PANEL_IDS.side]: side,
  };
}

export function collapseAgentShellSideLayout(
  value: unknown
): Record<string, number> {
  const layout =
    normalizeAgentShellDesktopLayout(value) ?? AGENT_SHELL_DEFAULT_LAYOUT;
  const rail = clampPanelPercent(
    layout[AGENT_SHELL_PANEL_IDS.rail] ??
      AGENT_SHELL_DEFAULT_LAYOUT[AGENT_SHELL_PANEL_IDS.rail],
    AGENT_SHELL_RAIL_MIN_PERCENT,
    AGENT_SHELL_RAIL_MAX_PERCENT
  );
  return {
    [AGENT_SHELL_PANEL_IDS.rail]: rail,
    [AGENT_SHELL_PANEL_IDS.center]: 100 - rail,
    [AGENT_SHELL_PANEL_IDS.side]: 0,
  };
}

/** Let the center surface use the full panel width; message/content blocks handle their own centering. */
export const AGENT_CENTER_STAGE_CLASS = "w-full";
export const AGENT_CENTER_CONTENT_CLASS = "mx-auto w-full max-w-[min(876px,calc(100%-24px))]";
