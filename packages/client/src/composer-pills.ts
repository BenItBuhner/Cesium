import {
  DEFAULT_COMPOSER_PILLS_VISIBILITY,
  normalizeComposerPillsVisibility,
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
 * config. `composerPillsVisibility` is the "last used" default applied to new
 * conversations; the ByConversationId map holds per-conversation overrides.
 */
export type ComposerPillsScopeState = {
  composerPillsVisibility?: ComposerPillsVisibility;
  composerPillsVisibilityByConversationId?: Record<string, ComposerPillsVisibility>;
};

/**
 * Per-conversation override wins; otherwise the last-used default; otherwise
 * built-in defaults. New conversations therefore inherit whatever the user
 * configured most recently.
 */
export function resolveComposerPillsVisibility(
  scope: ComposerPillsScopeState,
  conversationId: string | null | undefined
): ComposerPillsVisibility {
  const byConversation = scope.composerPillsVisibilityByConversationId;
  if (conversationId && byConversation && byConversation[conversationId]) {
    return normalizeComposerPillsVisibility(byConversation[conversationId]);
  }
  if (scope.composerPillsVisibility) {
    return normalizeComposerPillsVisibility(scope.composerPillsVisibility);
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
 * Records a visibility change: the conversation (when known) gets its own
 * entry, and the same value becomes the last-used default so future new
 * conversations start from it.
 */
export function withComposerPillsVisibility<T extends ComposerPillsScopeState>(
  scope: T,
  conversationId: string | null | undefined,
  next: ComposerPillsVisibility
): T {
  const normalized = normalizeComposerPillsVisibility(next);
  const byConversation = conversationId
    ? prunePerConversationMap({
        ...(scope.composerPillsVisibilityByConversationId ?? {}),
        [conversationId]: normalized,
      })
    : scope.composerPillsVisibilityByConversationId ?? {};
  return {
    ...scope,
    composerPillsVisibility: normalized,
    composerPillsVisibilityByConversationId: byConversation,
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

/**
 * Dynamic relevance: each built-in pill only renders when its context applies
 * (no git repo → no diff/conflict/sync pills; nothing running → no work pill).
 */
export function deriveComposerBuiltinPills(
  visibility: ComposerPillsVisibility,
  insights: WorkspaceInsights | null
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
  const workCount =
    (insights?.work.runningConversations ?? 0) + (insights?.work.runningCloudTasks ?? 0);
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
