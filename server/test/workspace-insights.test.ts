import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, describe, test } from "node:test";

process.env.OPENCURSOR_DATA_DIR = path.join(
  os.tmpdir(),
  `cesium-insights-test-${Date.now()}-${randomUUID().slice(0, 8)}`
);

import {
  getWorkspaceInsights,
  parseGitNumstat,
  parseGitPorcelainStatus,
} from "../src/lib/workspace-insights.js";
import type { WorkspaceRecord } from "../src/lib/workspace-registry.js";

describe("parseGitPorcelainStatus", () => {
  test("parses branch header with ahead/behind and upstream", () => {
    const parsed = parseGitPorcelainStatus(
      "## main...origin/main [ahead 2, behind 3]\n M src/a.ts\n?? notes.md\n"
    );
    assert.equal(parsed.branch, "main");
    assert.equal(parsed.ahead, 2);
    assert.equal(parsed.behind, 3);
    assert.equal(parsed.hasUpstream, true);
    assert.equal(parsed.dirty, true);
    assert.deepEqual(parsed.untrackedFiles, ["notes.md"]);
    assert.deepEqual(parsed.conflictedFiles, []);
  });

  test("parses conflict codes as conflicted files", () => {
    const parsed = parseGitPorcelainStatus(
      "## feature\nUU src/conflict.ts\nAA both-added.txt\n M staged.ts\n"
    );
    assert.deepEqual(parsed.conflictedFiles, ["src/conflict.ts", "both-added.txt"]);
    assert.equal(parsed.hasUpstream, false);
  });

  test("parses detached head and clean tree", () => {
    const parsed = parseGitPorcelainStatus("## HEAD (no branch)\n");
    assert.equal(parsed.detached, true);
    assert.equal(parsed.dirty, false);
  });
});

describe("parseGitNumstat", () => {
  test("parses added/removed counts and binary markers", () => {
    const files = parseGitNumstat("12\t3\tsrc/a.ts\n-\t-\tassets/logo.png\n0\t7\tREADME.md\n");
    assert.deepEqual(files, [
      { path: "src/a.ts", added: 12, removed: 3, binary: false },
      { path: "assets/logo.png", added: 0, removed: 0, binary: true },
      { path: "README.md", added: 0, removed: 7, binary: false },
    ]);
  });
});

describe("getWorkspaceInsights integration", () => {
  const repoRoot = path.join(
    os.tmpdir(),
    `cesium-insights-repo-${Date.now()}-${randomUUID().slice(0, 8)}`
  );

  const git = (...args: string[]) =>
    execFileSync("git", args, { cwd: repoRoot, stdio: "pipe" }).toString();

  after(async () => {
    await fs.rm(repoRoot, { recursive: true, force: true });
    await fs.rm(process.env.OPENCURSOR_DATA_DIR!, { recursive: true, force: true });
  });

  test("reports diff totals and merge conflict state for a real repo", async () => {
    await fs.mkdir(repoRoot, { recursive: true });
    execFileSync("git", ["init", "-b", "main"], { cwd: repoRoot, stdio: "pipe" });
    git("config", "user.email", "test@example.com");
    git("config", "user.name", "Test");

    await fs.writeFile(path.join(repoRoot, "shared.txt"), "line one\nline two\n");
    git("add", "-A");
    git("commit", "-m", "base");

    // Diverging branch edits the same line to force a conflict later.
    git("checkout", "-b", "feature");
    await fs.writeFile(path.join(repoRoot, "shared.txt"), "feature change\nline two\n");
    git("commit", "-am", "feature edit");
    git("checkout", "main");
    await fs.writeFile(path.join(repoRoot, "shared.txt"), "main change\nline two\n");
    git("commit", "-am", "main edit");

    const workspace: WorkspaceRecord = {
      id: "insights-test",
      root: repoRoot,
      name: "Insights Test",
      createdAt: Date.now(),
      updatedAt: Date.now(),
      lastOpenedAt: Date.now(),
    };

    // Clean tree first: no diff, no conflicts.
    const clean = await getWorkspaceInsights(workspace);
    assert.equal(clean.isGitRepo, true);
    assert.equal(clean.branch, "main");
    assert.equal(clean.dirty, false);
    assert.equal(clean.diff.fileCount, 0);
    assert.equal(clean.merge.state, "none");

    // Dirty tree with tracked + untracked changes.
    await fs.writeFile(path.join(repoRoot, "shared.txt"), "main change\nline two\nline three\n");
    await fs.writeFile(path.join(repoRoot, "brand-new.txt"), "alpha\nbeta\n");
    const dirty = await getWorkspaceInsights(workspace);
    assert.equal(dirty.dirty, true);
    assert.equal(dirty.diff.fileCount, 2);
    const tracked = dirty.diff.files.find((file) => file.path === "shared.txt");
    const untracked = dirty.diff.files.find((file) => file.path === "brand-new.txt");
    assert.ok(tracked && tracked.added >= 1);
    assert.ok(untracked?.untracked);
    assert.equal(untracked?.added, 2);
    assert.ok(dirty.diff.totalAdded >= 3);

    // Reset, then create a real merge conflict.
    git("checkout", "--", "shared.txt");
    await fs.rm(path.join(repoRoot, "brand-new.txt"));
    let mergeFailed = false;
    try {
      git("merge", "feature");
    } catch {
      mergeFailed = true;
    }
    assert.equal(mergeFailed, true, "merge should conflict");

    const conflicted = await getWorkspaceInsights(workspace);
    assert.equal(conflicted.merge.state, "merging");
    assert.deepEqual(conflicted.merge.conflictedFiles, ["shared.txt"]);
    assert.equal(conflicted.merge.conflictsResolved, false);

    // Resolve the conflict and stage it: "fixed merge conflicts" state.
    await fs.writeFile(path.join(repoRoot, "shared.txt"), "merged change\nline two\n");
    git("add", "shared.txt");
    const resolved = await getWorkspaceInsights(workspace);
    assert.equal(resolved.merge.state, "merging");
    assert.deepEqual(resolved.merge.conflictedFiles, []);
    assert.equal(resolved.merge.conflictsResolved, true);
  });
});
