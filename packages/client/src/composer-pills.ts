import {
  DEFAULT_COMPOSER_PILLS_VISIBILITY,
  normalizeComposerPillsVisibility,
  type AgentStoredEvent,
  type ComposerPillsVisibility,
  type WorkspaceInsights,
} from "@cesium/core";

export {
  DEFAULT_COMPOSER_PILLS_VISIBILITY,
  normalizeComposerPillsVisibility,
} from "@cesium/core";
export type { ComposerPillsVisibility } from "@cesium/core";

const MAX_PER_CONVERSATION_ENTRIES = 300;

/**
 * Minimal structural slice of `ChatSessionState` used by the composer pill
 * config: the per-conversation override map only. The "last used" default for
 * new conversations is account-wide (`GlobalSettingsState.composer.pillsVisibility`)
 * and is passed in by callers.
 */
export type ComposerPillsScopeState = {
  composerPillsVisibilityByConversationId?: Record<string, ComposerPillsVisibility>;
};

/**
 * Per-conversation override wins; otherwise the account-wide default;
 * otherwise built-in defaults. New conversations therefore inherit whatever
 * the user configured most recently, on any device.
 */
export function resolveComposerPillsVisibility(
  scope: ComposerPillsScopeState,
  conversationId: string | null | undefined,
  newConversationDefault?: ComposerPillsVisibility
): ComposerPillsVisibility {
  const byConversation = scope.composerPillsVisibilityByConversationId;
  if (conversationId && byConversation && byConversation[conversationId]) {
    return normalizeComposerPillsVisibility(byConversation[conversationId]);
  }
  if (newConversationDefault) {
    return normalizeComposerPillsVisibility(newConversationDefault);
  }
  return { ...DEFAULT_COMPOSER_PILLS_VISIBILITY };
}

function prunePerConversationMap<T>(map: Record<string, T>): Record<string, T> {
  const keys = Object.keys(map);
  if (keys.length <= MAX_PER_CONVERSATION_ENTRIES) {
    return map;
  }
  const next: Record<string, T> = {};
  for (const key of keys.slice(keys.length - MAX_PER_CONVERSATION_ENTRIES)) {
    next[key] = map[key]!;
  }
  return next;
}

/**
 * Records a per-conversation visibility override. Callers also write the same
 * value to the account composer defaults so future new chats start from it.
 * Returns the same object when there is no conversation to pin.
 */
export function withComposerPillsVisibility<T extends ComposerPillsScopeState>(
  scope: T,
  conversationId: string | null | undefined,
  next: ComposerPillsVisibility
): T {
  if (!conversationId) {
    return scope;
  }
  const normalized = normalizeComposerPillsVisibility(next);
  return {
    ...scope,
    composerPillsVisibilityByConversationId: prunePerConversationMap({
      ...(scope.composerPillsVisibilityByConversationId ?? {}),
      [conversationId]: normalized,
    }),
  };
}

/** Formats `+A −R` diff totals for the pill label. */
export function formatDiffPillLabel(insights: WorkspaceInsights): string {
  const { totalAdded, totalRemoved, fileCount } = insights.diff;
  const parts = [`+${totalAdded}`, `−${totalRemoved}`];
  if (fileCount > 0) {
    parts.push(`· ${fileCount} file${fileCount === 1 ? "" : "s"}`);
  }
  return parts.join(" ");
}

export type ComposerBuiltinPillState = {
  showDiff: boolean;
  showConflicts: boolean;
  conflictsResolved: boolean;
  showSync: boolean;
  showWork: boolean;
  workCount: number;
};

export type ComposerBackgroundWorkItem = {
  id: string;
  title: string;
};

export type ComposerBackgroundWorkOptions = {
  /** Conversation open in this composer - never counted as background work. */
  currentConversationId?: string | null;
  /**
   * True while the open conversation itself is mid-turn. Used as a fallback
   * when insights omit `runningConversationIds` (older payloads / tests).
   */
  currentConversationRunning?: boolean;
  /** Live sub-agents / background scripts from the open conversation's events. */
  extraWorkCount?: number;
};

/**
 * Latest `subagent` event per id wins. Only `running` children count - the
 * parent/main agent is the thread itself and must not inflate the work pill.
 */
export function listRunningSubagentWorkItems(
  events: readonly AgentStoredEvent[] | null | undefined
): ComposerBackgroundWorkItem[] {
  if (!events?.length) {
    return [];
  }
  const latest = new Map<string, { title: string; status: string }>();
  for (const event of events) {
    if (event.kind !== "subagent") {
      continue;
    }
    const id = event.subagentId.trim();
    if (!id) {
      continue;
    }
    latest.set(id, {
      title: event.title.trim() || "Subagent",
      status: event.status,
    });
  }
  const items: ComposerBackgroundWorkItem[] = [];
  for (const [id, item] of latest) {
    if (item.status === "running") {
      items.push({ id, title: item.title });
    }
  }
  return items;
}

/**
 * Background work for the composer pill: other running chats, cloud tasks,
 * and extra live children (sub-agents). The open/main conversation is excluded
 * even when it is itself running.
 */
export function countComposerBackgroundWork(
  insights: WorkspaceInsights | null,
  options?: ComposerBackgroundWorkOptions
): number {
  const currentId = options?.currentConversationId?.trim() || null;
  const ids = insights?.work.runningConversationIds;
  let conversationCount: number;
  if (ids && ids.length > 0) {
    conversationCount = ids.filter((id) => id !== currentId).length;
  } else {
    conversationCount = insights?.work.runningConversations ?? 0;
    if (currentId && options?.currentConversationRunning) {
      conversationCount = Math.max(0, conversationCount - 1);
    }
  }
  return (
    conversationCount +
    (insights?.work.runningCloudTasks ?? 0) +
    Math.max(0, options?.extraWorkCount ?? 0)
  );
}

/**
 * Dynamic relevance: each built-in pill only renders when its context applies
 * (no git repo → no diff/conflict/sync pills; nothing running → no work pill).
 */
export function deriveComposerBuiltinPills(
  visibility: ComposerPillsVisibility,
  insights: WorkspaceInsights | null,
  options?: ComposerBackgroundWorkOptions
): ComposerBuiltinPillState {
  const git = insights?.isGitRepo === true;
  const conflicts = git
    ? insights!.merge.conflictedFiles.length > 0 || insights!.merge.conflictsResolved
    : false;
  const dirtyWithCounts =
    git &&
    insights!.dirty &&
    (insights!.diff.fileCount > 0 ||
      insights!.diff.totalAdded > 0 ||
      insights!.diff.totalRemoved > 0);
  const workCount = countComposerBackgroundWork(insights, options);
  return {
    showDiff: visibility.diff && dirtyWithCounts,
    showConflicts: visibility.conflicts && conflicts,
    conflictsResolved: insights?.merge.conflictsResolved === true,
    showSync:
      visibility.sync && git && ((insights!.ahead ?? 0) > 0 || (insights!.behind ?? 0) > 0),
    showWork: visibility.work && workCount > 0,
    workCount,
  };
}
