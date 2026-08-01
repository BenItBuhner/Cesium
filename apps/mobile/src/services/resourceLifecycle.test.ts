import assert from "node:assert/strict";
import test from "node:test";
import type { AgentStoredEvent } from "@cesium/core";
import { mergeEvents } from "./AgentStatusService";
import { BackgroundCoordinator } from "./BackgroundCoordinator";

test("background coordinator only keeps the native agent socket in background", () => {
  const enabledStates: boolean[] = [];
  let statusRefreshes = 0;
  const coordinator = new BackgroundCoordinator(
    {
      setConnectionEnabled(enabled) {
        enabledStates.push(enabled);
      },
    },
    {
      async refreshStatus() {
        statusRefreshes += 1;
        return liveUpdateStatus();
      },
    }
  );

  coordinator.setAppState("background");
  coordinator.setNetworkReachable(false);
  coordinator.setNetworkReachable(true);
  coordinator.setAppState("active");

  assert.deepEqual(enabledStates, [true, false, true, false]);
  assert.equal(statusRefreshes, 1);
});

test("agent event merge appends monotonic batches and replaces duplicate sequences", () => {
  const first = event(1, "first");
  const second = event(2, "second");
  const appended = mergeEvents([first], [second]);
  assert.deepEqual(appended, [first, second]);

  const replacement = event(1, "replacement");
  const merged = mergeEvents(appended, [replacement]);
  assert.deepEqual(merged, [replacement, second]);
});

function event(seq: number, eventId: string): AgentStoredEvent {
  return {
    seq,
    eventId,
    conversationId: "conversation",
    createdAt: seq,
    kind: "status",
    status: "running",
  };
}

function liveUpdateStatus() {
  return {
    sdkInt: 36,
    progressStyleSupported: true,
    canPostPromotedNotifications: true,
    notificationPermissionGranted: true,
    suppressedByDismissal: false,
    deliveryPreference: "nowbar" as const,
  };
}
