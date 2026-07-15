import assert from "node:assert/strict";
import { test } from "node:test";
import {
  clearDesktopTaskbarGoalProgress,
  markDesktopTaskbarGoalProgressSourceOpen,
  publishDesktopTaskbarGoalProgress,
  resolveDesktopTaskbarGoalProgress,
} from "../src/lib/desktop-taskbar-progress.ts";
import type { BurnProgressStatus } from "../src/lib/agent-chat.ts";

const progress: BurnProgressStatus = {
  progressPercent: 42,
  headline: "Taskbar progress wired",
  summary: "## Progress\n- Added taskbar progress.",
  updatedAt: 1,
  toolCallId: "tool-1",
  history: [],
};

test("resolveDesktopTaskbarGoalProgress only activates for goal modes with progress", () => {
  assert.deepEqual(
    resolveDesktopTaskbarGoalProgress({
      mode: "agent",
      burnProgress: progress,
      conversationStatus: "running",
    }),
    { active: false, mode: "none" }
  );
  assert.deepEqual(
    resolveDesktopTaskbarGoalProgress({
      mode: "burn",
      burnProgress: null,
      conversationStatus: "running",
    }),
    { active: false, mode: "none" }
  );
  assert.deepEqual(
    resolveDesktopTaskbarGoalProgress({
      mode: "burn",
      burnProgress: progress,
      conversationStatus: "running",
    }),
    { active: true, progressPercent: 42, mode: "normal" }
  );
});

test("resolveDesktopTaskbarGoalProgress maps paused and failed states", () => {
  assert.deepEqual(
    resolveDesktopTaskbarGoalProgress({
      mode: "burn",
      burnProgress: progress,
      conversationStatus: "paused",
    }),
    { active: true, progressPercent: 42, mode: "paused" }
  );
  assert.deepEqual(
    resolveDesktopTaskbarGoalProgress({
      mode: "burn",
      burnProgress: progress,
      conversationStatus: "failed",
    }),
    { active: true, progressPercent: 42, mode: "error" }
  );
});

test("resolveDesktopTaskbarGoalProgress clears completed goals", () => {
  assert.deepEqual(
    resolveDesktopTaskbarGoalProgress({
      mode: "burn",
      burnProgress: { ...progress, completedAt: 10 },
      conversationStatus: "idle",
    }),
    { active: false, mode: "none", retainSource: true }
  );
});

test("taskbar publisher uses last opened goal instead of latest background update", () => {
  const sent: unknown[] = [];
  const previousWindow = (globalThis as typeof globalThis & { window?: unknown }).window;
  (globalThis as typeof globalThis & { window?: unknown }).window = {
    cesiumDesktop: {
      setTaskbarGoalProgress(input: unknown) {
        sent.push(input);
        return true;
      },
    },
  };

  try {
    markDesktopTaskbarGoalProgressSourceOpen("goal-a");
    publishDesktopTaskbarGoalProgress("goal-a", {
      active: true,
      progressPercent: 20,
      mode: "normal",
    });
    markDesktopTaskbarGoalProgressSourceOpen("goal-b");
    publishDesktopTaskbarGoalProgress("goal-b", {
      active: true,
      progressPercent: 55,
      mode: "normal",
    });
    publishDesktopTaskbarGoalProgress("goal-a", {
      active: true,
      progressPercent: 80,
      mode: "normal",
    });
    publishDesktopTaskbarGoalProgress("goal-b", {
      active: false,
      mode: "none",
      retainSource: true,
    });

    assert.deepEqual(sent.slice(0, 3), [
      { active: true, progressPercent: 20, mode: "normal" },
      { active: true, progressPercent: 55, mode: "normal" },
      { active: false, mode: "none" },
    ]);
  } finally {
    clearDesktopTaskbarGoalProgress("goal-a");
    clearDesktopTaskbarGoalProgress("goal-b");
    (globalThis as typeof globalThis & { window?: unknown }).window = previousWindow;
  }
});
