import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { after, before, describe, test } from "node:test";

const execFileAsync = promisify(execFile);

const TEST_ROOT = path.join(
  os.tmpdir(),
  `cesium-git-worktrees-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`
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
  defaultWorktreePath,
  getGitWorkspaceStatus,
  normalizeGitRepositoryIdentity,
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
  await git(repo, ["config", "user.name", "Cesium Test"]);
  await writeFile(path.join(repo, "README.md"), "# test\n");
  await git(repo, ["add", "README.md"]);
  await git(repo, ["commit", "-m", "initial"]);
  await git(repo, ["branch", "-M", "main"]);
  const workspace = await ensureWorkspaceRegistered(repo, name);
  return { repo, workspace };
}

async function createRepoWithOrigin(name: string) {
  const remote = path.join(TEST_ROOT, `${name}-origin.git`);
  await mkdir(remote, { recursive: true });
  await git(remote, ["init", "--bare"]);
  const created = await createRepo(name);
  await git(created.repo, ["remote", "add", "origin", remote]);
  await git(created.repo, ["push", "-u", "origin", "main"]);
  return { ...created, remote };
}

async function pushFeatureBranch(repo: string, branch: string) {
  await git(repo, ["switch", "-c", branch]);
  await writeFile(path.join(repo, `${branch.replace(/[^a-zA-Z0-9._-]+/g, "-")}.txt`), `${branch}\n`);
  await git(repo, ["add", "."]);
  await git(repo, ["commit", "-m", `add ${branch}`]);
  await git(repo, ["push", "-u", "origin", branch]);
  await git(repo, ["switch", "main"]);
}

before(async () => {
  await mkdir(TEST_ROOT, { recursive: true });
});

after(async () => {
  await rm(TEST_ROOT, { recursive: true, force: true }).catch(() => undefined);
});

describe("git worktree service", () => {
  test("normalizes equivalent network remotes without leaking credentials", () => {
    assert.equal(
      normalizeGitRepositoryIdentity("git@GitHub.com:cesium/app.git"),
      "github.com/cesium/app"
    );
    assert.equal(
      normalizeGitRepositoryIdentity("https://token@example.com:8443/team/app.git"),
      "example.com:8443/team/app"
    );
    assert.equal(
      normalizeGitRepositoryIdentity("ssh://git@example.com:22/team/app.git"),
      "example.com/team/app"
    );
    assert.equal(normalizeGitRepositoryIdentity("/srv/git/app.git"), undefined);
    assert.equal(normalizeGitRepositoryIdentity("file:///srv/git/app.git"), undefined);
  });

  test("reports a cross-machine repository id from origin", async () => {
    const { repo, workspace } = await createRepo("repository-id");
    await git(repo, ["remote", "add", "origin", "git@GitHub.com:cesium/app.git"]);
    const status = await getGitWorkspaceStatus(workspace, [workspace]);
    assert.equal(status.repositoryId, "github.com/cesium/app");
  });

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

  test("defaults new worktrees into repo .cesium and ignores it", async () => {
    const { repo, workspace } = await createRepo("default-worktree");
    const created = await createWorkspaceWorktree({
      workspace,
      workspaces: [workspace],
      branch: "feature/readable-name",
      baseBranch: "main",
      newBranch: true,
      runSetup: false,
    });
    assert.equal(
      created.path,
      path.join(repo, ".cesium", "default-worktree-feature-readable-name")
    );
    assert.equal(
      defaultWorktreePath(repo, "feature/readable-name"),
      path.join(repo, ".cesium", "default-worktree-feature-readable-name")
    );
    const gitignore = await readFile(path.join(repo, ".gitignore"), "utf8");
    assert.match(gitignore, /^\.cesium\/$/m);
  });

  test("materializes a remote-only branch into the managed worktree path", async () => {
    const { repo, workspace } = await createRepoWithOrigin("remote-worktree");
    await pushFeatureBranch(repo, "feature/remote-only");
    await git(repo, ["branch", "-D", "feature/remote-only"]);

    const status = await getGitWorkspaceStatus(workspace, [workspace]);
    assert.ok(
      status.branches.some(
        (branch) => branch.type === "remote" && branch.name === "origin/feature/remote-only"
      )
    );
    assert.ok(
      !status.branches.some(
        (branch) => branch.type === "local" && branch.name === "feature/remote-only"
      )
    );

    const created = await createWorkspaceWorktree({
      workspace,
      workspaces: [workspace],
      branch: "feature/remote-only",
      baseBranch: "origin/feature/remote-only",
      newBranch: true,
      runSetup: false,
    });

    assert.equal(created.path, defaultWorktreePath(repo, "feature/remote-only"));
    const nextStatus = await getGitWorkspaceStatus(workspace, [workspace]);
    assert.ok(
      nextStatus.branches.some(
        (branch) => branch.type === "local" && branch.name === "feature/remote-only"
      )
    );
    assert.ok(
      nextStatus.worktrees.some(
        (worktree) =>
          worktree.path === created.path && worktree.branch === "feature/remote-only"
      )
    );
  });

  test("opens a remote-backed worktree when the local branch already exists", async () => {
    const { repo, workspace } = await createRepoWithOrigin("remote-existing-local");
    await pushFeatureBranch(repo, "feature/existing-local");

    const created = await createWorkspaceWorktree({
      workspace,
      workspaces: [workspace],
      branch: "feature/existing-local",
      baseBranch: "origin/feature/existing-local",
      newBranch: true,
      runSetup: false,
    });

    assert.equal(created.path, defaultWorktreePath(repo, "feature/existing-local"));
    const nextStatus = await getGitWorkspaceStatus(workspace, [workspace]);
    assert.ok(
      nextStatus.worktrees.some(
        (worktree) =>
          worktree.path === created.path && worktree.branch === "feature/existing-local"
      )
    );
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
