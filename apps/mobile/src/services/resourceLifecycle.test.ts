import assert from "node:assert/strict";
import test from "node:test";
import type { AgentStoredEvent } from "@cesium/core";
import { AgentStatusService, mergeEvents } from "./AgentStatusService";
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

test("agent status tracks multiple conversations on one background socket", () => {
  const originalWebSocket = globalThis.WebSocket;
  FakeAgentWebSocket.instances = [];
  globalThis.WebSocket = FakeAgentWebSocket as unknown as typeof WebSocket;
  try {
    const service = new AgentStatusService({ onProjection() {} });
    service.setConnectionEnabled(true);
    service.updateConfig({
      serverBaseUrl: "http://localhost:9100",
      workspaceId: "workspace",
      conversationIds: ["first", "second"],
    });
    FakeAgentWebSocket.instances[0]?.open();

    assert.equal(FakeAgentWebSocket.instances.length, 1);
    assert.deepEqual(
      JSON.parse(FakeAgentWebSocket.instances[0]?.sent[0] ?? "{}"),
      {
        type: "subscribe",
        conversationIds: ["first", "second"],
        sinceByConversationId: { first: 0, second: 0 },
      }
    );

    // Changing the tracked set resubscribes on the same socket.
    service.updateConfig({
      serverBaseUrl: "http://localhost:9100",
      workspaceId: "workspace",
      conversationIds: ["second", "third"],
    });
    assert.equal(FakeAgentWebSocket.instances.length, 1);
    assert.deepEqual(
      JSON.parse(FakeAgentWebSocket.instances[0]?.sent[1] ?? "{}"),
      {
        type: "subscribe",
        conversationIds: ["second", "third"],
        sinceByConversationId: { second: 0, third: 0 },
      }
    );

    // Changing the server reconnects with a fresh socket.
    service.updateConfig({
      serverBaseUrl: "http://localhost:9200",
      workspaceId: "workspace",
      conversationIds: ["second", "third"],
    });
    FakeAgentWebSocket.instances[1]?.open();
    assert.equal(FakeAgentWebSocket.instances.length, 2);
    assert.deepEqual(
      JSON.parse(FakeAgentWebSocket.instances[1]?.sent[0] ?? "{}"),
      {
        type: "subscribe",
        conversationIds: ["second", "third"],
        sinceByConversationId: { second: 0, third: 0 },
      }
    );
    service.close();
  } finally {
    globalThis.WebSocket = originalWebSocket;
  }
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

class FakeAgentWebSocket {
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static readonly CLOSED = 3;
  static instances: FakeAgentWebSocket[] = [];

  readyState = FakeAgentWebSocket.CONNECTING;
  sent: string[] = [];
  onopen: (() => void) | null = null;
  onclose: (() => void) | null = null;
  onerror: (() => void) | null = null;
  onmessage: ((event: { data: string }) => void) | null = null;

  constructor(readonly url: string) {
    FakeAgentWebSocket.instances.push(this);
  }

  open() {
    this.readyState = FakeAgentWebSocket.OPEN;
    this.onopen?.();
  }

  send(data: string) {
    this.sent.push(data);
  }

  close() {
    this.readyState = FakeAgentWebSocket.CLOSED;
    this.onclose?.();
  }
}

function liveUpdateStatus() {
  return {
    sdkInt: 36,
    progressStyleSupported: true,
    canPostPromotedNotifications: true,
    notificationPermissionGranted: true,
    suppressedByDismissal: false,
    deliveryPreference: "live" as const,
  };
}
