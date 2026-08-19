import assert from "node:assert/strict";
import { test } from "node:test";
import {
  buildDesktopCombinedRunSummary,
  buildDesktopCompletionNotification,
  buildDesktopInterventionNotification,
  buildDesktopRunSummary,
  computeDesktopAlert,
  DesktopAgentNotificationController,
  DEFAULT_DESKTOP_AGENT_NOTIFICATION_PREFERENCES,
  getDesktopRunKey,
  isDesktopAlertAllowed,
  sanitizeDesktopAgentNotificationPreferences,
  type DesktopAgentNotificationPreferences,
} from "../src/lib/desktop-agent-notifications.ts";
import type {
  DesktopAgentRunSummary,
  DesktopNotifyPayload,
} from "../src/lib/desktop-native-bridge.ts";
import type { MobileAgentProjection } from "../src/lib/mobile-agent-projection.ts";

function projection(
  overrides: Partial<MobileAgentProjection> = {}
): MobileAgentProjection {
  return {
    workspaceId: "ws-1",
    conversationId: "conv-1",
    title: "Refactor the parser",
    status: "running",
    lastEventSeq: 10,
    currentActivity: "Editing tokenizer.ts",
    currentTodoId: null,
    currentTodo: null,
    pendingIntervention: null,
    startedAt: 1_000,
    updatedAt: 2_000,
    completedAt: null,
    elapsedMs: 1_000,
    lastError: null,
    todoProgress: null,
    goalProgress: null,
    ...overrides,
  };
}

type Recorded = {
  notifications: DesktopNotifyPayload[];
  syncedRuns: DesktopAgentRunSummary[][];
};

function makeController(
  preferences?: DesktopAgentNotificationPreferences
): { controller: DesktopAgentNotificationController; recorded: Recorded } {
  const recorded: Recorded = { notifications: [], syncedRuns: [] };
  const controller = new DesktopAgentNotificationController({
    notify: (payload) => {
      recorded.notifications.push(payload);
    },
    syncRuns: (input) => {
      recorded.syncedRuns.push(input.runs);
    },
  });
  if (preferences) {
    controller.setPreferences(preferences);
  }
  return { controller, recorded };
}

test("computeDesktopAlert fires on intervention start and terminal transitions", () => {
  const running = projection();
  const blocked = projection({
    status: "awaiting_permission",
    pendingIntervention: "permission",
  });
  const done = projection({ status: "completed" });

  assert.equal(computeDesktopAlert(null, running), false);
  assert.equal(computeDesktopAlert(running, blocked), true);
  assert.equal(computeDesktopAlert(blocked, blocked), false);
  assert.equal(computeDesktopAlert(running, done), true);
  assert.equal(computeDesktopAlert(null, done), false);
});

test("isDesktopAlertAllowed honors mode and focus", () => {
  assert.equal(isDesktopAlertAllowed("always", true), true);
  assert.equal(isDesktopAlertAllowed("always", false), true);
  assert.equal(isDesktopAlertAllowed("background", true), false);
  assert.equal(isDesktopAlertAllowed("background", false), true);
  assert.equal(isDesktopAlertAllowed("off", false), false);
});

test("sanitize falls back to defaults for junk input", () => {
  assert.deepEqual(
    sanitizeDesktopAgentNotificationPreferences(null),
    DEFAULT_DESKTOP_AGENT_NOTIFICATION_PREFERENCES
  );
  assert.deepEqual(
    sanitizeDesktopAgentNotificationPreferences({
      alerts: { completion: "sometimes", intervention: "off" },
      display: { eta: "never", multiAgent: "combined" },
    }),
    {
      alerts: { completion: "background", intervention: "off" },
      display: { eta: "goal", multiAgent: "combined" },
    }
  );
});

test("run summaries carry goal progress and ETA per display preference", () => {
  const goalRun = projection({
    goalProgress: {
      percent: 40,
      headline: "Halfway through migration",
      runtimeMs: 60_000,
      estimatedRemainingMs: 5 * 60_000,
      estimatedCompletionAt: 10_000,
    },
  });
  const withEta = buildDesktopRunSummary(goalRun, "run-1", "goal");
  assert.equal(withEta.progressLabel, "40%");
  assert.equal(withEta.detail, "Halfway through migration · ~5m left");
  assert.equal(withEta.active, true);

  const withoutEta = buildDesktopRunSummary(goalRun, "run-1", "off");
  assert.equal(withoutEta.detail, "Halfway through migration");

  const todoRun = projection({
    todoProgress: {
      total: 7,
      completed: 3,
      blocked: 0,
      pending: 4,
      inProgress: 1,
      currentIndex: 4,
      percent: 43,
      estimatedRemainingMs: 2 * 60_000,
      estimatedCompletionAt: null,
    },
  });
  const todoDefault = buildDesktopRunSummary(todoRun, "run-2", "goal");
  assert.equal(todoDefault.progressLabel, "3/7");
  // Todo ETAs are opt-in ("always") only.
  assert.equal(todoDefault.detail.includes("left"), false);
  const todoAlways = buildDesktopRunSummary(todoRun, "run-2", "always");
  assert.equal(todoAlways.detail.includes("~2m left"), true);
});

test("completion notification states outcome; failures surface the error", () => {
  const done = buildDesktopCompletionNotification(
    projection({ status: "completed" }),
    "run-1"
  );
  assert.equal(done.body, "Agent run completed");
  assert.equal(done.kind, "completion");

  const failed = buildDesktopCompletionNotification(
    projection({ status: "failed", lastError: "Provider exploded" }),
    "run-1"
  );
  assert.equal(failed.body, "Provider exploded");
});

test("intervention notification distinguishes permission from question", () => {
  const permission = buildDesktopInterventionNotification(
    projection({ status: "awaiting_permission", pendingIntervention: "permission" }),
    "run-1"
  );
  assert.equal(permission.body, "Needs permission to continue");
  const question = buildDesktopInterventionNotification(
    projection({ status: "awaiting_question", pendingIntervention: "question" }),
    "run-1"
  );
  assert.equal(question.body, "Asked you a question");
});

test("controller notifies once when an agent starts needing input", () => {
  const { controller, recorded } = makeController();
  controller.setAppActive(true);

  controller.updateAll([projection()]);
  assert.equal(recorded.notifications.length, 0);

  const blocked = projection({
    status: "awaiting_permission",
    pendingIntervention: "permission",
  });
  controller.updateAll([blocked]);
  controller.updateAll([blocked]);
  assert.equal(recorded.notifications.length, 1);
  assert.equal(recorded.notifications[0]?.kind, "intervention");

  // Intervention resolved and a new one starts: alert again.
  controller.updateAll([projection()]);
  controller.updateAll([
    projection({ status: "awaiting_question", pendingIntervention: "question" }),
  ]);
  assert.equal(recorded.notifications.length, 2);
});

test("controller honors the background-only completion preference", () => {
  const { controller, recorded } = makeController();
  // Default completion preference is "background".
  controller.setAppActive(true);
  controller.updateAll([projection()]);
  controller.updateAll([projection({ status: "completed" })]);
  assert.equal(recorded.notifications.length, 0);

  controller.setAppActive(false);
  controller.updateAll([projection({ conversationId: "conv-2" })]);
  controller.updateAll([
    projection({ conversationId: "conv-2", status: "completed" }),
  ]);
  assert.equal(recorded.notifications.length, 1);
  assert.equal(recorded.notifications[0]?.kind, "completion");
});

test("controller never resurrects runs that finished before tracking", () => {
  const { controller, recorded } = makeController();
  controller.setAppActive(false);
  controller.updateAll([projection({ status: "completed" })]);
  assert.equal(recorded.notifications.length, 0);
  assert.deepEqual(controller.getTrackedConversationIds(), []);
});

test("controller keeps the sticky run key across projection identity drift", () => {
  const { controller, recorded } = makeController();
  controller.setAppActive(false);
  const first = projection({ startedAt: 1_000 });
  controller.updateAll([first]);
  // Same run re-derived with a different startedAt (source disagreement).
  controller.updateAll([projection({ startedAt: 3_000, status: "completed" })]);
  assert.equal(recorded.notifications.length, 1);
  assert.equal(recorded.notifications[0]?.runKey, getDesktopRunKey(first));
});

test("controller syncs tray runs and dedupes identical states", () => {
  const { controller, recorded } = makeController();
  controller.updateAll([projection()]);
  controller.updateAll([projection()]);
  assert.equal(recorded.syncedRuns.length, 1);
  assert.equal(recorded.syncedRuns[0]?.length, 1);
  assert.equal(recorded.syncedRuns[0]?.[0]?.title, "Refactor the parser");

  // Run disappears from the authoritative set: tray empties.
  controller.updateAll([]);
  assert.equal(recorded.syncedRuns.length, 2);
  assert.deepEqual(recorded.syncedRuns[1], []);
});

test("combined display folds concurrent runs into one tray entry", () => {
  const { controller, recorded } = makeController({
    alerts: { completion: "background", intervention: "always" },
    display: { eta: "goal", multiAgent: "combined" },
  });
  controller.updateAll([
    projection({ conversationId: "conv-1", title: "Agent A" }),
    projection({
      conversationId: "conv-2",
      title: "Agent B",
      status: "awaiting_question",
      pendingIntervention: "question",
    }),
  ]);
  const lastSync = recorded.syncedRuns.at(-1);
  assert.equal(lastSync?.length, 1);
  assert.equal(lastSync?.[0]?.runKey, "cesium-agents-combined");
  assert.equal(lastSync?.[0]?.title, "2 agents running");
  assert.equal(lastSync?.[0]?.needsInput, true);
  assert.equal(lastSync?.[0]?.detail.includes("1 agent needs input"), true);
  // The single blocked run's conversation is wired for click-through.
  assert.equal(lastSync?.[0]?.conversationId, "conv-2");
});

test("combined summary aggregates and elides beyond three runs", () => {
  const summaries = ["A", "B", "C", "D"].map((name, index) =>
    buildDesktopRunSummary(
      projection({ conversationId: `conv-${index}`, title: `Agent ${name}` }),
      `run-${index}`,
      "goal"
    )
  );
  const combined = buildDesktopCombinedRunSummary(summaries);
  assert.equal(combined.title, "4 agents running");
  assert.equal(combined.detail.includes("+1 more"), true);
  assert.equal(combined.needsInput, false);
});
