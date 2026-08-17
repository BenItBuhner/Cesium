import assert from "node:assert/strict";
import test from "node:test";
import type { MobileAgentProjection } from "@cesium/core";
import {
  COMBINED_RUN_KEY,
  LiveUpdateController,
  WEB_SYNC_FRESH_MS,
  computeLiveUpdateAlert,
  getLiveUpdateSignature,
  type LiveUpdatesNative,
} from "./LiveUpdateController";
import type { LiveUpdatePayload, LiveUpdateStatus } from "./liveUpdateTypes";

function projection(
  overrides: Partial<MobileAgentProjection> = {}
): MobileAgentProjection {
  return {
    workspaceId: "workspace-1",
    conversationId: "conversation-1",
    title: "Agent run",
    status: "running",
    lastEventSeq: 1,
    currentActivity: "Working",
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

function status(): LiveUpdateStatus {
  return {
    sdkInt: 36,
    progressStyleSupported: true,
    canPostPromotedNotifications: true,
    notificationPermissionGranted: true,
    suppressedByDismissal: false,
    deliveryPreference: "live",
  };
}

class FakeNative implements LiveUpdatesNative {
  posted: LiveUpdatePayload[] = [];
  stoppedRuns: string[] = [];
  stoppedAll = 0;
  persistedRunKeys: string[] = [];

  async startOrUpdate(payload: LiveUpdatePayload) {
    this.posted.push(payload);
    return status();
  }
  async stopRun(runKey: string) {
    this.stoppedRuns.push(runKey);
  }
  async stop() {
    this.stoppedAll += 1;
  }
  async getPromotionStatus() {
    return status();
  }
  async getActiveRunKeys() {
    return this.persistedRunKeys;
  }
}

test("tracks one live notification per concurrent agent", async () => {
  const native = new FakeNative();
  const controller = new LiveUpdateController(native);

  await controller.update(projection({ conversationId: "a", startedAt: 10 }));
  await controller.update(projection({ conversationId: "b", startedAt: 20 }));

  assert.deepEqual(controller.getTrackedConversationIds().sort(), ["a", "b"]);
  assert.equal(native.posted.length, 2);
  assert.deepEqual(
    native.posted.map((payload) => payload.runKey),
    ["a:10", "b:20"]
  );
});

test("deduplicates unchanged payloads per run", async () => {
  const native = new FakeNative();
  const controller = new LiveUpdateController(native);

  await controller.update(projection({ conversationId: "a", startedAt: 10 }));
  await controller.update(projection({ conversationId: "a", startedAt: 10 }));
  await controller.update(
    projection({ conversationId: "a", startedAt: 10, currentActivity: "Next step" })
  );

  assert.equal(native.posted.length, 2);
});

test("alerts once when an agent starts needing input, then stays silent", async () => {
  const native = new FakeNative();
  const controller = new LiveUpdateController(native);

  await controller.update(projection({ conversationId: "a", startedAt: 10 }));
  await controller.update(
    projection({
      conversationId: "a",
      startedAt: 10,
      status: "awaiting_permission",
      pendingIntervention: "permission",
    })
  );
  await controller.update(
    projection({
      conversationId: "a",
      startedAt: 10,
      status: "awaiting_permission",
      pendingIntervention: "permission",
      currentActivity: "Still waiting",
    })
  );

  assert.deepEqual(
    native.posted.map((payload) => payload.alert),
    [false, true, false]
  );
});

test("terminal updates alert, post once, and end tracking without cancelling", async () => {
  const native = new FakeNative();
  const controller = new LiveUpdateController(native);
  // Backgrounded app: the default "background" completion mode posts.
  controller.setAppActive(false);

  await controller.update(projection({ conversationId: "a", startedAt: 10 }));
  await controller.update(
    projection({
      conversationId: "a",
      startedAt: 10,
      status: "completed",
      completedAt: 5_000,
    })
  );

  assert.equal(native.posted.length, 2);
  assert.equal(native.posted[1]?.alert, true);
  assert.equal(native.posted[1]?.ongoing, false);
  // The completion notification must stay visible: no stopRun for it.
  assert.deepEqual(native.stoppedRuns, []);
  assert.deepEqual(controller.getTrackedConversationIds(), []);
});

test("completions while the app is foregrounded post nothing by default", async () => {
  const native = new FakeNative();
  const controller = new LiveUpdateController(native);
  controller.setAppActive(true);

  await controller.update(projection({ conversationId: "a", startedAt: 10 }));
  await controller.update(
    projection({ conversationId: "a", startedAt: 10, status: "completed" })
  );

  // Only the ongoing progress update posted; the terminal one was suppressed
  // and the ongoing notification was removed instead.
  assert.equal(native.posted.length, 1);
  assert.deepEqual(native.stoppedRuns, ["a:10"]);
  assert.deepEqual(controller.getTrackedConversationIds(), []);
});

test("completion mode 'always' posts even while the app is foregrounded", async () => {
  const native = new FakeNative();
  const controller = new LiveUpdateController(native);
  controller.setAppActive(true);
  controller.setAlertPreferences({ completion: "always", intervention: "always" });

  await controller.update(projection({ conversationId: "a", startedAt: 10 }));
  await controller.update(
    projection({ conversationId: "a", startedAt: 10, status: "completed" })
  );

  assert.equal(native.posted.length, 2);
  assert.equal(native.posted[1]?.alert, true);
  assert.deepEqual(native.stoppedRuns, []);
});

test("completion mode 'off' never posts a terminal notification", async () => {
  const native = new FakeNative();
  const controller = new LiveUpdateController(native);
  controller.setAppActive(false);
  controller.setAlertPreferences({ completion: "off", intervention: "always" });

  await controller.update(projection({ conversationId: "a", startedAt: 10 }));
  await controller.update(
    projection({ conversationId: "a", startedAt: 10, status: "failed" })
  );

  assert.equal(native.posted.length, 1);
  assert.deepEqual(native.stoppedRuns, ["a:10"]);
});

test("intervention alerts go silent while foregrounded when set to background-only", async () => {
  const native = new FakeNative();
  const controller = new LiveUpdateController(native);
  controller.setAppActive(true);
  controller.setAlertPreferences({ completion: "background", intervention: "background" });

  await controller.update(projection({ conversationId: "a", startedAt: 10 }));
  await controller.update(
    projection({
      conversationId: "a",
      startedAt: 10,
      status: "awaiting_permission",
      pendingIntervention: "permission",
    })
  );

  // The ongoing notification still updates (state accuracy), just silently.
  assert.equal(native.posted.length, 2);
  assert.equal(native.posted[1]?.alert, false);
  assert.equal(native.posted[1]?.intervention, "permission");
});

test("ignores runs that finished before they were ever tracked", async () => {
  const native = new FakeNative();
  const controller = new LiveUpdateController(native);

  await controller.update(
    projection({ conversationId: "a", status: "completed", startedAt: null })
  );

  assert.equal(native.posted.length, 0);
});

test("an active run keeps its notification identity when the derived key drifts", async () => {
  const native = new FakeNative();
  const controller = new LiveUpdateController(native);

  // The web bridge and the native agent socket derive different startedAt
  // values for the same run (different event windows). The tracked key must
  // stay sticky — cancelling + reposting under a new hashed id is the
  // close/reopen flicker this guards against.
  await controller.update(projection({ conversationId: "a", startedAt: 10 }));
  await controller.update(
    projection({ conversationId: "a", startedAt: 99, currentActivity: "Later" })
  );

  assert.deepEqual(native.stoppedRuns, []);
  assert.equal(native.posted.length, 2);
  assert.deepEqual(
    native.posted.map((payload) => payload.runKey),
    ["a:10", "a:10"]
  );
});

test("the elapsed anchor pins to the earliest known start of the run", async () => {
  const native = new FakeNative();
  const controller = new LiveUpdateController(native);

  // A socket-derived projection falls back to `updatedAt` (later than the
  // true start); a web-derived one later reports the real start event.
  await controller.update(projection({ conversationId: "a", startedAt: 500 }));
  await controller.update(
    projection({ conversationId: "a", startedAt: 10, currentActivity: "Real start" })
  );
  await controller.update(
    projection({ conversationId: "a", startedAt: 500, currentActivity: "Fallback again" })
  );

  assert.deepEqual(
    native.posted.map((payload) => payload.startedAt),
    [500, 10, 10]
  );
});

test("a new run after a terminal boundary starts a fresh notification", async () => {
  const native = new FakeNative();
  const controller = new LiveUpdateController(native);
  controller.setAppActive(false);

  await controller.update(projection({ conversationId: "a", startedAt: 10 }));
  await controller.update(
    projection({ conversationId: "a", startedAt: 10, status: "completed" })
  );
  await controller.update(projection({ conversationId: "a", startedAt: 99 }));

  assert.deepEqual(
    native.posted.map((payload) => payload.runKey),
    ["a:10", "a:10", "a:99"]
  );
  assert.deepEqual(native.stoppedRuns, []);
});

test("terminal updates replace the ongoing notification even when the derived key drifted", async () => {
  const native = new FakeNative();
  const controller = new LiveUpdateController(native);
  controller.setAppActive(false);

  await controller.update(projection({ conversationId: "a", startedAt: 10 }));
  // Terminal projection derived from a source that lost the start event.
  await controller.update(
    projection({ conversationId: "a", startedAt: 999, status: "completed" })
  );

  // Same key => same native notification id => the final state replaces the
  // ongoing notification instead of leaving a zombie behind.
  assert.deepEqual(
    native.posted.map((payload) => payload.runKey),
    ["a:10", "a:10"]
  );
  assert.equal(native.posted[1]?.ongoing, false);
});

test("socket projections are suppressed while web bridge syncs are fresh", async () => {
  const native = new FakeNative();
  let nowMs = 100_000;
  const controller = new LiveUpdateController(native, () => nowMs);

  await controller.updateAll([projection({ conversationId: "a", startedAt: 10 })]);
  // The backgrounded WebView is still alive and syncing; the socket derives
  // a conflicting projection for the same run. It must be dropped.
  await controller.updateFromSocket(
    projection({ conversationId: "a", startedAt: 500, currentActivity: "Socket view" })
  );
  assert.equal(native.posted.length, 1);

  // Web syncs go quiet (WebView frozen); the socket takes over.
  nowMs += WEB_SYNC_FRESH_MS + 1;
  await controller.updateFromSocket(
    projection({ conversationId: "a", startedAt: 500, currentActivity: "Socket view" })
  );
  assert.equal(native.posted.length, 2);
  // Identity and elapsed anchor survive the source handover.
  assert.equal(native.posted[1]?.runKey, "a:10");
  assert.equal(native.posted[1]?.startedAt, 10);
});

test("socket projections flow before the first web sync", async () => {
  const native = new FakeNative();
  const controller = new LiveUpdateController(native, () => 100_000);

  await controller.updateFromSocket(projection({ conversationId: "a", startedAt: 10 }));

  assert.equal(native.posted.length, 1);
});

test("volatile ETA drift does not repost the notification", async () => {
  const native = new FakeNative();
  const controller = new LiveUpdateController(native);
  const withEta = (estimatedCompletionAt: number) =>
    projection({
      conversationId: "a",
      startedAt: 10,
      goalProgress: {
        percent: 40,
        headline: "Compiling",
        runtimeMs: 60_000,
        estimatedRemainingMs: 90_000,
        estimatedCompletionAt,
      },
    });

  await controller.update(withEta(1_000_000));
  // Same state re-derived 500ms later: only the now-anchored ETA moved.
  await controller.update(withEta(1_000_500));
  // A full minute of drift is a real change and may repost.
  await controller.update(withEta(1_090_000));

  assert.equal(native.posted.length, 2);
});

test("getLiveUpdateSignature ignores sub-minute ETA jitter only", () => {
  const base = {
    runKey: "a:10",
    title: "Agent run",
    body: "Working",
    progressKind: "goal" as const,
    estimatedCompletionAt: 1_000_000,
    estimatedRemainingSeconds: 90,
  };
  assert.equal(
    getLiveUpdateSignature(base),
    getLiveUpdateSignature({ ...base, estimatedCompletionAt: 1_000_500 })
  );
  assert.notEqual(
    getLiveUpdateSignature(base),
    getLiveUpdateSignature({ ...base, estimatedCompletionAt: 1_090_000 })
  );
  assert.notEqual(
    getLiveUpdateSignature(base),
    getLiveUpdateSignature({ ...base, body: "Next step" })
  );
});

test("updateAll reconciles away runs that no longer exist", async () => {
  const native = new FakeNative();
  const controller = new LiveUpdateController(native);

  await controller.updateAll([
    projection({ conversationId: "a", startedAt: 10 }),
    projection({ conversationId: "b", startedAt: 20 }),
  ]);
  await controller.updateAll([projection({ conversationId: "b", startedAt: 20 })]);

  assert.deepEqual(native.stoppedRuns, ["a:10"]);
  assert.deepEqual(controller.getTrackedConversationIds(), ["b"]);
});

test("updateAll cancels natively persisted runs left over from a dead process", async () => {
  const native = new FakeNative();
  // A previous app process persisted these ongoing runs; the foreground
  // service restored their notifications, but no agent is running anymore.
  native.persistedRunKeys = ["ghost:123", "b:20"];
  const controller = new LiveUpdateController(native);

  await controller.updateAll([projection({ conversationId: "b", startedAt: 20 })]);

  // The tracked run survives; the ghost's notification is stopped.
  assert.deepEqual(native.stoppedRuns, ["ghost:123"]);
  assert.deepEqual(controller.getTrackedConversationIds(), ["b"]);
});

function todoProgress(completed: number, total: number) {
  return {
    total,
    completed,
    blocked: 0,
    pending: total - completed - 1,
    inProgress: 1,
    currentIndex: completed + 1,
    percent: Math.round((completed / total) * 100),
    estimatedRemainingMs: null,
    estimatedCompletionAt: null,
  };
}

test("combined mode folds concurrent runs into one aggregated notification", async () => {
  const native = new FakeNative();
  const controller = new LiveUpdateController(native);
  controller.setDisplayPreferences({ eta: "goal", multiAgent: "combined" });

  await controller.update(
    projection({
      conversationId: "a",
      startedAt: 10,
      title: "Fix build",
      todoProgress: todoProgress(2, 5),
    })
  );
  // A lone run keeps its full per-run detail.
  assert.equal(native.posted[0]?.runKey, "a:10");

  await controller.update(
    projection({
      conversationId: "b",
      startedAt: 20,
      title: "Write docs",
      todoProgress: todoProgress(1, 3),
    })
  );
  // The individual notification folds into the aggregate.
  assert.deepEqual(native.stoppedRuns, ["a:10"]);
  const combined = native.posted.at(-1);
  assert.equal(combined?.runKey, COMBINED_RUN_KEY);
  assert.equal(combined?.title, "2 agents running");
  assert.equal(combined?.body, "Fix build 2/5 · Write docs 1/3");
  // Aggregate todo progression across runs; never a time estimate.
  assert.equal(combined?.progressKind, "todo");
  assert.equal(combined?.progress, 3);
  assert.equal(combined?.progressMax, 8);
  assert.equal(combined?.shortText, "3/8");
  assert.equal(combined?.estimatedCompletionAt, undefined);
  // Elapsed anchors at the earliest running agent.
  assert.equal(combined?.startedAt, 10);
});

test("combined notification unfolds to per-run detail when one agent finishes", async () => {
  const native = new FakeNative();
  const controller = new LiveUpdateController(native);
  controller.setAppActive(false);
  controller.setDisplayPreferences({ eta: "goal", multiAgent: "combined" });

  await controller.update(projection({ conversationId: "a", startedAt: 10 }));
  await controller.update(projection({ conversationId: "b", startedAt: 20 }));
  await controller.update(
    projection({ conversationId: "a", startedAt: 10, status: "completed" })
  );

  // The finished run posts its own terminal notification under its sticky
  // key, the aggregate is retired, and the survivor regains full detail.
  const terminal = native.posted.find((payload) => payload.ongoing === false);
  assert.equal(terminal?.runKey, "a:10");
  assert.ok(native.stoppedRuns.includes(COMBINED_RUN_KEY));
  assert.equal(native.posted.at(-1)?.runKey, "b:20");
  assert.deepEqual(controller.getTrackedConversationIds(), ["b"]);
});

test("combined notification surfaces needs-input with the blocked run's conversation", async () => {
  const native = new FakeNative();
  const controller = new LiveUpdateController(native);
  controller.setDisplayPreferences({ eta: "goal", multiAgent: "combined" });

  await controller.update(projection({ conversationId: "a", startedAt: 10 }));
  await controller.update(projection({ conversationId: "b", startedAt: 20 }));
  await controller.update(
    projection({
      conversationId: "a",
      startedAt: 10,
      status: "awaiting_permission",
      pendingIntervention: "permission",
    })
  );

  const combined = native.posted.at(-1);
  assert.equal(combined?.runKey, COMBINED_RUN_KEY);
  assert.equal(combined?.alert, true);
  assert.equal(combined?.intervention, "permission");
  assert.equal(combined?.conversationId, "a");
  assert.match(combined?.body ?? "", /^1 agent needs input · /);
});

test("separate mode is untouched by combined bookkeeping", async () => {
  const native = new FakeNative();
  const controller = new LiveUpdateController(native);

  await controller.update(projection({ conversationId: "a", startedAt: 10 }));
  await controller.update(projection({ conversationId: "b", startedAt: 20 }));

  assert.deepEqual(
    native.posted.map((payload) => payload.runKey),
    ["a:10", "b:20"]
  );
  assert.deepEqual(native.stoppedRuns, []);
});

test("refreshStatus absorbs natively persisted display preferences", async () => {
  const native = new FakeNative();
  native.getPromotionStatus = async () => ({
    ...status(),
    displayPreferences: { eta: "always", multiAgent: "combined" },
  });
  const controller = new LiveUpdateController(native);

  await controller.refreshStatus();

  assert.deepEqual(controller.getDisplayPreferences(), {
    eta: "always",
    multiAgent: "combined",
  });
});

test("refreshStatus absorbs natively persisted alert preferences", async () => {
  const native = new FakeNative();
  native.getPromotionStatus = async () => ({
    ...status(),
    alertPreferences: { completion: "off", intervention: "background" },
  });
  const controller = new LiveUpdateController(native);

  await controller.refreshStatus();

  assert.deepEqual(controller.getAlertPreferences(), {
    completion: "off",
    intervention: "background",
  });
});

test("computeLiveUpdateAlert covers intervention and terminal transitions", () => {
  const running = projection();
  const needsInput = projection({
    status: "awaiting_question",
    pendingIntervention: "question",
  });
  const completed = projection({ status: "completed" });

  // First sight of an agent already waiting on the user must alert.
  assert.equal(computeLiveUpdateAlert(null, needsInput), true);
  assert.equal(computeLiveUpdateAlert(running, needsInput), true);
  assert.equal(computeLiveUpdateAlert(needsInput, needsInput), false);
  assert.equal(computeLiveUpdateAlert(running, running), false);
  assert.equal(computeLiveUpdateAlert(running, completed), true);
  assert.equal(computeLiveUpdateAlert(null, completed), false);
});
