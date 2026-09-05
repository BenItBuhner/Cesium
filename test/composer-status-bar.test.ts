import assert from "node:assert/strict";
import { describe, test } from "node:test";
import {
  composerStatusBarHasVisibleItems,
  formatContextTokenCount,
  formatContextUsagePair,
  normalizeComposerStatusBarVisibility,
  pinComposerStatusBarVisibilityForConversation,
  resolveComposerBranchLabel,
  resolveComposerRepoLabel,
  resolveComposerStatusBarVisibilityForConversation,
  withComposerStatusBarVisibility,
} from "../src/lib/composer-status-bar.ts";
import {
  createDefaultWorkspaceSession,
  mergeWorkspaceSessionFromImport,
} from "../src/lib/workspace-session.ts";

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
  const allOn = { repo: true, branch: true, goal: true, context: true };

  test("conversation state wins over the account default", () => {
    const accountDefault = { repo: false, branch: true, goal: true, context: true };
    const scope = {
      composerStatusBarVisibilityByConversationId: { "conv-a": hidden },
    };
    assert.deepEqual(
      resolveComposerStatusBarVisibilityForConversation(scope, "conv-a", accountDefault),
      hidden
    );
    // New conversations inherit the account default.
    assert.equal(
      resolveComposerStatusBarVisibilityForConversation(scope, "conv-new", accountDefault).repo,
      false
    );
    assert.equal(
      resolveComposerStatusBarVisibilityForConversation(scope, "conv-new", accountDefault).branch,
      true
    );
    // Without an account default the built-in defaults apply.
    assert.deepEqual(resolveComposerStatusBarVisibilityForConversation(scope, "conv-new"), allOn);
  });

  test("toggling writes the conversation entry; the account default is owned elsewhere", () => {
    const start = { composerStatusBarVisibilityByConversationId: {} };
    const afterA = withComposerStatusBarVisibility(start, "conv-a", {
      repo: true,
      branch: false,
      goal: true,
      context: true,
    });
    assert.equal(
      afterA.composerStatusBarVisibilityByConversationId?.["conv-a"]?.branch,
      false
    );
    assert.equal("composerStatusBarVisibility" in afterA, false);
    // conv-a keeps its own state even after another conversation toggles.
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
    // A chat without its own entry resolves to whatever default the caller passes.
    assert.equal(
      resolveComposerStatusBarVisibilityForConversation(afterB, "conv-c", {
        ...allOn,
        repo: false,
      }).repo,
      false
    );
    // Toggling without a conversation is a no-op on the workspace scope.
    assert.equal(withComposerStatusBarVisibility(afterB, null, hidden), afterB);
  });

  test("pinning snapshots the account default into the conversation", () => {
    const accountDefault = { repo: true, branch: false, goal: true, context: true };
    const scope = { composerStatusBarVisibilityByConversationId: {} };
    const pinned = pinComposerStatusBarVisibilityForConversation(scope, "conv-a", accountDefault);
    assert.deepEqual(
      pinned.composerStatusBarVisibilityByConversationId?.["conv-a"],
      accountDefault
    );
  });

  test("the account default wins over stale workspace state when pinning", () => {
    const staleWorkspaceState = {
      composerStatusBarVisibilityByConversationId: {},
    };
    assert.deepEqual(
      resolveComposerStatusBarVisibilityForConversation(
        staleWorkspaceState,
        null,
        hidden
      ),
      hidden
    );

    const pinned = pinComposerStatusBarVisibilityForConversation(
      staleWorkspaceState,
      "conv-new",
      hidden
    );
    assert.deepEqual(
      pinned.composerStatusBarVisibilityByConversationId?.["conv-new"],
      hidden
    );
  });

  test("pinning is a no-op for pinned conversations and missing ids", () => {
    const scope = {
      composerStatusBarVisibilityByConversationId: {
        "conv-a": hidden,
      },
    };
    assert.equal(pinComposerStatusBarVisibilityForConversation(scope, "conv-a", allOn), scope);
    assert.equal(pinComposerStatusBarVisibilityForConversation(scope, null, allOn), scope);
    assert.equal(pinComposerStatusBarVisibilityForConversation(scope, undefined, allOn), scope);
  });

  test("a pinned chat keeps its state after the account default moves", () => {
    // Chat A is created while the account default hides the branch label.
    const start = { composerStatusBarVisibilityByConversationId: {} };
    const pinnedA = pinComposerStatusBarVisibilityForConversation(start, "conv-a", {
      repo: true,
      branch: false,
      goal: true,
      context: true,
    });
    // The user then re-enables the branch label from chat B; the account
    // default (owned by the settings document) follows suit.
    const afterB = withComposerStatusBarVisibility(pinnedA, "conv-b", allOn);
    // Chat A retains its creation-time state; new chats get the latest default.
    assert.equal(
      resolveComposerStatusBarVisibilityForConversation(afterB, "conv-a").branch,
      false
    );
    assert.equal(
      resolveComposerStatusBarVisibilityForConversation(afterB, "conv-new", allOn).branch,
      true
    );
  });
});

describe("workspace session composer status bar visibility", () => {
  test("strips the legacy workspace default and keeps per-conversation entries", () => {
    const base = createDefaultWorkspaceSession([{ id: "t", title: "T", active: true }]);
    const normalized = mergeWorkspaceSessionFromImport(base, {
      schemaVersion: 1,
      chat: {
        composerStatusBarVisibility: { repo: false, branch: true, context: false },
        composerStatusBarVisibilityByConversationId: {
          "conv-1": { repo: false },
        },
      },
    });
    assert.equal("composerStatusBarVisibility" in normalized.chat, false);
    assert.deepEqual(normalized.chat.composerStatusBarVisibilityByConversationId, {
      "conv-1": { repo: false, branch: true, goal: true, context: true },
    });
  });
});
