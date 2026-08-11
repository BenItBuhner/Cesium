import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, describe, it } from "node:test";
import { buildPullRequestReview } from "../src/lib/pull-request-review.js";
import type { WorkspaceRecord } from "../src/lib/workspace-registry.js";

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8" });
}

function makeRepo(): string {
  const root = mkdtempSync(path.join(os.tmpdir(), "cesium-pr-review-"));
  git(root, "init", "-q", "-b", "main");
  git(root, "config", "user.email", "test@example.com");
  git(root, "config", "user.name", "Test User");
  return root;
}

function workspaceFor(root: string): WorkspaceRecord {
  return {
    id: "test-workspace",
    root,
    name: "test",
    createdAt: Date.now(),
    updatedAt: Date.now(),
    lastOpenedAt: Date.now(),
  };
}

describe("buildPullRequestReview", () => {
  const roots: string[] = [];
  after(() => {
    for (const root of roots) {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("reports non-repos without exploding", async () => {
    const root = mkdtempSync(path.join(os.tmpdir(), "cesium-pr-plain-"));
    roots.push(root);
    const review = await buildPullRequestReview(workspaceFor(root));
    assert.equal(review.isGitRepo, false);
    assert.equal(review.commits.length, 0);
    assert.equal(review.files.length, 0);
  });

  it("computes commits, file diffs, and totals against the base branch", async () => {
    const root = makeRepo();
    roots.push(root);

    writeFileSync(path.join(root, "a.txt"), "one\ntwo\n");
    writeFileSync(path.join(root, "obsolete.txt"), "bye\n");
    git(root, "add", "-A");
    git(root, "commit", "-qm", "initial");

    git(root, "checkout", "-qb", "feature/thing");
    writeFileSync(path.join(root, "a.txt"), "one\ntwo\nthree\n");
    writeFileSync(path.join(root, "b.txt"), "new file\n");
    rmSync(path.join(root, "obsolete.txt"));
    git(root, "add", "-A");
    git(root, "commit", "-qm", "feature work", "-m", "with a body");

    const review = await buildPullRequestReview(workspaceFor(root), { baseRef: "main" });

    assert.equal(review.isGitRepo, true);
    assert.equal(review.headBranch, "feature/thing");
    assert.equal(review.baseBranch, "main");
    assert.ok(review.mergeBaseSha);
    assert.equal(review.aheadOfBase, 1);
    assert.equal(review.behindBase, 0);

    assert.equal(review.commits.length, 1);
    assert.equal(review.commits[0]?.subject, "feature work");
    assert.equal(review.commits[0]?.body, "with a body");
    assert.equal(review.commits[0]?.authorName, "Test User");

    const byPath = new Map(review.files.map((file) => [file.path, file]));
    assert.equal(byPath.get("a.txt")?.status, "modified");
    assert.equal(byPath.get("a.txt")?.additions, 1);
    assert.equal(byPath.get("b.txt")?.status, "added");
    assert.equal(byPath.get("obsolete.txt")?.status, "deleted");
    assert.ok(byPath.get("a.txt")?.patch?.includes("+three"));

    assert.equal(review.totals.files, 3);
    assert.equal(review.totals.additions, 2);
    assert.equal(review.totals.deletions, 1);
    assert.equal(review.uncommitted.dirty, false);
  });

  it("tracks uncommitted work and honours renames", async () => {
    const root = makeRepo();
    roots.push(root);

    writeFileSync(
      path.join(root, "keep.txt"),
      Array.from({ length: 30 }, (_, i) => `line ${i}`).join("\n")
    );
    git(root, "add", "-A");
    git(root, "commit", "-qm", "initial");

    git(root, "checkout", "-qb", "feature/rename");
    git(root, "mv", "keep.txt", "kept.txt");
    git(root, "commit", "-qm", "rename file");
    writeFileSync(path.join(root, "scratch.txt"), "wip\n");

    const review = await buildPullRequestReview(workspaceFor(root), { baseRef: "main" });

    const renamed = review.files.find((file) => file.status === "renamed");
    assert.ok(renamed, "expected a renamed file entry");
    assert.equal(renamed?.path, "kept.txt");
    assert.equal(renamed?.previousPath, "keep.txt");

    assert.equal(review.uncommitted.dirty, true);
    assert.equal(review.uncommitted.files, 1);
    assert.equal(review.github.available, false);
  });

  it("falls back gracefully when sitting on the base branch itself", async () => {
    const root = makeRepo();
    roots.push(root);
    writeFileSync(path.join(root, "a.txt"), "hello\n");
    git(root, "add", "-A");
    git(root, "commit", "-qm", "initial");

    const review = await buildPullRequestReview(workspaceFor(root));
    assert.equal(review.isGitRepo, true);
    assert.equal(review.headBranch, "main");
    // "main" is the only candidate and equals HEAD, so no usable base remains.
    assert.equal(review.baseBranch, null);
    assert.equal(review.commits.length, 0);
    assert.equal(review.files.length, 0);
  });
});
