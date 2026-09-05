import type { GitWorkspaceStatus } from "@cesium/core";

export type ComposerStatusBarVisibility = {
  repo: boolean;
  branch: boolean;
  goal: boolean;
  context: boolean;
};

export const DEFAULT_COMPOSER_STATUS_BAR_VISIBILITY: ComposerStatusBarVisibility = {
  repo: true,
  branch: true,
  goal: true,
  context: true,
};

export function composerStatusBarHasVisibleItems(
  visibility: ComposerStatusBarVisibility,
  gitStatus: GitWorkspaceStatus | null,
  options?: { goalProgress?: boolean }
): boolean {
  if (visibility.repo) {
    return true;
  }
  if (visibility.branch && resolveComposerBranchLabel(gitStatus) != null) {
    return true;
  }
  if (visibility.goal && options?.goalProgress === true) {
    return true;
  }
  return visibility.context;
}

const MAX_PER_CONVERSATION_ENTRIES = 300;

/**
 * Minimal structural slice of `ChatSessionState` used by the status bar
 * config: the per-conversation map only. The "last used" default for new
 * conversations is account-wide (`GlobalSettingsState.composer.statusBarVisibility`)
 * and is passed in by callers.
 */
export type ComposerStatusBarScopeState = {
  composerStatusBarVisibilityByConversationId?: Record<
    string,
    ComposerStatusBarVisibility
  >;
};

/**
 * Per-conversation state wins; otherwise the account-wide new-chat default,
 * then the built-in defaults. New conversations therefore inherit whatever the
 * user configured most recently, and keep their own state once toggled.
 */
export function resolveComposerStatusBarVisibilityForConversation(
  scope: ComposerStatusBarScopeState,
  conversationId: string | null | undefined,
  newConversationDefault?: ComposerStatusBarVisibility
): ComposerStatusBarVisibility {
  const byConversation = scope.composerStatusBarVisibilityByConversationId;
  if (conversationId && byConversation && byConversation[conversationId]) {
    return normalizeComposerStatusBarVisibility(byConversation[conversationId]);
  }
  return normalizeComposerStatusBarVisibility(newConversationDefault);
}

function pruneStatusBarPerConversationMap(
  map: Record<string, ComposerStatusBarVisibility>
): Record<string, ComposerStatusBarVisibility> {
  const keys = Object.keys(map);
  if (keys.length <= MAX_PER_CONVERSATION_ENTRIES) {
    return map;
  }
  const next: Record<string, ComposerStatusBarVisibility> = {};
  for (const key of keys.slice(keys.length - MAX_PER_CONVERSATION_ENTRIES)) {
    next[key] = map[key]!;
  }
  return next;
}

/**
 * Pins the conversation's currently resolved visibility as its own entry
 * without touching the last-used default. Called when a conversation's status
 * bar first renders, so the chat keeps the default it was created with even
 * after later changes made from other chats move the default.
 */
export function pinComposerStatusBarVisibilityForConversation<
  T extends ComposerStatusBarScopeState,
>(
  scope: T,
  conversationId: string | null | undefined,
  newConversationDefault?: ComposerStatusBarVisibility
): T {
  if (!conversationId) {
    return scope;
  }
  const byConversation = scope.composerStatusBarVisibilityByConversationId ?? {};
  if (byConversation[conversationId]) {
    return scope;
  }
  return {
    ...scope,
    composerStatusBarVisibilityByConversationId: pruneStatusBarPerConversationMap({
      ...byConversation,
      [conversationId]: resolveComposerStatusBarVisibilityForConversation(
        scope,
        undefined,
        newConversationDefault
      ),
    }),
  };
}

/**
 * Records a per-conversation visibility change. Callers also write the same
 * value to the account composer defaults so future new chats start from it.
 * Returns the same object when there is no conversation to pin.
 */
export function withComposerStatusBarVisibility<T extends ComposerStatusBarScopeState>(
  scope: T,
  conversationId: string | null | undefined,
  next: ComposerStatusBarVisibility
): T {
  if (!conversationId) {
    return scope;
  }
  const normalized = normalizeComposerStatusBarVisibility(next);
  return {
    ...scope,
    composerStatusBarVisibilityByConversationId: pruneStatusBarPerConversationMap({
      ...(scope.composerStatusBarVisibilityByConversationId ?? {}),
      [conversationId]: normalized,
    }),
  };
}

export function normalizeComposerStatusBarVisibility(
  raw: unknown
): ComposerStatusBarVisibility {
  const base = { ...DEFAULT_COMPOSER_STATUS_BAR_VISIBILITY };
  if (!raw || typeof raw !== "object") {
    return base;
  }
  const record = raw as Partial<ComposerStatusBarVisibility>;
  return {
    repo: typeof record.repo === "boolean" ? record.repo : base.repo,
    branch: typeof record.branch === "boolean" ? record.branch : base.branch,
    goal: typeof record.goal === "boolean" ? record.goal : base.goal,
    context: typeof record.context === "boolean" ? record.context : base.context,
  };
}

export function resolveComposerRepoLabel(input: {
  gitStatus: GitWorkspaceStatus | null;
  workspaceName?: string | null;
}): string {
  const fromGit = input.gitStatus?.repoRoot?.split(/[\\/]/).filter(Boolean).at(-1);
  if (fromGit?.trim()) {
    return fromGit.trim();
  }
  const name = input.workspaceName?.trim();
  if (name) {
    return name;
  }
  return "Workspace";
}

export function resolveComposerBranchLabel(
  gitStatus: GitWorkspaceStatus | null
): string | null {
  if (!gitStatus?.isGitRepo) {
    return null;
  }
  return gitStatus.currentBranch?.trim() || "Detached";
}

export function formatContextTokenCount(tokens: number): string {
  if (tokens >= 1_000_000) {
    return `${(tokens / 1_000_000).toFixed(1).replace(/\.0$/, "")}M`;
  }
  if (tokens >= 1000) {
    const k = tokens / 1000;
    return k >= 100 ? `${Math.round(k)}K` : `${k.toFixed(1).replace(/\.0$/, "")}K`;
  }
  return String(tokens);
}

export function formatContextUsagePair(used: number, limit: number): string {
  return `~${formatContextTokenCount(used)} / ${formatContextTokenCount(limit)} Tokens`;
}
