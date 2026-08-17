import assert from "node:assert/strict";
import test from "node:test";
import type { MobileAgentProjection } from "@cesium/core";
import {
  LiveUpdateController,
  computeLiveUpdateAlert,
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

test("a new run in the same conversation retires the previous notification", async () => {
  const native = new FakeNative();
  const controller = new LiveUpdateController(native);

  await controller.update(projection({ conversationId: "a", startedAt: 10 }));
  await controller.update(projection({ conversationId: "a", startedAt: 99 }));

  assert.deepEqual(native.stoppedRuns, ["a:10"]);
  assert.equal(native.posted[1]?.runKey, "a:99");
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
