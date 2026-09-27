import { execFile } from "node:child_process";
import { promises as fs } from "node:fs";
import path from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

const GIT_ENV = {
  GIT_AUTHOR_NAME: "Cesium Test",
  GIT_AUTHOR_EMAIL: "test@cesium.invalid",
  GIT_COMMITTER_NAME: "Cesium Test",
  GIT_COMMITTER_EMAIL: "test@cesium.invalid",
  GIT_TERMINAL_PROMPT: "0",
};

export async function git(cwd: string, args: string[]): Promise<string> {
  const { stdout } = await execFileAsync("git", args, {
    cwd,
    env: { ...process.env, ...GIT_ENV },
    maxBuffer: 16 * 1024 * 1024,
  });
  return stdout.trim();
}

export async function tryGitOutput(cwd: string, args: string[]): Promise<string | null> {
  try {
    return await git(cwd, args);
  } catch {
    return null;
  }
}

async function writeFiles(root: string, files: Record<string, string>): Promise<void> {
  for (const [relative, content] of Object.entries(files)) {
    const absolute = path.join(root, relative);
    await fs.mkdir(path.dirname(absolute), { recursive: true });
    await fs.writeFile(absolute, content, "utf8");
  }
}

/**
 * A working checkout at `repoDir` whose `origin` is a local bare repository at
 * `remoteDir`, with `files` committed on `main` and pushed. `origin/HEAD`
 * points at `main`, like a fresh clone of a hosted repository.
 */
export async function createRepoWithRemote(input: {
  repoDir: string;
  remoteDir: string;
  files: Record<string, string>;
}): Promise<{ headSha: string }> {
  await fs.mkdir(path.dirname(input.remoteDir), { recursive: true });
  await git(path.dirname(input.remoteDir), ["init", "--bare", "-b", "main", input.remoteDir]);
  await fs.mkdir(input.repoDir, { recursive: true });
  await git(input.repoDir, ["init", "-b", "main"]);
  await writeFiles(input.repoDir, input.files);
  await git(input.repoDir, ["add", "-A"]);
  await git(input.repoDir, ["commit", "-m", "Initial commit"]);
  await git(input.repoDir, ["remote", "add", "origin", input.remoteDir]);
  await git(input.repoDir, ["push", "-u", "origin", "main"]);
  await git(input.repoDir, ["remote", "set-head", "origin", "main"]);
  return { headSha: await git(input.repoDir, ["rev-parse", "HEAD"]) };
}

/** Commits `files` on `branch` of the bare remote from a throwaway clone; returns the new head. */
export async function pushCommitToRemote(input: {
  remoteDir: string;
  scratchDir: string;
  files: Record<string, string>;
  message: string;
  branch?: string;
}): Promise<string> {
  const branch = input.branch ?? "main";
  const clone = path.join(input.scratchDir, `clone-${Date.now()}-${Math.random().toString(16).slice(2, 8)}`);
  await git(input.scratchDir, ["clone", "--quiet", "--branch", branch, input.remoteDir, clone]);
  await writeFiles(clone, input.files);
  await git(clone, ["add", "-A"]);
  await git(clone, ["commit", "-m", input.message]);
  await git(clone, ["push", "origin", branch]);
  const sha = await git(clone, ["rev-parse", "HEAD"]);
  await fs.rm(clone, { recursive: true, force: true });
  return sha;
}
