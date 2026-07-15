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
