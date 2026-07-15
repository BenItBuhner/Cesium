import type { AgentRailConversationSummary } from "@cesium/core";

export const AGENT_RAIL_FILTER_PRESETS = [
  "default",
  "unread",
  "read",
  "archived",
  "running",
  "needs_attention",
] as const;

export type AgentRailFilterPreset = (typeof AGENT_RAIL_FILTER_PRESETS)[number];

export function isAgentRailFilterPreset(
  value: unknown
): value is AgentRailFilterPreset {
  return (
    typeof value === "string" &&
    AGENT_RAIL_FILTER_PRESETS.includes(value as AgentRailFilterPreset)
  );
}

export const AGENT_RAIL_FILTER_TOGGLE_KEYS = [
  "archived",
  "running",
  "needs_attention",
  "pinned",
  "unread",
  "read",
] as const;

export type AgentRailFilterToggleKey = (typeof AGENT_RAIL_FILTER_TOGGLE_KEYS)[number];

export type AgentRailFilterToggleState = Record<AgentRailFilterToggleKey, boolean>;

export function defaultAgentRailFilterToggles(): AgentRailFilterToggleState {
  return {
    archived: false,
    running: false,
    needs_attention: false,
    pinned: false,
    unread: false,
    read: false,
  };
}

function migrateLegacyFilterPresetToToggles(preset: string): AgentRailFilterToggleState {
  const base = defaultAgentRailFilterToggles();
  if (!isAgentRailFilterPreset(preset)) {
    return base;
  }
  switch (preset) {
    case "archived":
      return { ...base, archived: true };
    case "running":
      return { ...base, running: true };
    case "needs_attention":
      return { ...base, needs_attention: true };
    case "unread":
      return { ...base, unread: true };
    case "read":
      return { ...base, read: true };
    default:
      return base;
  }
}

/**
 * Restore filter toggles from persisted JSON and/or legacy `filterPreset` string.
 */
export function normalizeAgentRailFilterToggles(
  raw: unknown,
  legacyPreset?: string
): AgentRailFilterToggleState {
  const base = defaultAgentRailFilterToggles();
  if (raw && typeof raw === "object" && !Array.isArray(raw)) {
    const o = raw as Record<string, unknown>;
    let hasAnyKey = false;
    for (const key of AGENT_RAIL_FILTER_TOGGLE_KEYS) {
      if (o[key] === true || o[key] === false) {
        base[key] = o[key] === true;
        hasAnyKey = true;
      }
    }
    if (hasAnyKey) {
      return base;
    }
  }
  if (legacyPreset && legacyPreset !== "default") {
    return migrateLegacyFilterPresetToToggles(legacyPreset);
  }
  return base;
}

export function isAgentRailFilterActive(toggles: AgentRailFilterToggleState): boolean {
  return AGENT_RAIL_FILTER_TOGGLE_KEYS.some((k) => toggles[k]);
}

const AGENT_PLACEHOLDER_TITLES = new Set([
  "new chat",
  "start new chat",
  "start a new chat",
]);

export function isPlaceholderAgentRailConversation(
  conversation: AgentRailConversationSummary
): boolean {
  return (
    conversation.lastEventSeq === 0 &&
    conversation.status === "idle" &&
    conversation.archivedAt == null &&
    !conversation.hasPendingPermission &&
    AGENT_PLACEHOLDER_TITLES.has(conversation.title.trim().toLowerCase())
  );
}

export function isRenderableAgentRailConversation(
  conversation: AgentRailConversationSummary
): boolean {
  return !isPlaceholderAgentRailConversation(conversation);
}

export type AgentRailFilterMatchContext = {
  pinnedConversationIds: Set<string>;
  unreadCompletionByConversationId: Record<string, true> | undefined;
};

/**
 * Combined filters use AND logic. With no toggles on, behavior matches the old
 * default rail: hide archived conversations.
 */
export function matchesAgentRailMultiFilter(
  conversation: AgentRailConversationSummary,
  toggles: AgentRailFilterToggleState,
  ctx: AgentRailFilterMatchContext
): boolean {
  const isArchived = conversation.archivedAt != null;
  const isPinned = ctx.pinnedConversationIds.has(conversation.id);
  const isUnread = Boolean(ctx.unreadCompletionByConversationId?.[conversation.id]);
  const anyToggle = isAgentRailFilterActive(toggles);

  if (!anyToggle) {
    return !isArchived;
  }

  if (toggles.archived) {
    if (!isArchived) {
      return false;
    }
  } else if (isArchived) {
    return false;
  }

  if (toggles.running && conversation.status !== "running") {
    return false;
  }
  if (toggles.needs_attention && !conversation.hasPendingPermission) {
    return false;
  }
  if (toggles.pinned && !isPinned) {
    return false;
  }
  if (toggles.unread && !isUnread) {
    return false;
  }
  if (toggles.read && isUnread) {
    return false;
  }

  return true;
}
