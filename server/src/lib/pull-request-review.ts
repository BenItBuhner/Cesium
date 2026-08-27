import { spawn } from "node:child_process";
import type {
  PullRequestGitHubComment,
  PullRequestGitHubInfo,
  PullRequestReview,
  PullRequestReviewCommit,
  PullRequestReviewFile,
  PullRequestReviewFileStatus,
} from "@cesium/core";
import { runGit, tryGit } from "./git-worktrees.js";
import type { WorkspaceRecord } from "./workspace-registry.js";

const MAX_REVIEW_COMMITS = 250;
const MAX_REVIEW_FILES = 300;
/** Per-file unified diff cap; keeps huge lockfile patches from flooding the payload. */
const MAX_FILE_PATCH_CHARS = 60_000;
/** Whole-payload patch budget across all files. */
const MAX_TOTAL_PATCH_CHARS = 1_500_000;
const GH_TIMEOUT_MS = 15_000;

/** Preferred comparison bases, checked in order when no override is given. */
const DEFAULT_BASE_CANDIDATES = [
  "origin/main",
  "origin/master",
  "origin/develop",
  "main",
  "master",
  "develop",
];

type GhResult = { ok: true; stdout: string } | { ok: false; error: string };

function runGh(cwd: string, args: string[]): Promise<GhResult> {
  return new Promise((resolve) => {
    const child = spawn("gh", args, {
      cwd,
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
      env: { ...process.env, GH_PROMPT_DISABLED: "1", GH_NO_UPDATE_NOTIFIER: "1" },
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
      resolve({ ok: false, error: "GitHub CLI timed out." });
    }, GH_TIMEOUT_MS);
    child.on("error", (error) => {
      clearTimeout(timeout);
      const message = error instanceof Error ? error.message : String(error);
      resolve({
        ok: false,
        error: message.includes("ENOENT")
          ? "GitHub CLI (`gh`) is not installed on the Cesium host."
          : message,
      });
    });
    child.on("close", (code) => {
      clearTimeout(timeout);
      if (code === 0) {
        resolve({ ok: true, stdout });
        return;
      }
      resolve({
        ok: false,
        error: stderr.trim().slice(0, 600) || `gh exited with code ${code ?? "unknown"}.`,
      });
    });
  });
}

function epochMs(value: unknown): number | undefined {
  if (typeof value !== "string" || !value) {
    return undefined;
  }
  const parsed = Date.parse(value);
  return Number.isNaN(parsed) ? undefined : parsed;
}

async function refExists(root: string, ref: string): Promise<boolean> {
  const result = await tryGit(root, ["rev-parse", "--verify", "--quiet", `${ref}^{commit}`]);
  return result != null;
}

/** origin/HEAD symref (e.g. `origin/main`) when the remote default branch is known locally. */
async function detectRemoteDefaultBranch(root: string): Promise<string | null> {
  const symref = await tryGit(root, [
    "symbolic-ref",
    "--short",
    "refs/remotes/origin/HEAD",
  ]);
  const name = symref?.stdout.trim();
  return name ? name : null;
}

async function resolveBaseBranch(
  root: string,
  headBranch: string | null,
  override: string | undefined
): Promise<{ baseBranch: string | null; candidateBases: string[] }> {
  const candidates: string[] = [];
  const seen = new Set<string>();
  const pushCandidate = (ref: string | null) => {
    if (!ref || seen.has(ref)) {
      return;
    }
    seen.add(ref);
    candidates.push(ref);
  };

  pushCandidate(await detectRemoteDefaultBranch(root));
  for (const ref of DEFAULT_BASE_CANDIDATES) {
    if (await refExists(root, ref)) {
      pushCandidate(ref);
    }
  }

  // Never compare a branch against itself (e.g. sitting on main already).
  const usable = candidates.filter((ref) => {
    if (!headBranch) {
      return true;
    }
    return ref !== headBranch && ref !== `origin/${headBranch}`;
  });

  if (override) {
    if (await refExists(root, override)) {
      return { baseBranch: override, candidateBases: candidates };
    }
    return { baseBranch: usable[0] ?? null, candidateBases: candidates };
  }
  return { baseBranch: usable[0] ?? null, candidateBases: candidates };
}

function parseCommits(stdout: string): PullRequestReviewCommit[] {
  // Records separated by \x1e, fields by \x1f: sha, shortSha, authorName, authorEmail, authoredAt, subject, body
  const commits: PullRequestReviewCommit[] = [];
  for (const record of stdout.split("\x1e")) {
    const trimmed = record.replace(/^\n+/, "");
    if (!trimmed.trim()) {
      continue;
    }
    const fields = trimmed.split("\x1f");
    if (fields.length < 6) {
      continue;
    }
    const [sha, shortSha, authorName, authorEmail, authoredAtRaw, subject, body] = fields;
    const authoredAtSeconds = Number.parseInt(authoredAtRaw ?? "", 10);
    commits.push({
      sha: sha ?? "",
      shortSha: shortSha ?? (sha ?? "").slice(0, 7),
      subject: (subject ?? "").trim(),
      body: body?.trim() ? body.trim() : undefined,
      authorName: (authorName ?? "").trim() || "Unknown",
      authorEmail: authorEmail?.trim() || undefined,
      authoredAt: Number.isNaN(authoredAtSeconds) ? 0 : authoredAtSeconds * 1000,
    });
  }
  return commits;
}

function statusFromNameStatusCode(code: string): PullRequestReviewFileStatus {
  switch (code[0]) {
    case "A":
      return "added";
    case "M":
      return "modified";
    case "D":
      return "deleted";
    case "R":
      return "renamed";
    case "C":
      return "copied";
    default:
      return "unknown";
  }
}

type NameStatusEntry = {
  status: PullRequestReviewFileStatus;
  path: string;
  previousPath?: string;
};

function parseNameStatusZ(stdout: string): NameStatusEntry[] {
  const tokens = stdout.split("\0").filter((token) => token.length > 0);
  const entries: NameStatusEntry[] = [];
  let index = 0;
  while (index < tokens.length) {
    const code = tokens[index] ?? "";
    const status = statusFromNameStatusCode(code);
    if (status === "renamed" || status === "copied") {
      const previousPath = tokens[index + 1];
      const path = tokens[index + 2];
      if (path != null && previousPath != null) {
        entries.push({ status, path, previousPath });
      }
      index += 3;
      continue;
    }
    const path = tokens[index + 1];
    if (path != null) {
      entries.push({ status, path });
    }
    index += 2;
  }
  return entries;
}

type NumstatEntry = { path: string; additions: number; deletions: number; binary: boolean };

function parseNumstatZ(stdout: string): NumstatEntry[] {
  const tokens = stdout.split("\0").filter((token) => token.length > 0);
  const entries: NumstatEntry[] = [];
  let index = 0;
  while (index < tokens.length) {
    const stat = tokens[index] ?? "";
    const parts = stat.split("\t");
    if (parts.length < 2) {
      index += 1;
      continue;
    }
    const [addRaw, delRaw, inlinePath] = parts;
    const binary = addRaw === "-" || delRaw === "-";
    const additions = binary ? 0 : Number.parseInt(addRaw ?? "0", 10) || 0;
    const deletions = binary ? 0 : Number.parseInt(delRaw ?? "0", 10) || 0;
    if (inlinePath) {
      // Regular entry: "adds\tdels\tpath" in one token.
      entries.push({ path: inlinePath, additions, deletions, binary });
      index += 1;
      continue;
    }
    // Rename entry: "adds\tdels\t" token, then old path, then new path.
    const newPath = tokens[index + 2];
    if (newPath != null) {
      entries.push({ path: newPath, additions, deletions, binary });
    }
    index += 3;
  }
  return entries;
}

/** Splits one big `git diff --patch` output into per-file chunks keyed by new path. */
function splitPatchByFile(patchText: string): Map<string, string> {
  const chunks = new Map<string, string>();
  if (!patchText.trim()) {
    return chunks;
  }
  const lines = patchText.split("\n");
  let currentPath: string | null = null;
  let currentLines: string[] = [];
  const flush = () => {
    if (currentPath && currentLines.length > 0) {
      chunks.set(currentPath, currentLines.join("\n"));
    }
  };
  for (const line of lines) {
    if (line.startsWith("diff --git ")) {
      flush();
      currentLines = [line];
      // `diff --git a/old b/new` - take the b/ path. Quoted paths keep their quotes trimmed.
      const match = line.match(/ b\/(.+)$/) ?? line.match(/ "b\/(.+)"$/);
      currentPath = match?.[1]?.replace(/"$/, "") ?? null;
      continue;
    }
    if (currentPath) {
      currentLines.push(line);
    }
  }
  flush();
  return chunks;
}

async function loadGitHubInfo(root: string, headBranch: string | null): Promise<PullRequestGitHubInfo> {
  if (!headBranch) {
    return { available: false, reason: "Detached HEAD; no branch to match a PR against." };
  }
  const fields = [
    "number",
    "title",
    "body",
    "state",
    "isDraft",
    "url",
    "baseRefName",
    "headRefName",
    "author",
    "additions",
    "deletions",
    "changedFiles",
    "mergeable",
    "reviewDecision",
    "createdAt",
    "updatedAt",
    "comments",
  ].join(",");
  const result = await runGh(root, ["pr", "view", headBranch, "--json", fields]);
  if (!result.ok) {
    return { available: false, reason: result.error };
  }
  try {
    const data = JSON.parse(result.stdout) as Record<string, unknown>;
    const comments: PullRequestGitHubComment[] = Array.isArray(data.comments)
      ? (data.comments as Array<Record<string, unknown>>).map((comment) => ({
          author:
            typeof comment.author === "object" && comment.author != null
              ? String((comment.author as Record<string, unknown>).login ?? "unknown")
              : "unknown",
          body: String(comment.body ?? ""),
          createdAt: epochMs(comment.createdAt) ?? 0,
        }))
      : [];
    return {
      available: true,
      number: typeof data.number === "number" ? data.number : undefined,
      title: typeof data.title === "string" ? data.title : undefined,
      body: typeof data.body === "string" ? data.body : undefined,
      state: typeof data.state === "string" ? data.state : undefined,
      isDraft: typeof data.isDraft === "boolean" ? data.isDraft : undefined,
      url: typeof data.url === "string" ? data.url : undefined,
      baseRefName: typeof data.baseRefName === "string" ? data.baseRefName : undefined,
      headRefName: typeof data.headRefName === "string" ? data.headRefName : undefined,
      author:
        typeof data.author === "object" && data.author != null
          ? String((data.author as Record<string, unknown>).login ?? "")
          : undefined,
      additions: typeof data.additions === "number" ? data.additions : undefined,
      deletions: typeof data.deletions === "number" ? data.deletions : undefined,
      changedFiles: typeof data.changedFiles === "number" ? data.changedFiles : undefined,
      mergeable: typeof data.mergeable === "string" ? data.mergeable : undefined,
      reviewDecision: typeof data.reviewDecision === "string" ? data.reviewDecision : undefined,
      createdAt: epochMs(data.createdAt),
      updatedAt: epochMs(data.updatedAt),
      comments,
    };
  } catch {
    return { available: false, reason: "Could not parse GitHub CLI output." };
  }
}

function emptyReview(workspace: WorkspaceRecord, error?: string): PullRequestReview {
  return {
    workspaceId: workspace.id,
    root: workspace.root,
    isGitRepo: false,
    headBranch: null,
    detached: false,
    headSha: null,
    baseBranch: null,
    mergeBaseSha: null,
    candidateBases: [],
    aheadOfBase: 0,
    behindBase: 0,
    uncommitted: { dirty: false, files: 0, additions: 0, deletions: 0 },
    commits: [],
    files: [],
    totals: { files: 0, additions: 0, deletions: 0 },
    remoteUrl: null,
    github: { available: false, reason: "Not a git repository." },
    error,
    generatedAt: Date.now(),
  };
}

export async function buildPullRequestReview(
  workspace: WorkspaceRecord,
  options?: { baseRef?: string }
): Promise<PullRequestReview> {
  const root = workspace.root;
  const insideRepo = await tryGit(root, ["rev-parse", "--is-inside-work-tree"]);
  if (insideRepo?.stdout.trim() !== "true") {
    return emptyReview(workspace);
  }

  const headBranchResult = await tryGit(root, ["rev-parse", "--abbrev-ref", "HEAD"]);
  const headBranchRaw = headBranchResult?.stdout.trim() ?? null;
  const detached = headBranchRaw === "HEAD";
  const headBranch = headBranchRaw && !detached ? headBranchRaw : null;
  const headSha = (await tryGit(root, ["rev-parse", "HEAD"]))?.stdout.trim() ?? null;

  const remoteUrl = (await tryGit(root, ["remote", "get-url", "origin"]))?.stdout.trim() ?? null;

  const { baseBranch, candidateBases } = await resolveBaseBranch(
    root,
    headBranch,
    options?.baseRef?.trim() || undefined
  );

  // Uncommitted work summary (working tree + index vs HEAD).
  const porcelain = await tryGit(root, ["status", "--porcelain"]);
  const uncommittedFiles = (porcelain?.stdout ?? "")
    .split(/\r?\n/)
    .filter((line) => line.trim().length > 0).length;
  let uncommittedAdditions = 0;
  let uncommittedDeletions = 0;
  if (uncommittedFiles > 0 && headSha) {
    const shortstat = await tryGit(root, ["diff", "--shortstat", "HEAD"]);
    const text = shortstat?.stdout ?? "";
    uncommittedAdditions = Number.parseInt(text.match(/(\d+) insertion/)?.[1] ?? "0", 10) || 0;
    uncommittedDeletions = Number.parseInt(text.match(/(\d+) deletion/)?.[1] ?? "0", 10) || 0;
  }

  const review: PullRequestReview = {
    workspaceId: workspace.id,
    root,
    isGitRepo: true,
    headBranch,
    detached,
    headSha,
    baseBranch,
    mergeBaseSha: null,
    candidateBases,
    aheadOfBase: 0,
    behindBase: 0,
    uncommitted: {
      dirty: uncommittedFiles > 0,
      files: uncommittedFiles,
      additions: uncommittedAdditions,
      deletions: uncommittedDeletions,
    },
    commits: [],
    files: [],
    totals: { files: 0, additions: 0, deletions: 0 },
    remoteUrl,
    github: { available: false, reason: "GitHub lookup not attempted." },
    generatedAt: Date.now(),
  };

  const githubPromise = loadGitHubInfo(root, headBranch);

  if (baseBranch && headSha) {
    const mergeBase = await tryGit(root, ["merge-base", baseBranch, "HEAD"]);
    const mergeBaseSha = mergeBase?.stdout.trim() || null;
    review.mergeBaseSha = mergeBaseSha;

    if (mergeBaseSha) {
      const counts = await tryGit(root, [
        "rev-list",
        "--left-right",
        "--count",
        `${baseBranch}...HEAD`,
      ]);
      const [behindRaw, aheadRaw] = (counts?.stdout.trim() ?? "0\t0").split(/\s+/);
      review.behindBase = Number.parseInt(behindRaw ?? "0", 10) || 0;
      review.aheadOfBase = Number.parseInt(aheadRaw ?? "0", 10) || 0;

      try {
        const log = await runGit(root, [
          "log",
          `--max-count=${MAX_REVIEW_COMMITS}`,
          "--format=%x1e%H%x1f%h%x1f%an%x1f%ae%x1f%at%x1f%s%x1f%b",
          `${mergeBaseSha}..HEAD`,
        ]);
        review.commits = parseCommits(log.stdout);
      } catch (error) {
        review.error = error instanceof Error ? error.message : String(error);
      }

      try {
        const [nameStatus, numstat, patch] = await Promise.all([
          runGit(root, ["diff", "--name-status", "-z", "-M", "-C", mergeBaseSha, "HEAD"]),
          runGit(root, ["diff", "--numstat", "-z", "-M", "-C", mergeBaseSha, "HEAD"]),
          runGit(root, ["diff", "--patch", "--no-color", "-M", "-C", mergeBaseSha, "HEAD"]),
        ]);
        const statusEntries = parseNameStatusZ(nameStatus.stdout);
        const numstatByPath = new Map(
          parseNumstatZ(numstat.stdout).map((entry) => [entry.path, entry])
        );
        const patchByPath = splitPatchByFile(patch.stdout);

        let totalPatchChars = 0;
        const files: PullRequestReviewFile[] = [];
        for (const entry of statusEntries.slice(0, MAX_REVIEW_FILES)) {
          const stats = numstatByPath.get(entry.path);
          const binary = stats?.binary ?? false;
          let patchText = binary ? undefined : patchByPath.get(entry.path);
          let patchTruncated = false;
          if (patchText && patchText.length > MAX_FILE_PATCH_CHARS) {
            patchText = patchText.slice(0, MAX_FILE_PATCH_CHARS);
            patchTruncated = true;
          }
          if (patchText && totalPatchChars + patchText.length > MAX_TOTAL_PATCH_CHARS) {
            patchText = undefined;
            patchTruncated = true;
          }
          if (patchText) {
            totalPatchChars += patchText.length;
          }
          files.push({
            path: entry.path,
            previousPath: entry.previousPath,
            status: entry.status,
            additions: stats?.additions ?? 0,
            deletions: stats?.deletions ?? 0,
            binary,
            patch: patchText,
            patchTruncated: patchTruncated || undefined,
          });
        }
        review.files = files;
        review.totals = {
          files: statusEntries.length,
          additions: files.reduce((sum, file) => sum + file.additions, 0),
          deletions: files.reduce((sum, file) => sum + file.deletions, 0),
        };
      } catch (error) {
        review.error = error instanceof Error ? error.message : String(error);
      }
    }
  }

  review.github = await githubPromise;
  review.generatedAt = Date.now();
  return review;
}
