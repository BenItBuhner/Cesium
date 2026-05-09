import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { after, before, describe, test } from "node:test";

const execFileAsync = promisify(execFile);

const TEST_ROOT = path.join(
  os.tmpdir(),
  `opencursor-git-worktrees-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`
);

delete process.env.REDIS_URL;
delete process.env.DATABASE_URL;
delete process.env.OPENCURSOR_STORAGE_DRIVER;
process.env.OPENCURSOR_DATA_DIR = TEST_ROOT;
process.env.WORKSPACE_ALLOWED_ROOTS = TEST_ROOT;
process.env.NODE_ENV = "test";

const { ensureDataDir } = await import("../src/lib/persistence.js");
await ensureDataDir();

const { ensureWorkspaceRegistered } = await import("../src/lib/workspace-registry.js");
const {
  createWorkspaceWorktree,
  getGitWorkspaceStatus,
  switchWorkspaceBranch,
} = await import("../src/lib/git-worktrees.js");

async function git(cwd: string, args: string[]): Promise<void> {
  await execFileAsync("git", args, { cwd });
}

async function createRepo(name: string) {
  const repo = path.join(TEST_ROOT, name);
  await mkdir(repo, { recursive: true });
  await git(repo, ["init"]);
  await git(repo, ["config", "user.email", "test@example.com"]);
  await git(repo, ["config", "user.name", "OpenCursor Test"]);
  await writeFile(path.join(repo, "README.md"), "# test\n");
  await git(repo, ["add", "README.md"]);
  await git(repo, ["commit", "-m", "initial"]);
  await git(repo, ["branch", "-M", "main"]);
  const workspace = await ensureWorkspaceRegistered(repo, name);
  return { repo, workspace };
}

before(async () => {
  await mkdir(TEST_ROOT, { recursive: true });
});

after(async () => {
  await rm(TEST_ROOT, { recursive: true, force: true }).catch(() => undefined);
});

describe("git worktree service", () => {
  test("reports non-git workspaces without throwing", async () => {
    const root = path.join(TEST_ROOT, "plain");
    await mkdir(root, { recursive: true });
    const workspace = await ensureWorkspaceRegistered(root, "plain");
    const status = await getGitWorkspaceStatus(workspace, [workspace]);
    assert.equal(status.isGitRepo, false);
    assert.deepEqual(status.branches, []);
    assert.deepEqual(status.worktrees, []);
  });

  test("lists branches and blocks dirty in-place branch switches", async () => {
    const { repo, workspace } = await createRepo("dirty-switch");
    await git(repo, ["switch", "-c", "feature/clean"]);
    await git(repo, ["switch", "main"]);
    await writeFile(path.join(repo, "dirty.txt"), "dirty\n");

    const status = await getGitWorkspaceStatus(workspace, [workspace]);
    assert.equal(status.isGitRepo, true);
    assert.equal(status.currentBranch, "main");
    assert.equal(status.dirty, true);
    assert.ok(status.branches.some((branch) => branch.name === "feature/clean"));

    await assert.rejects(
      switchWorkspaceBranch({
        workspace,
        workspaces: [workspace],
        branch: "feature/clean",
      }),
      /uncommitted changes/i
    );
  });

  test("creates a new branch worktree at an explicit path", async () => {
    const { workspace } = await createRepo("create-worktree");
    const targetPath = path.join(TEST_ROOT, "create-worktree-branch");
    const created = await createWorkspaceWorktree({
      workspace,
      workspaces: [workspace],
      branch: "feature/isolated",
      baseBranch: "main",
      newBranch: true,
      targetPath,
      runSetup: false,
    });
    assert.equal(created.branch, "feature/isolated");
    assert.equal(created.path, targetPath);
    const status = await getGitWorkspaceStatus(workspace, [workspace]);
    assert.ok(status.worktrees.some((worktree) => worktree.path === targetPath));
  });

  test("returns existing checked-out worktree instead of switching", async () => {
    const { workspace } = await createRepo("existing-worktree");
    const targetPath = path.join(TEST_ROOT, "existing-worktree-branch");
    await createWorkspaceWorktree({
      workspace,
      workspaces: [workspace],
      branch: "feature/existing",
      baseBranch: "main",
      newBranch: true,
      targetPath,
      runSetup: false,
    });
    const result = await switchWorkspaceBranch({
      workspace,
      workspaces: [workspace],
      branch: "feature/existing",
    });
    assert.equal(result.checkedOutWorktree?.path, targetPath);
  });
});
