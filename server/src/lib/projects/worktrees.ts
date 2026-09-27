import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { createWorkspaceWorktree, runGit, tryGit } from "../git-worktrees.js";
import {
  ensureWorkspaceRegistered,
  listWorkspaces,
  removeWorkspace,
  type WorkspaceRecord,
} from "../workspace-registry.js";
import { getProjectDir, isWorkerWorktreeRoot } from "./paths.js";

export { isWorkerWorktreeRoot };

/**
 * Folders the engine writes into a workspace for its own use (skills and MCP
 * mirrors, plans and artifacts). A worker's `git add -A` must not pick them up.
 */
const ENGINE_WORKSPACE_EXCLUDES = ["agent-skills/", "mcp-servers/", ".cesium/"];

const FETCH_TIMEOUT_MS = 120_000;
const LS_REMOTE_TIMEOUT_MS = 20_000;
const WORKTREE_REMOVE_TIMEOUT_MS = 120_000;

/** The repository cannot host a worktree at all (not a git repository). */
export class WorkerIsolationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "WorkerIsolationError";
  }
}

/** The request itself is wrong (e.g. a base branch that doesn't exist); never falls back. */
export class WorkerPlacementError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "WorkerPlacementError";
  }
}

/**
 * Worker worktrees live in the Project's own folder on the engine that hosts
 * them. That keeps them out of the user's repository and, because they sit in
 * the Projects tree, marks their workspaces engine-managed (no rail group, no
 * recents) without a new workspace kind.
 */
export function getProjectWorktreesDir(projectId: string): string {
  return path.join(getProjectDir(projectId), "worktrees");
}

export type WorkerRepoGit = {
  isGitRepo: boolean;
  repoRoot: string | null;
  hasOrigin: boolean;
};

export async function inspectWorkerRepo(root: string): Promise<WorkerRepoGit> {
  const top = await tryGit(root, ["rev-parse", "--show-toplevel"]);
  if (!top) {
    return { isGitRepo: false, repoRoot: null, hasOrigin: false };
  }
  const origin = await tryGit(root, ["remote", "get-url", "origin"]);
  return {
    isGitRepo: true,
    repoRoot: top.stdout.trim() || root,
    hasOrigin: Boolean(origin?.stdout.trim()),
  };
}

/** The remote's default branch, else the checkout's current branch, else `main`. */
async function defaultBaseBranch(repoRoot: string, hasOrigin: boolean): Promise<string> {
  if (hasOrigin) {
    const head = await tryGit(repoRoot, ["symbolic-ref", "--quiet", "--short", "refs/remotes/origin/HEAD"]);
    const fromHead = head?.stdout.trim().replace(/^origin\//, "");
    if (fromHead) {
      return fromHead;
    }
    const remote = await runGit(
      repoRoot,
      ["ls-remote", "--symref", "origin", "HEAD"],
      LS_REMOTE_TIMEOUT_MS
    ).catch(() => null);
    const match = remote?.stdout.match(/^ref:\s+refs\/heads\/(\S+)\s+HEAD/m);
    if (match) {
      return match[1]!;
    }
  }
  const current = (await tryGit(repoRoot, ["rev-parse", "--abbrev-ref", "HEAD"]))?.stdout.trim();
  return current && current !== "HEAD" ? current : "main";
}

/** Commands from `.cesium/worktrees.json` or `.cursor/worktrees.json`, for the worker to run first. */
export type WorkerSetupPlan = {
  sourcePath: string;
  commands: string[];
};

function setupCommandsFrom(config: unknown, configDir: string): string[] {
  if (!config || typeof config !== "object") {
    return [];
  }
  const record = config as Record<string, unknown>;
  const key = os.platform() === "win32" ? "setup-worktree-windows" : "setup-worktree-unix";
  const value = record[key] ?? record["setup-worktree"];
  if (Array.isArray(value)) {
    return value.filter((entry): entry is string => typeof entry === "string" && entry.trim().length > 0);
  }
  if (typeof value === "string" && value.trim()) {
    return [path.resolve(configDir, value.trim())];
  }
  return [];
}

export async function readWorkerSetupPlan(
  worktreePath: string,
  repoRoot: string
): Promise<WorkerSetupPlan | null> {
  const candidates = [worktreePath, repoRoot].flatMap((root) => [
    path.join(root, ".cesium", "worktrees.json"),
    path.join(root, ".cursor", "worktrees.json"),
  ]);
  for (const candidate of candidates) {
    const raw = await fs.readFile(candidate, "utf8").catch(() => null);
    if (raw == null) {
      continue;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      continue;
    }
    const commands = setupCommandsFrom(parsed, path.dirname(candidate));
    if (commands.length > 0) {
      return { sourcePath: candidate, commands };
    }
  }
  return null;
}

export type WorkerWorktree = {
  workspace: WorkspaceRecord;
  worktreePath: string;
  repoRoot: string;
  branch: string;
  baseBranch: string;
  /** `origin/<base>` when the repository has a remote, else the local branch. */
  baseRef: string;
  baseSha: string;
  hasOrigin: boolean;
  /** Set when the remote could not be fetched and the worker starts from the last fetched copy. */
  warning: string | null;
  setup: WorkerSetupPlan | null;
};

/**
 * Gives a worker its own checkout: fetches the base branch, adds a worktree on
 * a fresh branch from it (not tracking the base, so `git push -u origin
 * <branch>` sets the right upstream) and registers it as the worker's
 * workspace.
 */
export async function createWorkerWorktree(input: {
  projectId: string;
  repoWorkspace: WorkspaceRecord;
  branch: string;
  baseBranch: string | null;
  label: string;
}): Promise<WorkerWorktree> {
  const git = await inspectWorkerRepo(input.repoWorkspace.root);
  if (!git.isGitRepo || !git.repoRoot) {
    throw new WorkerIsolationError(
      `${input.repoWorkspace.name} is not a git repository, so the agent cannot get its own worktree and branch.`
    );
  }
  const repoRoot = git.repoRoot;
  const baseBranch = input.baseBranch?.trim() || (await defaultBaseBranch(repoRoot, git.hasOrigin));
  let baseRef = baseBranch;
  let warning: string | null = null;
  if (git.hasOrigin) {
    try {
      await runGit(repoRoot, ["fetch", "--quiet", "origin", baseBranch], FETCH_TIMEOUT_MS);
    } catch (error) {
      const reason = error instanceof Error ? error.message.split("\n")[0] : String(error);
      warning = `Could not fetch origin/${baseBranch} (${reason}); the branch starts from the last fetched copy.`;
    }
    if (await tryGit(repoRoot, ["rev-parse", "--verify", "--quiet", `refs/remotes/origin/${baseBranch}`])) {
      baseRef = `origin/${baseBranch}`;
    }
  }
  const sha = (await tryGit(repoRoot, ["rev-parse", "--verify", "--quiet", `${baseRef}^{commit}`]))?.stdout.trim();
  if (!sha) {
    throw new WorkerPlacementError(`Base branch "${baseBranch}" does not exist in ${input.repoWorkspace.name}.`);
  }
  const dir = getProjectWorktreesDir(input.projectId);
  await fs.mkdir(dir, { recursive: true });
  const targetPath = path.join(dir, input.branch.split("/").pop() || "worker");
  const created = await createWorkspaceWorktree({
    workspace: input.repoWorkspace,
    workspaces: await listWorkspaces(),
    branch: input.branch,
    newBranch: true,
    baseBranch: sha,
    targetPath,
    runSetup: false,
  });
  await excludeEngineFolders(created.path);
  const workspace = await ensureWorkspaceRegistered(created.path, input.label, { trackOpen: false });
  return {
    workspace,
    worktreePath: created.path,
    repoRoot,
    branch: created.branch,
    baseBranch,
    baseRef,
    baseSha: sha,
    hasOrigin: git.hasOrigin,
    warning,
    setup: await readWorkerSetupPlan(created.path, repoRoot),
  };
}

/**
 * Adds the engine's own folders to the repository's shared `info/exclude`
 * (it applies to every worktree) so they never show up as changes to commit.
 */
async function excludeEngineFolders(worktreePath: string): Promise<void> {
  const common = (
    await tryGit(worktreePath, ["rev-parse", "--path-format=absolute", "--git-common-dir"])
  )?.stdout.trim();
  if (!common) {
    return;
  }
  const excludePath = path.join(common, "info", "exclude");
  const current = await fs.readFile(excludePath, "utf8").catch(() => "");
  const lines = new Set(current.split(/\r?\n/).map((line) => line.trim()));
  const missing = ENGINE_WORKSPACE_EXCLUDES.filter((entry) => !lines.has(entry));
  if (missing.length === 0) {
    return;
  }
  await fs.mkdir(path.dirname(excludePath), { recursive: true });
  const prefix = current.length > 0 && !current.endsWith("\n") ? "\n" : "";
  await fs.appendFile(
    excludePath,
    `${prefix}# Cesium engine folders (kept out of Project worker commits)\n${missing.join("\n")}\n`,
    "utf8"
  );
}

/**
 * Removes a worker's worktree (uncommitted changes included) and its workspace
 * registration. The branch stays, so pushed work and open PRs are untouched.
 */
export async function removeWorkerWorktree(workspace: WorkspaceRecord): Promise<void> {
  const worktreePath = workspace.root;
  const common = (
    await tryGit(worktreePath, ["rev-parse", "--path-format=absolute", "--git-common-dir"])
  )?.stdout.trim();
  if (common) {
    await runGit(
      common,
      [`--git-dir=${common}`, "worktree", "remove", "--force", worktreePath],
      WORKTREE_REMOVE_TIMEOUT_MS
    ).catch((error) => {
      console.warn(
        `[projects] git worktree remove failed for ${worktreePath}:`,
        error instanceof Error ? error.message : error
      );
    });
    await tryGit(common, [`--git-dir=${common}`, "worktree", "prune"]);
  }
  await fs.rm(worktreePath, { recursive: true, force: true }).catch(() => undefined);
  await removeWorkspace(workspace.id).catch(() => undefined);
}
