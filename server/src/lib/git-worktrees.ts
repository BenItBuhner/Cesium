import { spawn } from "node:child_process";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { normalizeWorkspaceRoot } from "./persistence.js";
import type { WorkspaceRecord } from "./workspace-registry.js";

const GIT_TIMEOUT_MS = 30_000;
const GIT_MUTATION_TIMEOUT_MS = 120_000;
const SETUP_TIMEOUT_MS = 900_000;
const STDERR_LIMIT = 12_000;

export type GitBranchInfo = {
  name: string;
  type: "local" | "remote";
  current: boolean;
  upstream?: string;
};

export type GitWorktreeInfo = {
  path: string;
  branch: string | null;
  head: string | null;
  detached: boolean;
  bare: boolean;
  current: boolean;
  workspaceId?: string;
  workspaceName?: string;
};

export type GitWorkspaceStatus = {
  isGitRepo: boolean;
  root: string;
  repoRoot?: string;
  repoKey?: string;
  currentBranch?: string | null;
  detached?: boolean;
  dirty?: boolean;
  aheadBehind?: { ahead: number; behind: number } | null;
  branches: GitBranchInfo[];
  worktrees: GitWorktreeInfo[];
  error?: string;
};

export type WorktreeSetupResult = {
  ran: boolean;
  sourcePath?: string;
  commands: string[];
  output: string[];
};

type GitResult = {
  stdout: string;
  stderr: string;
};

type ParsedWorktreeBlock = {
  worktree?: string;
  HEAD?: string;
  branch?: string;
  bare?: true;
  detached?: true;
};

function truncateStderr(stderr: string): string {
  const trimmed = stderr.trim();
  if (trimmed.length <= STDERR_LIMIT) {
    return trimmed;
  }
  return `${trimmed.slice(0, STDERR_LIMIT)}\n... truncated ...`;
}

function gitError(stderr: string, fallback: string): Error {
  return new Error(truncateStderr(stderr) || fallback);
}

async function runGit(
  cwd: string,
  args: string[],
  timeoutMs = GIT_TIMEOUT_MS
): Promise<GitResult> {
  return new Promise<GitResult>((resolve, reject) => {
    const child = spawn("git", args, {
      cwd,
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });
    let stdout = "";
    let stderr = "";
    child.stdout?.on("data", (chunk: Buffer | string) => {
      stdout += String(chunk);
    });
    child.stderr?.on("data", (chunk: Buffer | string) => {
      stderr += String(chunk);
    });
    const timeout = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error(`git ${args[0] ?? ""} timed out.`));
    }, timeoutMs);
    child.on("error", (error) => {
      clearTimeout(timeout);
      const message = error instanceof Error ? error.message : String(error);
      if (message.includes("ENOENT")) {
        reject(new Error("`git` was not found. Install Git on the OpenCursor host."));
        return;
      }
      reject(error);
    });
    child.on("close", (code) => {
      clearTimeout(timeout);
      if (code === 0) {
        resolve({ stdout, stderr });
        return;
      }
      reject(gitError(stderr, `git ${args.join(" ")} failed (exit ${code ?? "unknown"}).`));
    });
  });
}

async function tryGit(cwd: string, args: string[]): Promise<GitResult | null> {
  try {
    return await runGit(cwd, args);
  } catch {
    return null;
  }
}

function parsePorcelainWorktrees(raw: string): ParsedWorktreeBlock[] {
  const blocks: ParsedWorktreeBlock[] = [];
  let current: ParsedWorktreeBlock | null = null;
  for (const line of raw.split(/\r?\n/)) {
    if (!line.trim()) {
      if (current) {
        blocks.push(current);
        current = null;
      }
      continue;
    }
    const space = line.indexOf(" ");
    const key = space >= 0 ? line.slice(0, space) : line;
    const value = space >= 0 ? line.slice(space + 1) : "";
    if (key === "worktree") {
      if (current) {
        blocks.push(current);
      }
      current = { worktree: value };
      continue;
    }
    if (!current) {
      current = {};
    }
    switch (key) {
      case "HEAD":
        current.HEAD = value;
        break;
      case "branch":
        current.branch = value;
        break;
      case "bare":
        current.bare = true;
        break;
      case "detached":
        current.detached = true;
        break;
      default:
        break;
    }
  }
  if (current) {
    blocks.push(current);
  }
  return blocks;
}

function shortBranchName(ref: string | undefined): string | null {
  if (!ref) {
    return null;
  }
  if (ref.startsWith("refs/heads/")) {
    return ref.slice("refs/heads/".length);
  }
  return ref;
}

function normalizeRemoteBranchName(name: string): string {
  return name.replace(/^remotes\//, "");
}

function slugifyBranch(value: string): string {
  const slug = value
    .trim()
    .replace(/^refs\/heads\//, "")
    .replace(/^origin\//, "")
    .replace(/[^a-zA-Z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return slug || `worktree-${Date.now().toString(36)}`;
}

async function repoRootFor(workspaceRoot: string): Promise<string | null> {
  const result = await tryGit(workspaceRoot, ["rev-parse", "--show-toplevel"]);
  const root = result?.stdout.trim();
  return root ? normalizeWorkspaceRoot(root) : null;
}

async function repoKeyFor(repoRoot: string): Promise<string | undefined> {
  const result = await tryGit(repoRoot, ["rev-parse", "--git-common-dir"]);
  const raw = result?.stdout.trim();
  if (!raw) {
    return undefined;
  }
  const resolved = path.isAbsolute(raw) ? raw : path.resolve(repoRoot, raw);
  return fs.realpath(resolved).catch(() => resolved);
}

async function currentBranchFor(repoRoot: string): Promise<string | null> {
  const result = await tryGit(repoRoot, ["branch", "--show-current"]);
  const branch = result?.stdout.trim();
  return branch || null;
}

async function aheadBehindFor(repoRoot: string): Promise<{ ahead: number; behind: number } | null> {
  const upstream = await tryGit(repoRoot, ["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{u}"]);
  if (!upstream?.stdout.trim()) {
    return null;
  }
  const result = await tryGit(repoRoot, ["rev-list", "--left-right", "--count", "HEAD...@{u}"]);
  const parts = result?.stdout.trim().split(/\s+/) ?? [];
  const ahead = Number.parseInt(parts[0] ?? "", 10);
  const behind = Number.parseInt(parts[1] ?? "", 10);
  if (!Number.isFinite(ahead) || !Number.isFinite(behind)) {
    return null;
  }
  return { ahead, behind };
}

async function listBranches(repoRoot: string, currentBranch: string | null): Promise<GitBranchInfo[]> {
  const format = "%(refname:short)%09%(upstream:short)";
  const result = await runGit(repoRoot, ["for-each-ref", "--format", format, "refs/heads", "refs/remotes"]);
  const seen = new Set<string>();
  const branches: GitBranchInfo[] = [];
  for (const line of result.stdout.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed) {
      continue;
    }
    const [rawName, upstream] = trimmed.split("\t");
    if (!rawName || rawName === "origin/HEAD") {
      continue;
    }
    const type: GitBranchInfo["type"] = rawName.includes("/") && rawName.startsWith("origin/")
      ? "remote"
      : "local";
    const name = type === "remote" ? normalizeRemoteBranchName(rawName) : rawName;
    const key = `${type}:${name}`;
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    branches.push({
      name,
      type,
      current: type === "local" && name === currentBranch,
      ...(upstream ? { upstream } : {}),
    });
  }
  return branches.sort((a, b) => {
    if (a.current !== b.current) return a.current ? -1 : 1;
    if (a.type !== b.type) return a.type === "local" ? -1 : 1;
    return a.name.localeCompare(b.name);
  });
}

async function listWorktrees(
  repoRoot: string,
  currentRoot: string,
  workspaces: WorkspaceRecord[]
): Promise<GitWorktreeInfo[]> {
  const result = await runGit(repoRoot, ["worktree", "list", "--porcelain"]);
  const workspaceByRoot = new Map(workspaces.map((workspace) => [workspace.root, workspace]));
  const currentNormalized = await normalizeWorkspaceRoot(currentRoot);
  const items: GitWorktreeInfo[] = [];
  for (const block of parsePorcelainWorktrees(result.stdout)) {
    if (!block.worktree) {
      continue;
    }
    const normalizedPath = await normalizeWorkspaceRoot(block.worktree);
    const workspace = workspaceByRoot.get(normalizedPath);
    items.push({
      path: normalizedPath,
      branch: shortBranchName(block.branch),
      head: block.HEAD ?? null,
      detached: block.detached === true || !block.branch,
      bare: block.bare === true,
      current: normalizedPath === currentNormalized,
      ...(workspace ? { workspaceId: workspace.id, workspaceName: workspace.name } : {}),
    });
  }
  return items;
}

export async function getGitWorkspaceStatus(
  workspace: WorkspaceRecord,
  workspaces: WorkspaceRecord[]
): Promise<GitWorkspaceStatus> {
  const root = workspace.root;
  const repoRoot = await repoRootFor(root);
  if (!repoRoot) {
    return {
      isGitRepo: false,
      root,
      branches: [],
      worktrees: [],
    };
  }
  try {
    const [currentBranch, status, repoKey] = await Promise.all([
      currentBranchFor(repoRoot),
      runGit(repoRoot, ["status", "--porcelain=v1", "--branch"]),
      repoKeyFor(repoRoot),
    ]);
    const [branches, worktrees, aheadBehind] = await Promise.all([
      listBranches(repoRoot, currentBranch),
      listWorktrees(repoRoot, root, workspaces),
      aheadBehindFor(repoRoot),
    ]);
    return {
      isGitRepo: true,
      root,
      repoRoot,
      repoKey,
      currentBranch,
      detached: currentBranch === null,
      dirty: status.stdout.split(/\r?\n/).some((line) => line.trim() && !line.startsWith("##")),
      aheadBehind,
      branches,
      worktrees,
    };
  } catch (error) {
    return {
      isGitRepo: true,
      root,
      repoRoot,
      branches: [],
      worktrees: [],
      error: error instanceof Error ? error.message : "Failed to read git status.",
    };
  }
}

export async function assertValidBranchName(repoRoot: string, branch: string): Promise<string> {
  const trimmed = branch.trim();
  if (!trimmed) {
    throw new Error("Branch name is required.");
  }
  if (/[\n\r\0]/.test(trimmed)) {
    throw new Error("Branch name contains invalid characters.");
  }
  await runGit(repoRoot, ["check-ref-format", "--branch", trimmed]);
  return trimmed;
}

function branchCheckedOut(status: GitWorkspaceStatus, branch: string): GitWorktreeInfo | null {
  return status.worktrees.find((worktree) => worktree.branch === branch) ?? null;
}

export async function switchWorkspaceBranch(input: {
  workspace: WorkspaceRecord;
  workspaces: WorkspaceRecord[];
  branch: string;
}): Promise<{ status: GitWorkspaceStatus; checkedOutWorktree?: GitWorktreeInfo }> {
  const status = await getGitWorkspaceStatus(input.workspace, input.workspaces);
  if (!status.isGitRepo || !status.repoRoot) {
    throw new Error("Workspace is not a git repository.");
  }
  const branch = await assertValidBranchName(status.repoRoot, input.branch);
  const checkedOut = branchCheckedOut(status, branch);
  if (checkedOut && !checkedOut.current) {
    return { status, checkedOutWorktree: checkedOut };
  }
  if (status.dirty) {
    throw new Error("Cannot switch branches with uncommitted changes. Create a worktree instead.");
  }
  await runGit(status.repoRoot, ["switch", branch], GIT_MUTATION_TIMEOUT_MS);
  return {
    status: await getGitWorkspaceStatus(input.workspace, input.workspaces),
  };
}

export function defaultWorktreePath(repoRoot: string, branch: string): string {
  const repoName = path.basename(repoRoot) || "repo";
  return path.join(path.dirname(repoRoot), ".opencursor-worktrees", repoName, slugifyBranch(branch));
}

async function readJsonIfExists(filePath: string): Promise<unknown | null> {
  try {
    const raw = await fs.readFile(filePath, "utf8");
    return JSON.parse(raw) as unknown;
  } catch (error) {
    if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") {
      return null;
    }
    throw error;
  }
}

function setupKeyForPlatform(): "setup-worktree-windows" | "setup-worktree-unix" {
  return os.platform() === "win32" ? "setup-worktree-windows" : "setup-worktree-unix";
}

function extractSetupCommands(config: unknown): { commands: string[]; script?: string } | null {
  if (!config || typeof config !== "object") {
    return null;
  }
  const record = config as Record<string, unknown>;
  const platformValue = record[setupKeyForPlatform()] ?? record["setup-worktree"];
  if (Array.isArray(platformValue)) {
    const commands = platformValue.filter((value): value is string => typeof value === "string" && value.trim().length > 0);
    return commands.length > 0 ? { commands } : null;
  }
  if (typeof platformValue === "string" && platformValue.trim()) {
    return { commands: [], script: platformValue.trim() };
  }
  return null;
}

async function runSetupCommand(
  cwd: string,
  command: string,
  env: NodeJS.ProcessEnv
): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    const child = spawn(command, {
      cwd,
      env,
      shell: true,
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });
    let output = "";
    child.stdout?.on("data", (chunk: Buffer | string) => {
      output += String(chunk);
    });
    child.stderr?.on("data", (chunk: Buffer | string) => {
      output += String(chunk);
    });
    const timeout = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error(`Worktree setup command timed out: ${command}`));
    }, SETUP_TIMEOUT_MS);
    child.on("error", (error) => {
      clearTimeout(timeout);
      reject(error);
    });
    child.on("close", (code) => {
      clearTimeout(timeout);
      if (code === 0) {
        resolve(output.trim());
        return;
      }
      reject(new Error(truncateStderr(output) || `Worktree setup command failed: ${command}`));
    });
  });
}

export async function runWorktreeSetup(input: {
  rootWorktreePath: string;
  worktreePath: string;
  branchName: string;
}): Promise<WorktreeSetupResult> {
  const candidateFiles = [
    path.join(input.worktreePath, ".cursor", "worktrees.json"),
    path.join(input.rootWorktreePath, ".cursor", "worktrees.json"),
  ];
  for (const filePath of candidateFiles) {
    const config = await readJsonIfExists(filePath);
    const setup = extractSetupCommands(config);
    if (!setup) {
      continue;
    }
    const commands = setup.script
      ? [path.resolve(path.dirname(filePath), setup.script)]
      : setup.commands;
    const env = {
      ...process.env,
      ROOT_WORKTREE_PATH: input.rootWorktreePath,
      WORKTREE_PATH: input.worktreePath,
      BRANCH_NAME: input.branchName,
      REPO_ROOT: input.rootWorktreePath,
    };
    const output: string[] = [];
    for (const command of commands) {
      output.push(await runSetupCommand(input.worktreePath, command, env));
    }
    return { ran: true, sourcePath: filePath, commands, output };
  }
  return { ran: false, commands: [], output: [] };
}

export async function createWorkspaceWorktree(input: {
  workspace: WorkspaceRecord;
  workspaces: WorkspaceRecord[];
  branch: string;
  baseBranch?: string;
  newBranch?: boolean;
  targetPath?: string;
  runSetup?: boolean;
}): Promise<{
  path: string;
  branch: string;
  setup: WorktreeSetupResult;
  existingWorktree?: GitWorktreeInfo;
}> {
  const status = await getGitWorkspaceStatus(input.workspace, input.workspaces);
  if (!status.isGitRepo || !status.repoRoot) {
    throw new Error("Workspace is not a git repository.");
  }
  const branch = await assertValidBranchName(status.repoRoot, input.branch);
  const existing = branchCheckedOut(status, branch);
  if (existing) {
    return {
      path: existing.path,
      branch,
      setup: { ran: false, commands: [], output: [] },
      existingWorktree: existing,
    };
  }
  const targetPath = input.targetPath
    ? path.resolve(input.targetPath)
    : defaultWorktreePath(status.repoRoot, branch);
  await fs.mkdir(path.dirname(targetPath), { recursive: true });
  const args = ["worktree", "add"];
  if (input.newBranch) {
    args.push("-b", branch);
  }
  args.push(targetPath);
  if (input.baseBranch?.trim()) {
    args.push(input.baseBranch.trim());
  } else if (!input.newBranch) {
    args.push(branch);
  }
  await runGit(status.repoRoot, args, GIT_MUTATION_TIMEOUT_MS);
  const normalizedPath = await normalizeWorkspaceRoot(targetPath);
  const setup = input.runSetup === false
    ? { ran: false, commands: [], output: [] }
    : await runWorktreeSetup({
        rootWorktreePath: status.repoRoot,
        worktreePath: normalizedPath,
        branchName: branch,
      });
  return { path: normalizedPath, branch, setup };
}

export async function deleteWorkspaceWorktree(input: {
  workspace: WorkspaceRecord;
  workspaces: WorkspaceRecord[];
  targetPath: string;
  force?: boolean;
}): Promise<void> {
  const status = await getGitWorkspaceStatus(input.workspace, input.workspaces);
  if (!status.isGitRepo || !status.repoRoot) {
    throw new Error("Workspace is not a git repository.");
  }
  const target = await normalizeWorkspaceRoot(input.targetPath);
  const worktree = status.worktrees.find((item) => item.path === target);
  if (!worktree) {
    throw new Error("Target path is not a worktree for this repository.");
  }
  if (worktree.current) {
    throw new Error("Cannot delete the active workspace worktree.");
  }
  if (!input.force) {
    const targetStatus = await runGit(target, ["status", "--porcelain=v1"]);
    if (targetStatus.stdout.trim()) {
      throw new Error("Cannot delete a dirty worktree without force.");
    }
  }
  await runGit(
    status.repoRoot,
    ["worktree", "remove", ...(input.force ? ["--force"] : []), target],
    GIT_MUTATION_TIMEOUT_MS
  );
}
