import assert from "node:assert/strict";
import { describe, test } from "node:test";
import {
  composerStatusBarHasVisibleItems,
  formatContextTokenCount,
  formatContextUsagePair,
  normalizeComposerStatusBarVisibility,
  resolveComposerBranchLabel,
  resolveComposerRepoLabel,
} from "../src/lib/composer-status-bar.ts";
import {
  createDefaultWorkspaceSession,
  mergeWorkspaceSessionFromImport,
} from "../src/lib/workspace-session.ts";
import type { ModelInfo } from "../src/lib/types.ts";

describe("composer status bar helpers", () => {
  test("composerStatusBarHasVisibleItems respects toggles and git", () => {
    assert.equal(
      composerStatusBarHasVisibleItems(
        { repo: false, branch: false, goal: false, context: false },
        null
      ),
      false
    );
    assert.equal(
      composerStatusBarHasVisibleItems(
        { repo: false, branch: true, goal: false, context: false },
        { isGitRepo: true, root: "/w", currentBranch: "main", branches: [], worktrees: [] }
      ),
      true
    );
    assert.equal(
      composerStatusBarHasVisibleItems(
        { repo: false, branch: false, goal: true, context: false },
        null,
        { goalProgress: true }
      ),
      true
    );
    assert.equal(
      composerStatusBarHasVisibleItems(
        { repo: false, branch: false, goal: true, context: false },
        null
      ),
      false
    );
  });

  test("normalizeComposerStatusBarVisibility applies defaults", () => {
    assert.deepEqual(normalizeComposerStatusBarVisibility(undefined), {
      repo: true,
      branch: true,
      goal: true,
      context: true,
    });
    assert.deepEqual(
      normalizeComposerStatusBarVisibility({ repo: false, branch: true, context: false }),
      { repo: false, branch: true, goal: true, context: false }
    );
  });

  test("resolveComposerRepoLabel prefers git repo root basename", () => {
    assert.equal(
      resolveComposerRepoLabel({
        gitStatus: {
          isGitRepo: true,
          root: "/w",
          repoRoot: "/home/user/opencursor",
          branches: [],
          worktrees: [],
        },
        workspaceName: "My Workspace",
      }),
      "opencursor"
    );
    assert.equal(
      resolveComposerRepoLabel({
        gitStatus: null,
        workspaceName: "My Workspace",
      }),
      "My Workspace"
    );
  });

  test("resolveComposerBranchLabel returns null outside git repos", () => {
    assert.equal(resolveComposerBranchLabel(null), null);
    assert.equal(
      resolveComposerBranchLabel({
        isGitRepo: true,
        root: "/w",
        currentBranch: "main",
        branches: [],
        worktrees: [],
      }),
      "main"
    );
  });

  test("formatContextTokenCount abbreviates thousands", () => {
    assert.equal(formatContextTokenCount(483), "483");
    assert.equal(formatContextTokenCount(6400), "6.4K");
    assert.equal(formatContextTokenCount(144100), "144K");
  });

  test("formatContextUsagePair renders pair label", () => {
    assert.equal(formatContextUsagePair(166800, 200000), "~167K / 200K Tokens");
  });
});

describe("workspace session composer status bar visibility", () => {
  test("imports composerStatusBarVisibility from persisted chat session", () => {
    const model: ModelInfo = { id: "m", name: "M", provider: "auto" };
    const base = createDefaultWorkspaceSession([{ id: "t", title: "T", active: true }], model);
    const normalized = mergeWorkspaceSessionFromImport(base, {
      schemaVersion: 1,
      chat: {
        composerStatusBarVisibility: { repo: false, branch: true, context: false },
      },
    });
    assert.deepEqual(normalized.chat.composerStatusBarVisibility, {
      repo: false,
      branch: true,
      goal: true,
      context: false,
    });
  });
});
