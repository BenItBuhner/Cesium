import assert from "node:assert/strict";
import { describe, test } from "node:test";
import {
  composerStatusBarHasVisibleItems,
  formatContextTokenCount,
  formatContextUsagePair,
  normalizeComposerStatusBarVisibility,
  resolveComposerBranchLabel,
  resolveComposerRepoLabel,
  resolveComposerStatusBarVisibilityForConversation,
  withComposerStatusBarVisibility,
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

describe("per-conversation composer status bar visibility", () => {
  const hidden = { repo: false, branch: false, goal: false, context: false };

  test("conversation state wins over the last-used default", () => {
    const scope = {
      composerStatusBarVisibility: { repo: false, branch: true, goal: true, context: true },
      composerStatusBarVisibilityByConversationId: { "conv-a": hidden },
    };
    assert.deepEqual(resolveComposerStatusBarVisibilityForConversation(scope, "conv-a"), hidden);
    // New conversations inherit the last-used default.
    assert.equal(
      resolveComposerStatusBarVisibilityForConversation(scope, "conv-new").repo,
      false
    );
    assert.equal(
      resolveComposerStatusBarVisibilityForConversation(scope, "conv-new").branch,
      true
    );
  });

  test("toggling writes both the conversation entry and the new-chat default", () => {
    const start = {
      composerStatusBarVisibility: {
        repo: true,
        branch: true,
        goal: true,
        context: true,
      },
      composerStatusBarVisibilityByConversationId: {},
    };
    const afterA = withComposerStatusBarVisibility(start, "conv-a", {
      repo: true,
      branch: false,
      goal: true,
      context: true,
    });
    assert.equal(afterA.composerStatusBarVisibility?.branch, false);
    assert.equal(
      afterA.composerStatusBarVisibilityByConversationId?.["conv-a"]?.branch,
      false
    );
    // conv-a keeps its own state even after another conversation changes the default.
    const afterB = withComposerStatusBarVisibility(afterA, "conv-b", {
      repo: false,
      branch: true,
      goal: true,
      context: true,
    });
    assert.equal(
      resolveComposerStatusBarVisibilityForConversation(afterB, "conv-a").branch,
      false
    );
    assert.equal(
      resolveComposerStatusBarVisibilityForConversation(afterB, "conv-a").repo,
      true
    );
    assert.equal(
      resolveComposerStatusBarVisibilityForConversation(afterB, "conv-c").repo,
      false
    );
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
