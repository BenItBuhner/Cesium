import { promises as fs } from "node:fs";
import path from "node:path";
import type {
  WorkspaceDiffFileStat,
  WorkspaceInsights,
  WorkspaceMergeStateKind,
} from "@cesium/core/quick-actions";
import { createEmptyWorkspaceInsights } from "@cesium/core/quick-actions";
import { runGit, tryGit } from "./git-worktrees.js";
import type { WorkspaceRecord } from "./workspace-registry.js";
import { listWorkspaceConversationRecords } from "./agents/session-store.js";
import { listCloudAgentTasks } from "./cloud-agents/tasks.js";
import { listTerminalSessions } from "../ws/terminal.js";

const MAX_DIFF_FILES = 100;
const MAX_UNTRACKED_LINE_COUNT_FILES = 50;
const MAX_UNTRACKED_LINE_COUNT_BYTES = 2_000_000;

/** Conversation statuses that count as "actively working" for the work pill. */
const ACTIVE_CONVERSATION_STATUSES = new Set([
  "running",
  "pause_requested",
  "pausing",
  "awaiting_permission",
  "awaiting_question",
]);

const CONFLICT_CODES = new Set(["DD", "AU", "UD", "UA", "DU", "AA", "UU"]);

type PorcelainSummary = {
  branch: string | null;
  detached: boolean;
  ahead: number;
  behind: number;
  hasUpstream: boolean;
  dirty: boolean;
  conflictedFiles: string[];
  untrackedFiles: string[];
};

/** Parses `git status --porcelain=v1 --branch` output. */
export function parseGitPorcelainStatus(stdout: string): PorcelainSummary {
  const summary: PorcelainSummary = {
    branch: null,
    detached: false,
    ahead: 0,
    behind: 0,
    hasUpstream: false,
    dirty: false,
    conflictedFiles: [],
    untrackedFiles: [],
  };
  for (const line of stdout.split(/\r?\n/)) {
    if (!line) {
      continue;
    }
    if (line.startsWith("## ")) {
      const header = line.slice(3);
      if (header.startsWith("HEAD (no branch)")) {
        summary.detached = true;
        continue;
      }
      const noCommits = header.match(/^No commits yet on (.+)$/);
      if (noCommits?.[1]) {
        summary.branch = noCommits[1].trim();
        continue;
      }
      const bracket = header.match(/\[([^\]]+)\]\s*$/);
      if (bracket?.[1]) {
        const ahead = bracket[1].match(/ahead (\d+)/);
        const behind = bracket[1].match(/behind (\d+)/);
        if (ahead?.[1]) summary.ahead = Number.parseInt(ahead[1], 10) || 0;
        if (behind?.[1]) summary.behind = Number.parseInt(behind[1], 10) || 0;
      }
      const names = header.replace(/\s*\[[^\]]+\]\s*$/, "");
      const dots = names.indexOf("...");
      if (dots >= 0) {
        summary.branch = names.slice(0, dots).trim() || null;
        summary.hasUpstream = true;
      } else {
        summary.branch = names.trim() || null;
      }
      continue;
    }
    summary.dirty = true;
    const code = line.slice(0, 2);
    const filePath = line.slice(3).trim();
    if (!filePath) {
      continue;
    }
    if (code === "??") {
      summary.untrackedFiles.push(unquoteGitPath(filePath));
      continue;
    }
    if (CONFLICT_CODES.has(code)) {
      summary.conflictedFiles.push(unquoteGitPath(filePath));
    }
  }
  return summary;
}

/** Strips the quoting git applies to paths with special characters. */
function unquoteGitPath(raw: string): string {
  if (raw.startsWith('"') && raw.endsWith('"') && raw.length >= 2) {
    try {
      return JSON.parse(raw) as string;
    } catch {
      return raw.slice(1, -1);
    }
  }
  // Rename entries look like "old -> new"; report the new path.
  const arrow = raw.indexOf(" -> ");
  return arrow >= 0 ? raw.slice(arrow + 4) : raw;
}

/** Parses `git diff --numstat` output into per-file stats. */
export function parseGitNumstat(stdout: string): WorkspaceDiffFileStat[] {
  const files: WorkspaceDiffFileStat[] = [];
  for (const line of stdout.split(/\r?\n/)) {
    if (!line.trim()) {
      continue;
    }
    const parts = line.split("\t");
    if (parts.length < 3) {
      continue;
    }
    const [addedRaw, removedRaw] = parts;
    const filePath = unquoteGitPath(parts.slice(2).join("\t"));
    const binary = addedRaw === "-" || removedRaw === "-";
    files.push({
      path: filePath,
      added: binary ? 0 : Number.parseInt(addedRaw ?? "0", 10) || 0,
      removed: binary ? 0 : Number.parseInt(removedRaw ?? "0", 10) || 0,
      binary,
    });
  }
  return files;
}

async function detectMergeState(repoRoot: string): Promise<WorkspaceMergeStateKind> {
  const gitDirResult = await tryGit(repoRoot, ["rev-parse", "--absolute-git-dir"]);
  const gitDir = gitDirResult?.stdout.trim();
  if (!gitDir) {
    return "none";
  }
  const exists = async (...segments: string[]): Promise<boolean> => {
    try {
      await fs.access(path.join(gitDir, ...segments));
      return true;
    } catch {
      return false;
    }
  };
  if (await exists("MERGE_HEAD")) {
    return "merging";
  }
  if ((await exists("rebase-merge")) || (await exists("rebase-apply"))) {
    return "rebasing";
  }
  if (await exists("CHERRY_PICK_HEAD")) {
    return "cherry-picking";
  }
  return "none";
}

/** Counts lines of an untracked file from disk (cheap approximation of numstat). */
async function countUntrackedFileLines(root: string, relPath: string): Promise<number> {
  try {
    const filePath = path.join(root, relPath);
    const stat = await fs.stat(filePath);
    if (!stat.isFile() || stat.size > MAX_UNTRACKED_LINE_COUNT_BYTES) {
      return 0;
    }
    const content = await fs.readFile(filePath, "utf8");
    if (content.includes("\0")) {
      return 0;
    }
    if (content.length === 0) {
      return 0;
    }
    let lines = 1;
    for (let index = 0; index < content.length; index += 1) {
      if (content.charCodeAt(index) === 10) {
        lines += 1;
      }
    }
    return content.endsWith("\n") ? lines - 1 : lines;
  } catch {
    return 0;
  }
}

async function collectGitInsights(
  workspace: WorkspaceRecord,
  insights: WorkspaceInsights
): Promise<void> {
  const topLevel = await tryGit(workspace.root, ["rev-parse", "--show-toplevel"]);
  const repoRoot = topLevel?.stdout.trim();
  if (!repoRoot) {
    return;
  }
  insights.isGitRepo = true;

  const [statusResult, mergeState] = await Promise.all([
    runGit(repoRoot, ["status", "--porcelain=v1", "--branch"]).catch(() => null),
    detectMergeState(repoRoot),
  ]);
  const porcelain = statusResult ? parseGitPorcelainStatus(statusResult.stdout) : null;
  if (porcelain) {
    insights.branch = porcelain.branch;
    insights.detached = porcelain.detached;
    insights.ahead = porcelain.ahead;
    insights.behind = porcelain.behind;
    insights.hasUpstream = porcelain.hasUpstream;
    insights.dirty = porcelain.dirty;
    insights.merge.conflictedFiles = porcelain.conflictedFiles.slice(0, MAX_DIFF_FILES);
  }
  insights.merge.state = mergeState;
  insights.merge.conflictsResolved =
    mergeState !== "none" && insights.merge.conflictedFiles.length === 0;

  // Tracked changes vs HEAD (staged + unstaged). Repos without commits have no
  // HEAD; fall back to the staged diff so brand-new repos still get counts.
  const numstat =
    (await tryGit(repoRoot, ["diff", "--numstat", "HEAD"])) ??
    (await tryGit(repoRoot, ["diff", "--numstat", "--cached"]));
  const files = numstat ? parseGitNumstat(numstat.stdout) : [];

  const conflictedSet = new Set(insights.merge.conflictedFiles);
  for (const file of files) {
    if (conflictedSet.has(file.path)) {
      file.conflicted = true;
    }
  }

  if (porcelain) {
    const countable = porcelain.untrackedFiles.slice(0, MAX_UNTRACKED_LINE_COUNT_FILES);
    const untrackedCounts = await Promise.all(
      countable.map((relPath) => countUntrackedFileLines(repoRoot, relPath))
    );
    porcelain.untrackedFiles.forEach((relPath, index) => {
      files.push({
        path: relPath,
        added: index < countable.length ? untrackedCounts[index] ?? 0 : 0,
        removed: 0,
        binary: false,
        untracked: true,
      });
    });
  }

  files.sort((a, b) => b.added + b.removed - (a.added + a.removed));
  insights.diff = {
    files: files.slice(0, MAX_DIFF_FILES),
    totalAdded: files.reduce((sum, file) => sum + file.added, 0),
    totalRemoved: files.reduce((sum, file) => sum + file.removed, 0),
    fileCount: files.length,
    truncated: files.length > MAX_DIFF_FILES,
  };
}

async function collectWorkInsights(
  workspace: WorkspaceRecord,
  insights: WorkspaceInsights
): Promise<void> {
  const [conversations, cloudTasks] = await Promise.all([
    listWorkspaceConversationRecords(workspace.id).catch(() => []),
    listCloudAgentTasks({ workspaceId: workspace.id }).catch(() => []),
  ]);
  const active = conversations.filter(
    (record) => record.archivedAt == null && ACTIVE_CONVERSATION_STATUSES.has(record.status)
  );
  insights.work.runningConversations = active.length;
  insights.work.runningConversationTitles = active
    .slice(0, 8)
    .map((record) => record.title || "Untitled chat");
  insights.work.aliveTerminals = listTerminalSessions().filter(
    (terminal) => terminal.workspaceId === workspace.id && terminal.alive
  ).length;
  insights.work.runningCloudTasks = cloudTasks.filter(
    (task) => task.status === "running" || task.status === "dispatching"
  ).length;
}

/**
 * Computes the composer insights snapshot for a workspace: diff totals,
 * merge/conflict state, branch sync, and background work counts. Never throws;
 * git failures degrade to an empty git section.
 */
export async function getWorkspaceInsights(
  workspace: WorkspaceRecord
): Promise<WorkspaceInsights> {
  const insights = createEmptyWorkspaceInsights();
  await Promise.all([
    collectGitInsights(workspace, insights).catch(() => undefined),
    collectWorkInsights(workspace, insights).catch(() => undefined),
  ]);
  insights.updatedAt = Date.now();
  return insights;
}
