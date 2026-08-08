import assert from "node:assert/strict";
import { describe, test } from "node:test";
import {
  DEFAULT_COMPOSER_PILLS_VISIBILITY,
  deriveComposerBuiltinPills,
  normalizeComposerPillsVisibility,
  resolveComposerPillsVisibility,
  withComposerPillsVisibility,
} from "../src/lib/composer-pills.ts";
import {
  createEmptyWorkspaceInsights,
  isQuickActionVisibleInContext,
  materializeQuickActionPreset,
  QUICK_ACTION_PRESETS,
  type WorkspaceInsights,
} from "@cesium/core";
import {
  createDefaultWorkspaceSession,
  mergeWorkspaceSessionFromImport,
} from "../src/lib/workspace-session.ts";
import type { ModelInfo } from "../src/lib/types.ts";

function insightsWith(patch: Partial<WorkspaceInsights>): WorkspaceInsights {
  return { ...createEmptyWorkspaceInsights(), ...patch };
}

describe("composer pills visibility", () => {
  test("normalize applies defaults for missing keys", () => {
    assert.deepEqual(normalizeComposerPillsVisibility(undefined), DEFAULT_COMPOSER_PILLS_VISIBILITY);
    assert.deepEqual(normalizeComposerPillsVisibility({ diff: false, actions: false }), {
      diff: false,
      conflicts: true,
      sync: true,
      work: true,
      actions: false,
    });
  });

  test("resolve prefers per-conversation state, then last-used default", () => {
    const scope = {
      composerPillsVisibility: { ...DEFAULT_COMPOSER_PILLS_VISIBILITY, diff: false },
      composerPillsVisibilityByConversationId: {
        "conv-a": { ...DEFAULT_COMPOSER_PILLS_VISIBILITY, work: false },
      },
    };
    // Conversation with its own state keeps it.
    assert.equal(resolveComposerPillsVisibility(scope, "conv-a").work, false);
    assert.equal(resolveComposerPillsVisibility(scope, "conv-a").diff, true);
    // Unknown conversation inherits the last-used default.
    assert.equal(resolveComposerPillsVisibility(scope, "conv-new").diff, false);
    assert.equal(resolveComposerPillsVisibility(scope, "conv-new").work, true);
    // No conversation (draft) also inherits the last-used default.
    assert.equal(resolveComposerPillsVisibility(scope, null).diff, false);
  });

  test("withComposerPillsVisibility writes per-conversation state and the new default", () => {
    const start = {
      composerPillsVisibility: { ...DEFAULT_COMPOSER_PILLS_VISIBILITY },
      composerPillsVisibilityByConversationId: {},
    };
    const next = withComposerPillsVisibility(start, "conv-a", {
      ...DEFAULT_COMPOSER_PILLS_VISIBILITY,
      sync: false,
    });
    assert.equal(next.composerPillsVisibility?.sync, false);
    assert.equal(next.composerPillsVisibilityByConversationId?.["conv-a"]?.sync, false);
    // A brand new conversation now inherits sync: false…
    assert.equal(resolveComposerPillsVisibility(next, "conv-b").sync, false);
    // …while conv-a keeps its own record even if the default changes later.
    const third = withComposerPillsVisibility(next, "conv-b", {
      ...DEFAULT_COMPOSER_PILLS_VISIBILITY,
      sync: true,
      diff: false,
    });
    assert.equal(resolveComposerPillsVisibility(third, "conv-a").sync, false);
    assert.equal(resolveComposerPillsVisibility(third, "conv-b").diff, false);
  });

  test("withComposerPillsVisibility without a conversation only updates the default", () => {
    const start = {
      composerPillsVisibility: { ...DEFAULT_COMPOSER_PILLS_VISIBILITY },
      composerPillsVisibilityByConversationId: {},
    };
    const next = withComposerPillsVisibility(start, null, {
      ...DEFAULT_COMPOSER_PILLS_VISIBILITY,
      actions: false,
    });
    assert.equal(next.composerPillsVisibility?.actions, false);
    assert.deepEqual(next.composerPillsVisibilityByConversationId, {});
  });
});

describe("composer built-in pill dynamics", () => {
  test("pills hide when their context does not apply", () => {
    const state = deriveComposerBuiltinPills(DEFAULT_COMPOSER_PILLS_VISIBILITY, null);
    assert.equal(state.showDiff, false);
    assert.equal(state.showConflicts, false);
    assert.equal(state.showSync, false);
    assert.equal(state.showWork, false);
  });

  test("diff pill shows only for dirty git repos with counted changes", () => {
    const clean = insightsWith({ isGitRepo: true });
    assert.equal(deriveComposerBuiltinPills(DEFAULT_COMPOSER_PILLS_VISIBILITY, clean).showDiff, false);
    const dirty = insightsWith({
      isGitRepo: true,
      dirty: true,
      diff: {
        files: [{ path: "a.ts", added: 4, removed: 1, binary: false }],
        totalAdded: 4,
        totalRemoved: 1,
        fileCount: 1,
        truncated: false,
      },
    });
    assert.equal(deriveComposerBuiltinPills(DEFAULT_COMPOSER_PILLS_VISIBILITY, dirty).showDiff, true);
    const off = { ...DEFAULT_COMPOSER_PILLS_VISIBILITY, diff: false };
    assert.equal(deriveComposerBuiltinPills(off, dirty).showDiff, false);
  });

  test("conflicts pill covers both unresolved and resolved-in-merge states", () => {
    const conflicted = insightsWith({
      isGitRepo: true,
      merge: { state: "merging", conflictedFiles: ["src/a.ts"], conflictsResolved: false },
    });
    const resolved = insightsWith({
      isGitRepo: true,
      merge: { state: "merging", conflictedFiles: [], conflictsResolved: true },
    });
    assert.equal(
      deriveComposerBuiltinPills(DEFAULT_COMPOSER_PILLS_VISIBILITY, conflicted).showConflicts,
      true
    );
    const resolvedState = deriveComposerBuiltinPills(DEFAULT_COMPOSER_PILLS_VISIBILITY, resolved);
    assert.equal(resolvedState.showConflicts, true);
    assert.equal(resolvedState.conflictsResolved, true);
  });

  test("sync and work pills require nonzero counts", () => {
    const ahead = insightsWith({ isGitRepo: true, ahead: 2 });
    assert.equal(deriveComposerBuiltinPills(DEFAULT_COMPOSER_PILLS_VISIBILITY, ahead).showSync, true);
    const working = insightsWith({
      work: {
        runningConversations: 1,
        runningConversationTitles: ["Refactor"],
        aliveTerminals: 0,
        runningCloudTasks: 1,
      },
    });
    const state = deriveComposerBuiltinPills(DEFAULT_COMPOSER_PILLS_VISIBILITY, working);
    assert.equal(state.showWork, true);
    assert.equal(state.workCount, 2);
  });
});

describe("quick action visibility rules", () => {
  const fixConflicts = QUICK_ACTION_PRESETS.find((preset) => preset.id === "fix-merge-conflicts")!;
  const pushBranch = QUICK_ACTION_PRESETS.find((preset) => preset.id === "push-branch")!;

  test("conflict-scoped prompt action hides without conflicts and without a conversation", () => {
    const action = materializeQuickActionPreset(fixConflicts);
    const conflicted = insightsWith({
      isGitRepo: true,
      merge: { state: "merging", conflictedFiles: ["a"], conflictsResolved: false },
    });
    assert.equal(
      isQuickActionVisibleInContext(action, {
        insights: conflicted,
        conversationRunning: false,
        hasConversation: true,
      }),
      true
    );
    assert.equal(
      isQuickActionVisibleInContext(action, {
        insights: insightsWith({ isGitRepo: true }),
        conversationRunning: false,
        hasConversation: true,
      }),
      false
    );
    // Prompt actions need a persisted conversation.
    assert.equal(
      isQuickActionVisibleInContext(action, {
        insights: conflicted,
        conversationRunning: false,
        hasConversation: false,
      }),
      false
    );
  });

  test("ahead-scoped command action tracks unpushed commits", () => {
    const action = materializeQuickActionPreset(pushBranch);
    assert.equal(
      isQuickActionVisibleInContext(action, {
        insights: insightsWith({ isGitRepo: true, ahead: 3 }),
        conversationRunning: false,
        hasConversation: false,
      }),
      true
    );
    assert.equal(
      isQuickActionVisibleInContext(action, {
        insights: insightsWith({ isGitRepo: true, ahead: 0 }),
        conversationRunning: false,
        hasConversation: false,
      }),
      false
    );
  });
});

describe("workspace session composer pills persistence", () => {
  test("merge normalizes pills visibility and per-conversation map", () => {
    const model: ModelInfo = { id: "m", name: "M", provider: "auto" };
    const base = createDefaultWorkspaceSession([{ id: "t", title: "T", active: true }], model);
    const merged = mergeWorkspaceSessionFromImport(base, {
      schemaVersion: 1,
      chat: {
        composerPillsVisibility: { diff: false },
        composerPillsVisibilityByConversationId: {
          "conv-1": { work: false },
          "": { diff: false },
        },
        composerStatusBarVisibilityByConversationId: {
          "conv-1": { repo: false },
        },
      },
    });
    assert.deepEqual(merged.chat.composerPillsVisibility, {
      diff: false,
      conflicts: true,
      sync: true,
      work: true,
      actions: true,
    });
    assert.deepEqual(merged.chat.composerPillsVisibilityByConversationId, {
      "conv-1": { diff: true, conflicts: true, sync: true, work: false, actions: true },
    });
    assert.deepEqual(merged.chat.composerStatusBarVisibilityByConversationId, {
      "conv-1": { repo: false, branch: true, goal: true, context: true },
    });
  });
});
