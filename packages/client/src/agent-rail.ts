import type { AgentConversationOrigin, AgentRailConversationSummary } from "@cesium/core";
import {
  getAgentRailStatusKind,
  type AgentRailStatusContext,
} from "./agent-rail-status";

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

/**
 * Legacy narrowing toggles (multi-select AND). Kept only so persisted sessions
 * migrate into the exclude-set `AgentRailFilterState` below.
 */
export const AGENT_RAIL_FILTER_TOGGLE_KEYS = [
  "archived",
  "running",
  "needs_attention",
  "pinned",
  "unread",
  "read",
  "external",
  "cloud",
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
    external: false,
    cloud: false,
  };
}

/**
 * Coarse per-conversation status classes for the rail's Status filter.
 * Mirrors the priority buckets: blocked-on-you, actively working, finished but
 * unread, and everything else ("done").
 */
export const AGENT_RAIL_STATUS_FILTER_KEYS = [
  "attention",
  "working",
  "unread",
  "done",
] as const;

export type AgentRailStatusFilterKey = (typeof AGENT_RAIL_STATUS_FILTER_KEYS)[number];

export const AGENT_RAIL_STATUS_FILTER_LABELS: Record<AgentRailStatusFilterKey, string> = {
  attention: "Needs attention",
  working: "Working",
  unread: "Unread",
  done: "Done",
};

/** Where the agent executes: this machine (or a connected engine) vs a vendor cloud. */
export const AGENT_RAIL_ENVIRONMENT_FILTER_KEYS = ["local", "cloud"] as const;

export type AgentRailEnvironmentFilterKey =
  (typeof AGENT_RAIL_ENVIRONMENT_FILTER_KEYS)[number];

export const AGENT_RAIL_ENVIRONMENT_FILTER_LABELS: Record<
  AgentRailEnvironmentFilterKey,
  string
> = {
  local: "Local",
  cloud: "Cloud",
};

/** Provenance classes for the rail's Source filter, from `conversation.origin`. */
export const AGENT_RAIL_SOURCE_FILTER_KEYS = [
  "app",
  "slack",
  "linear",
  "github",
  "cloud-agent",
  "imported",
  "scheduled",
] as const;

export type AgentRailSourceFilterKey = (typeof AGENT_RAIL_SOURCE_FILTER_KEYS)[number];

export const AGENT_RAIL_SOURCE_FILTER_LABELS: Record<AgentRailSourceFilterKey, string> = {
  app: "In-app",
  slack: "Slack",
  linear: "Linear",
  github: "GitHub",
  "cloud-agent": "Cloud agent",
  imported: "Imported",
  scheduled: "Scheduled",
};

/**
 * Cursor-style rail filters. Persisted as EXCLUDE sets so newly added status /
 * source / environment kinds default to visible (allow-lists hide new kinds
 * forever - same trap as the retired `visibleServerIds`). Empty arrays mean
 * "show everything" and match the untouched default menu (all boxes checked).
 */
export type AgentRailFilterState = {
  /** Status classes unchecked in the menu. */
  hiddenStatuses: AgentRailStatusFilterKey[];
  /** Execution environments unchecked in the menu. */
  hiddenEnvironments: AgentRailEnvironmentFilterKey[];
  /** Provenance sources unchecked in the menu. */
  hiddenSources: AgentRailSourceFilterKey[];
  /** Browse archived conversations instead of active ones. */
  archived: boolean;
};

export function createDefaultAgentRailFilterState(): AgentRailFilterState {
  return {
    hiddenStatuses: [],
    hiddenEnvironments: [],
    hiddenSources: [],
    archived: false,
  };
}

export function isAgentRailFilterStateActive(state: AgentRailFilterState): boolean {
  return (
    state.archived ||
    state.hiddenStatuses.length > 0 ||
    state.hiddenEnvironments.length > 0 ||
    state.hiddenSources.length > 0
  );
}

function dedupeKeys<T extends string>(raw: unknown, valid: readonly T[]): T[] {
  if (!Array.isArray(raw)) {
    return [];
  }
  const seen = new Set<T>();
  for (const value of raw) {
    if (valid.includes(value as T)) {
      seen.add(value as T);
    }
  }
  return [...seen];
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

/**
 * Approximate the retired narrowing toggles (AND semantics) as exclude sets:
 * "only running" becomes "hide every status class except working", etc.
 */
export function migrateAgentRailFilterToggles(
  toggles: AgentRailFilterToggleState
): AgentRailFilterState {
  const state = createDefaultAgentRailFilterState();
  state.archived = toggles.archived;
  const hideStatusesExcept = (keep: AgentRailStatusFilterKey) => {
    for (const key of AGENT_RAIL_STATUS_FILTER_KEYS) {
      if (key !== keep && !state.hiddenStatuses.includes(key)) {
        state.hiddenStatuses.push(key);
      }
    }
  };
  if (toggles.running) {
    hideStatusesExcept("working");
  }
  if (toggles.needs_attention) {
    hideStatusesExcept("attention");
  }
  if (toggles.unread) {
    hideStatusesExcept("unread");
  }
  if (toggles.read && !state.hiddenStatuses.includes("unread")) {
    state.hiddenStatuses.push("unread");
  }
  if (toggles.cloud) {
    state.hiddenEnvironments.push("local");
  }
  if (toggles.external) {
    // External = triggered through Cloud Agents (Slack/Linear/GitHub/manual).
    state.hiddenSources.push("app", "imported", "scheduled");
  }
  // `pinned` has no exclude-set equivalent; the Pinned section owns that view.
  return state;
}

/**
 * Restore the rail filter state from persisted JSON, falling back to legacy
 * toggle / preset migrations when the new shape has never been written.
 */
export function normalizeAgentRailFilterState(
  raw: unknown,
  legacyToggles?: unknown,
  legacyPreset?: string
): AgentRailFilterState {
  if (raw && typeof raw === "object" && !Array.isArray(raw)) {
    const o = raw as Record<string, unknown>;
    return {
      hiddenStatuses: dedupeKeys(o.hiddenStatuses, AGENT_RAIL_STATUS_FILTER_KEYS),
      hiddenEnvironments: dedupeKeys(
        o.hiddenEnvironments,
        AGENT_RAIL_ENVIRONMENT_FILTER_KEYS
      ),
      hiddenSources: dedupeKeys(o.hiddenSources, AGENT_RAIL_SOURCE_FILTER_KEYS),
      archived: o.archived === true,
    };
  }
  if (legacyToggles != null || (legacyPreset && legacyPreset !== "default")) {
    return migrateAgentRailFilterToggles(
      normalizeAgentRailFilterToggles(legacyToggles, legacyPreset)
    );
  }
  return createDefaultAgentRailFilterState();
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
  acknowledgedFailureByConversationId?: Record<string, true>;
};

function statusContextFor(
  conversation: Pick<AgentRailConversationSummary, "id">,
  ctx: AgentRailFilterMatchContext
): AgentRailStatusContext {
  return {
    unreadCompletion: Boolean(ctx.unreadCompletionByConversationId?.[conversation.id]),
    acknowledgedFailure: Boolean(
      ctx.acknowledgedFailureByConversationId?.[conversation.id]
    ),
  };
}

/** Coarse status class used by the rail's Status filter. */
export function getAgentRailStatusFilterClass(
  conversation: Pick<
    AgentRailConversationSummary,
    "status" | "hasPendingPermission" | "hasPendingQuestion" | "settledAt" | "settledUntil"
  >,
  ctx?: AgentRailStatusContext
): AgentRailStatusFilterKey {
  const kind = getAgentRailStatusKind(conversation, ctx);
  switch (kind) {
    case "permission":
    case "question":
    case "failed":
      return "attention";
    case "running":
    case "pausing":
      return "working";
    case "done_unread":
      return "unread";
    default:
      return "done";
  }
}

export function getAgentRailEnvironmentFilterKey(
  conversation: Pick<AgentRailConversationSummary, "executionTarget">
): AgentRailEnvironmentFilterKey {
  return conversation.executionTarget === "cloud" ? "cloud" : "local";
}

function sourceKeyForOrigin(
  origin: AgentConversationOrigin | null | undefined
): AgentRailSourceFilterKey {
  if (!origin) {
    return "app";
  }
  switch (origin.kind) {
    case "cloud":
      switch (origin.providerId) {
        case "slack":
          return "slack";
        case "linear":
          return "linear";
        case "github":
          return "github";
        default:
          return "cloud-agent";
      }
    case "import":
    case "cloud-snapshot":
      return "imported";
    case "trigger":
      return "scheduled";
    default:
      return "app";
  }
}

export function getAgentRailSourceFilterKey(
  conversation: Pick<AgentRailConversationSummary, "origin">
): AgentRailSourceFilterKey {
  return sourceKeyForOrigin(conversation.origin);
}

/**
 * Cursor-style exclude-set filtering. With the default state this matches the
 * classic rail: hide archived conversations, show everything else.
 */
export function matchesAgentRailFilters(
  conversation: AgentRailConversationSummary,
  state: AgentRailFilterState,
  ctx: AgentRailFilterMatchContext
): boolean {
  const isArchived = conversation.archivedAt != null;
  if (state.archived) {
    if (!isArchived) {
      return false;
    }
  } else if (isArchived) {
    return false;
  }

  if (
    state.hiddenStatuses.length > 0 &&
    state.hiddenStatuses.includes(
      getAgentRailStatusFilterClass(conversation, statusContextFor(conversation, ctx))
    )
  ) {
    return false;
  }
  if (
    state.hiddenEnvironments.length > 0 &&
    state.hiddenEnvironments.includes(getAgentRailEnvironmentFilterKey(conversation))
  ) {
    return false;
  }
  if (
    state.hiddenSources.length > 0 &&
    state.hiddenSources.includes(getAgentRailSourceFilterKey(conversation))
  ) {
    return false;
  }

  return true;
}
