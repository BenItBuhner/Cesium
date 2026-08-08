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
