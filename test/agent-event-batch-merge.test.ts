import assert from "node:assert/strict";
import { test } from "node:test";
import type { AgentStoredEvent } from "../src/lib/agent-types.ts";
import {
  mergeAgentConversationEventBatch,
  mergeAgentConversationSnapshotHeadEvents,
} from "../src/components/chat/AgentConversationsContext.tsx";

function systemEvent(seq: number, eventId: string): AgentStoredEvent {
  return {
    seq,
    eventId,
    conversationId: "conv-1",
    createdAt: seq,
    kind: "system",
    level: "info",
    text: eventId,
  };
}

test("mergeAgentConversationEventBatch dedupes by seq and event id with Set lookups", () => {
  const existing = [systemEvent(1, "a"), systemEvent(3, "c")];

  const merged = mergeAgentConversationEventBatch(existing, [
    systemEvent(1, "dupe-seq"),
    systemEvent(2, "b"),
    systemEvent(4, "c"),
  ]);

  assert.deepEqual(
    merged.map((event) => [event.seq, event.eventId]),
    [
      [1, "a"],
      [2, "b"],
      [3, "c"],
    ]
  );
});

test("mergeAgentConversationEventBatch returns the original array when every event is duplicate", () => {
  const existing = [systemEvent(1, "a")];
  const merged = mergeAgentConversationEventBatch(existing, [
    systemEvent(1, "a"),
  ]);

  assert.equal(merged, existing);
});

test("stale prompt snapshot head preserves newer streamed assistant events", () => {
  const existing = [
    systemEvent(1, "user"),
    systemEvent(2, "assistant-chunk"),
    systemEvent(3, "assistant-end"),
    systemEvent(4, "idle"),
  ];
  const merged = mergeAgentConversationSnapshotHeadEvents(
    existing,
    [systemEvent(1, "prompt-ack-user")],
    { oldestSeq: 1, newestSeq: 1 }
  );

  assert.deepEqual(
    merged.map((event) => [event.seq, event.eventId]),
    [
      [1, "prompt-ack-user"],
      [2, "assistant-chunk"],
      [3, "assistant-end"],
      [4, "idle"],
    ]
  );
});
