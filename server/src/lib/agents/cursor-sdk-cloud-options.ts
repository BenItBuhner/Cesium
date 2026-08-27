import type { CloudAgentOptions } from "@cursor/sdk";
import { runGit } from "../git-worktrees.js";
import type { AgentExecutionTarget } from "./types.js";

/**
 * Metadata tag stamped onto every Cursor Cloud agent created by Cesium so the
 * remote agent can be traced back to its local conversation record (visible via
 * `Cursor.agents.get()` / the Cursor dashboard exports).
 */
export const CURSOR_SDK_CLOUD_METADATA_CONVERSATION_KEY = "cesiumConversationId";

export type CursorSdkCloudRepo = {
  url: string;
  startingRef?: string;
};

export type CursorSdkCloudOptionsInput = {
  workspaceRoot: string;
  conversationId: string;
  /** Injectable for tests; defaults to shelling out to `git` in the workspace. */
  resolveRepo?: (workspaceRoot: string) => Promise<CursorSdkCloudRepo | null>;
};

export function isCloudExecutionTarget(
  executionTarget: AgentExecutionTarget | undefined
): boolean {
  return executionTarget === "cloud";
}

/**
 * Converts a git remote URL into a form Cursor's cloud infrastructure can
 * clone. SSH remotes (scp-like `git@host:owner/repo.git` and `ssh://`) are
 * rewritten to `https://host/owner/repo` because the cloud VM authenticates
 * through the Cursor GitHub integration, not the user's local SSH keys.
 * Returns null for remotes that cannot be expressed as an HTTPS clone URL
 * (e.g. local file paths), which fall back to a no-repo cloud VM.
 */
export function normalizeCursorSdkCloudRepoUrl(remoteUrl: string): string | null {
  const value = remoteUrl.trim();
  if (!value) {
    return null;
  }
  const stripGitSuffix = (input: string): string => input.replace(/\.git$/i, "");
  if (!value.includes("://")) {
    // scp-like syntax: [user@]host:path - anything else (bare paths) is local.
    const scpLike = value.match(/^(?:[^@\s/:]+@)?([^:/\s]+):(.+)$/);
    if (!scpLike) {
      return null;
    }
    const host = scpLike[1] ?? "";
    const repoPath = stripGitSuffix((scpLike[2] ?? "").replace(/^\/+|\/+$/g, ""));
    if (!host || !repoPath) {
      return null;
    }
    return `https://${host}/${repoPath}`;
  }
  try {
    const parsed = new URL(value);
    if (!["http:", "https:", "ssh:", "git:"].includes(parsed.protocol)) {
      return null;
    }
    const host = parsed.hostname;
    const repoPath = stripGitSuffix(parsed.pathname.replace(/^\/+|\/+$/g, ""));
    if (!host || !repoPath) {
      return null;
    }
    if (parsed.protocol === "http:" || parsed.protocol === "https:") {
      const port = parsed.port ? `:${parsed.port}` : "";
      return `${parsed.protocol}//${host}${port}/${repoPath}`;
    }
    return `https://${host}/${repoPath}`;
  } catch {
    return null;
  }
}

async function tryGitStdout(cwd: string, args: string[]): Promise<string | null> {
  try {
    const result = await runGit(cwd, args);
    const stdout = result.stdout.trim();
    return stdout || null;
  } catch {
    return null;
  }
}

/** Default repo resolver: `origin` remote (else first remote) + current branch. */
export async function resolveCursorSdkCloudRepo(
  workspaceRoot: string
): Promise<CursorSdkCloudRepo | null> {
  let remoteUrl = await tryGitStdout(workspaceRoot, ["remote", "get-url", "origin"]);
  if (!remoteUrl) {
    const remotes = await tryGitStdout(workspaceRoot, ["remote"]);
    const firstRemote = remotes
      ?.split(/\r?\n/)
      .map((remote) => remote.trim())
      .find(Boolean);
    if (firstRemote) {
      remoteUrl = await tryGitStdout(workspaceRoot, ["remote", "get-url", firstRemote]);
    }
  }
  if (!remoteUrl) {
    return null;
  }
  const url = normalizeCursorSdkCloudRepoUrl(remoteUrl);
  if (!url) {
    return null;
  }
  const branch = await tryGitStdout(workspaceRoot, ["branch", "--show-current"]);
  return branch ? { url, startingRef: branch } : { url };
}

/**
 * Builds the `cloud:` options passed to `Agent.create` for conversations whose
 * `executionTarget` is "cloud". When the workspace has a network git remote the
 * cloud VM clones it at the workspace's current branch and works on that
 * branch; workspaces without a usable remote get a no-repo cloud VM.
 */
export async function buildCursorSdkCloudOptions(
  input: CursorSdkCloudOptionsInput
): Promise<CloudAgentOptions> {
  const resolveRepo = input.resolveRepo ?? resolveCursorSdkCloudRepo;
  const repo = await resolveRepo(input.workspaceRoot);
  return {
    repos: repo ? [repo] : [],
    ...(repo ? { workOnCurrentBranch: true } : {}),
    autoCreatePR: false,
    metadata: {
      [CURSOR_SDK_CLOUD_METADATA_CONVERSATION_KEY]: input.conversationId,
    },
  };
}
