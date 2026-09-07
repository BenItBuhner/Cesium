import assert from "node:assert/strict";
import test from "node:test";
import type { MobileAgentProjection } from "@cesium/core";
import {
  LIVE_RUN_KEY_PREFIX,
  LiveUpdateController,
  WEB_SYNC_FRESH_MS,
  computeLiveUpdateAlert,
  getLiveBatchRunKey,
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
    pendingPermissionRequestId: null,
    pendingPermissionAllowOptionId: null,
    pendingPermissionDenyOptionId: null,
    pendingQuestionId: null,
    startedAt: 1_000,
    updatedAt: 2_000,
    completedAt: null,
    elapsedMs: 1_000,
    lastError: null,
    todoProgress: null,
    goalProgress: null,
    phase: "working",
    editStats: null,
    summary: null,
    pullRequestUrl: null,
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

  get ongoing() {
    return this.posted.filter((payload) => payload.ongoing !== false);
  }
  get terminal() {
    return this.posted.filter((payload) => payload.ongoing === false);
  }
}

const LIVE_A = getLiveBatchRunKey("a:10");

test("concurrent agents share one consolidated live notification", async () => {
  const native = new FakeNative();
  const controller = new LiveUpdateController(native);

  await controller.update(projection({ conversationId: "a", startedAt: 10, title: "Fix build" }));
  await controller.update(
    projection({ conversationId: "b", startedAt: 20, title: "Write docs", phase: "starting" })
  );

  assert.deepEqual(controller.getTrackedConversationIds().sort(), ["a", "b"]);
  assert.equal(native.posted.length, 2);
  // Every post targets the same notification identity, named by the batch opener.
  assert.deepEqual(
    native.posted.map((payload) => payload.runKey),
    [LIVE_A, LIVE_A]
  );
  assert.ok(LIVE_A.startsWith(`${LIVE_RUN_KEY_PREFIX}:`));
  assert.equal(controller.getLiveRunKey(), LIVE_A);
  // A lone run shows its own title and detail; two runs become the agent list.
  assert.equal(native.posted[0]?.title, "Fix build");
  assert.equal(native.posted[1]?.title, "2 agents running");
  assert.equal(native.posted[1]?.expandedBody, "• Fix build · Working\n• Write docs · Starting");
  assert.deepEqual(native.stoppedRuns, []);
});

test("deduplicates unchanged live payloads", async () => {
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
      phase: "needs_permission",
    })
  );
  await controller.update(
    projection({
      conversationId: "a",
      startedAt: 10,
      status: "awaiting_permission",
      pendingIntervention: "permission",
      phase: "needs_permission",
      currentActivity: "Still waiting",
    })
  );

  assert.deepEqual(
    native.posted.map((payload) => payload.alert),
    [false, true, false]
  );
});

test("a finished lone run posts its completion card and retires the live notification", async () => {
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
      phase: "finished",
    })
  );

  assert.equal(native.posted.length, 2);
  const card = native.posted[1];
  assert.equal(card?.alert, true);
  assert.equal(card?.ongoing, false);
  // The card lives under the run's own key so it survives independently of
  // the live notification, which is removed now that nothing runs.
  assert.equal(card?.runKey, "a:10");
  assert.equal(card?.subText, "Finished");
  assert.deepEqual(native.stoppedRuns, [LIVE_A]);
  assert.equal(controller.getLiveRunKey(), null);
  assert.deepEqual(controller.getTrackedConversationIds(), []);
});

test("a finishing agent leaves the list while the others keep the live notification", async () => {
  const native = new FakeNative();
  const controller = new LiveUpdateController(native);
  controller.setAppActive(false);

  await controller.update(projection({ conversationId: "a", startedAt: 10, title: "Fix build" }));
  await controller.update(projection({ conversationId: "b", startedAt: 20, title: "Write docs" }));
  await controller.update(
    projection({ conversationId: "a", startedAt: 10, status: "completed", phase: "finished" })
  );

  assert.equal(native.terminal.length, 1);
  assert.equal(native.terminal[0]?.runKey, "a:10");
  // The survivor regains the lone-run detail view under the SAME live key -
  // the batch identity does not change when its opener finishes.
  const live = native.posted.at(-1);
  assert.equal(live?.runKey, LIVE_A);
  assert.equal(live?.title, "Write docs");
  assert.equal(live?.ongoing, true);
  assert.deepEqual(native.stoppedRuns, []);
  assert.deepEqual(controller.getTrackedConversationIds(), ["b"]);
});

test("the next batch after everything went quiet gets a fresh live identity", async () => {
  const native = new FakeNative();
  const controller = new LiveUpdateController(native);
  controller.setAppActive(false);

  await controller.update(projection({ conversationId: "a", startedAt: 10 }));
  await controller.update(
    projection({ conversationId: "a", startedAt: 10, status: "completed", phase: "finished" })
  );
  await controller.update(projection({ conversationId: "b", startedAt: 99 }));

  // A swipe-dismissal of the first batch's notification must not silence
  // this one: its key differs.
  assert.equal(native.posted.at(-1)?.runKey, getLiveBatchRunKey("b:99"));
  assert.deepEqual(native.stoppedRuns, [LIVE_A]);
});

test("completions while the app is foregrounded post nothing by default", async () => {
  const native = new FakeNative();
  const controller = new LiveUpdateController(native);
  controller.setAppActive(true);

  await controller.update(projection({ conversationId: "a", startedAt: 10 }));
  await controller.update(
    projection({ conversationId: "a", startedAt: 10, status: "completed", phase: "finished" })
  );

  // Only the live notification posted; no completion card, and the live
  // notification is removed instead.
  assert.equal(native.posted.length, 1);
  assert.deepEqual(native.stoppedRuns, [LIVE_A]);
  assert.deepEqual(controller.getTrackedConversationIds(), []);
});

test("completion mode 'always' posts even while the app is foregrounded", async () => {
  const native = new FakeNative();
  const controller = new LiveUpdateController(native);
  controller.setAppActive(true);
  controller.setAlertPreferences({ completion: "always", intervention: "always" });

  await controller.update(projection({ conversationId: "a", startedAt: 10 }));
  await controller.update(
    projection({ conversationId: "a", startedAt: 10, status: "completed", phase: "finished" })
  );

  assert.equal(native.terminal.length, 1);
  assert.equal(native.terminal[0]?.alert, true);
  assert.deepEqual(native.stoppedRuns, [LIVE_A]);
});

test("completion mode 'off' never posts a completion card", async () => {
  const native = new FakeNative();
  const controller = new LiveUpdateController(native);
  controller.setAppActive(false);
  controller.setAlertPreferences({ completion: "off", intervention: "always" });

  await controller.update(projection({ conversationId: "a", startedAt: 10 }));
  await controller.update(
    projection({ conversationId: "a", startedAt: 10, status: "failed", phase: "failed" })
  );

  assert.equal(native.terminal.length, 0);
  assert.deepEqual(native.stoppedRuns, [LIVE_A]);
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
      phase: "needs_permission",
    })
  );

  // The live notification still updates (state accuracy), just silently.
  assert.equal(native.posted.length, 2);
  assert.equal(native.posted[1]?.alert, false);
  assert.equal(native.posted[1]?.intervention, "permission");
});

test("ignores runs that finished before they were ever tracked", async () => {
  const native = new FakeNative();
  const controller = new LiveUpdateController(native);

  await controller.update(
    projection({ conversationId: "a", status: "completed", startedAt: null, phase: "finished" })
  );

  assert.equal(native.posted.length, 0);
  assert.equal(controller.getLiveRunKey(), null);
});

test("an active run keeps its identity when the derived key drifts", async () => {
  const native = new FakeNative();
  const controller = new LiveUpdateController(native);

  // The web bridge and the native agent socket derive different startedAt
  // values for the same run (different event windows). The tracked key must
  // stay sticky - cancelling + reposting under a new hashed id is the
  // close/reopen flicker this guards against.
  await controller.update(projection({ conversationId: "a", startedAt: 10 }));
  await controller.update(
    projection({ conversationId: "a", startedAt: 99, currentActivity: "Later" })
  );

  assert.deepEqual(native.stoppedRuns, []);
  assert.deepEqual(
    native.posted.map((payload) => payload.runKey),
    [LIVE_A, LIVE_A]
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

test("the completion card keeps the sticky key and pinned start even when the terminal projection drifted", async () => {
  const native = new FakeNative();
  const controller = new LiveUpdateController(native);
  controller.setAppActive(false);

  await controller.update(projection({ conversationId: "a", startedAt: 10 }));
  // Terminal projection derived from a source that lost the start event.
  await controller.update(
    projection({
      conversationId: "a",
      startedAt: 999,
      status: "completed",
      completedAt: 61_010,
      phase: "finished",
    })
  );

  const card = native.terminal[0];
  assert.equal(card?.runKey, "a:10");
  assert.equal(card?.startedAt, 10);
  // Runtime is measured from the pinned start, not the drifted one.
  assert.equal(card?.body, "Run complete (runtime 1m 01s).");
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
  assert.equal(native.posted[1]?.runKey, LIVE_A);
  assert.equal(native.posted[1]?.startedAt, 10);
});

test("socket projections flow before the first web sync", async () => {
  const native = new FakeNative();
  const controller = new LiveUpdateController(native, () => 100_000);

  await controller.updateFromSocket(projection({ conversationId: "a", startedAt: 10 }));

  assert.equal(native.posted.length, 1);
});

test("sub-minute ETA drift does not repost the live notification", async () => {
  const native = new FakeNative();
  const controller = new LiveUpdateController(native);
  const withEta = (estimatedRemainingMs: number) =>
    projection({
      conversationId: "a",
      startedAt: 10,
      goalProgress: {
        percent: 40,
        headline: "Compiling",
        runtimeMs: 60_000,
        estimatedRemainingMs,
        estimatedCompletionAt: 1_000_000 + estimatedRemainingMs,
      },
    });

  await controller.update(withEta(90_000));
  // Same state re-derived 500ms later: the estimate moved by half a second.
  await controller.update(withEta(89_500));
  // A full minute of drift changes the "~Nm left" text and may repost.
  await controller.update(withEta(20_000));

  assert.equal(native.posted.length, 2);
});

test("getLiveUpdateSignature tracks visible content only", () => {
  const base: LiveUpdatePayload = {
    runKey: "a:10",
    title: "Agent run",
    body: "Working",
    expandedBody: "Working\nGoal 40% · ~2m left",
  };
  assert.equal(getLiveUpdateSignature(base), getLiveUpdateSignature({ ...base }));
  assert.notEqual(
    getLiveUpdateSignature(base),
    getLiveUpdateSignature({ ...base, expandedBody: "Working\nGoal 41% · ~2m left" })
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

  // The live notification shrinks back to the lone-run view; nothing is cancelled.
  assert.deepEqual(native.stoppedRuns, []);
  assert.equal(native.posted.at(-1)?.title, "Agent run");
  assert.equal(native.posted.at(-1)?.runKey, LIVE_A);
  assert.deepEqual(controller.getTrackedConversationIds(), ["b"]);
});

test("updateAll removes the live notification once every run is gone", async () => {
  const native = new FakeNative();
  const controller = new LiveUpdateController(native);

  await controller.updateAll([projection({ conversationId: "a", startedAt: 10 })]);
  await controller.updateAll([]);

  assert.deepEqual(native.stoppedRuns, [LIVE_A]);
  assert.equal(controller.getLiveRunKey(), null);
});

test("updateAll cancels natively persisted notifications left over from a dead process", async () => {
  const native = new FakeNative();
  // A previous app process persisted these ongoing notifications (one from an
  // older per-run build, one live batch); the foreground service restored
  // them, but this controller owns neither.
  native.persistedRunKeys = ["ghost:123", getLiveBatchRunKey("old:1"), LIVE_A];
  const controller = new LiveUpdateController(native);

  await controller.updateAll([projection({ conversationId: "a", startedAt: 10 })]);

  // The current live notification survives; the leftovers are stopped.
  assert.deepEqual(native.stoppedRuns, ["ghost:123", getLiveBatchRunKey("old:1")]);
  assert.deepEqual(controller.getTrackedConversationIds(), ["a"]);
});

test("removeConversation drops an agent from the live notification", async () => {
  const native = new FakeNative();
  const controller = new LiveUpdateController(native);

  await controller.update(projection({ conversationId: "a", startedAt: 10 }));
  await controller.update(projection({ conversationId: "b", startedAt: 20 }));
  await controller.removeConversation("a");
  assert.equal(native.posted.at(-1)?.title, "Agent run");
  assert.deepEqual(native.stoppedRuns, []);

  await controller.removeConversation("b");
  assert.deepEqual(native.stoppedRuns, [LIVE_A]);
  await controller.removeConversation("unknown");
  assert.deepEqual(native.stoppedRuns, [LIVE_A]);
});

test("the consolidated notification surfaces needs-input with the blocked run's conversation", async () => {
  const native = new FakeNative();
  const controller = new LiveUpdateController(native);

  await controller.update(projection({ conversationId: "a", startedAt: 10 }));
  await controller.update(projection({ conversationId: "b", startedAt: 20 }));
  await controller.update(
    projection({
      conversationId: "a",
      startedAt: 10,
      status: "awaiting_permission",
      pendingIntervention: "permission",
      phase: "needs_permission",
    })
  );

  const live = native.posted.at(-1);
  assert.equal(live?.runKey, LIVE_A);
  assert.equal(live?.alert, true);
  assert.equal(live?.intervention, "permission");
  assert.equal(live?.conversationId, "a");
  assert.equal(live?.shortText, "INPUT");
  assert.match(live?.body ?? "", /^1 needs input · /);
});

test("stop clears tracking and the live identity", async () => {
  const native = new FakeNative();
  const controller = new LiveUpdateController(native);

  await controller.update(projection({ conversationId: "a", startedAt: 10 }));
  await controller.stop();

  assert.equal(native.stoppedAll, 1);
  assert.equal(controller.getLiveRunKey(), null);
  assert.deepEqual(controller.getTrackedConversationIds(), []);
});

test("refreshStatus absorbs natively persisted display preferences", async () => {
  const native = new FakeNative();
  native.getPromotionStatus = async () => ({
    ...status(),
    displayPreferences: { eta: "always" },
  });
  const controller = new LiveUpdateController(native);

  await controller.refreshStatus();

  assert.deepEqual(controller.getDisplayPreferences(), { eta: "always" });
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
    phase: "needs_answer",
  });
  const completed = projection({ status: "completed", phase: "finished" });

  // First sight of an agent already waiting on the user must alert.
  assert.equal(computeLiveUpdateAlert(null, needsInput), true);
  assert.equal(computeLiveUpdateAlert(running, needsInput), true);
  assert.equal(computeLiveUpdateAlert(needsInput, needsInput), false);
  assert.equal(computeLiveUpdateAlert(running, running), false);
  assert.equal(computeLiveUpdateAlert(running, completed), true);
  assert.equal(computeLiveUpdateAlert(null, completed), false);
});
