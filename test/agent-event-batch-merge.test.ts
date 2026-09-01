import assert from "node:assert/strict";
import { test } from "node:test";
import type { AgentStoredEvent } from "../src/lib/agent-types.ts";
import {
  compactAdjacentAgentMessageChunks,
  isSeqCoveredByEvents,
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

function chunkEvent(seq: number, text: string, messageId = "m1"): AgentStoredEvent {
  return {
    seq,
    eventId: `chunk-${seq}`,
    conversationId: "conv-1",
    createdAt: seq,
    kind: "assistant_message_chunk",
    messageId,
    text,
  };
}

function assistantText(events: AgentStoredEvent[]): string {
  return events
    .filter((event) => event.kind === "assistant_message_chunk")
    .map((event) => (event.kind === "assistant_message_chunk" ? event.text : ""))
    .join("");
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

test("compacted chunk rows record the seq range they cover", () => {
  const compacted = compactAdjacentAgentMessageChunks([
    chunkEvent(1, "a"),
    chunkEvent(2, "b"),
    chunkEvent(3, "c"),
  ]);
  assert.equal(compacted.length, 1);
  assert.equal(compacted[0]!.seq, 3);
  assert.equal(compacted[0]!.firstSeq, 1);
  assert.equal(compacted[0]!.kind === "assistant_message_chunk" && compacted[0]!.text, "abc");

  assert.equal(isSeqCoveredByEvents(compacted, 1), true);
  assert.equal(isSeqCoveredByEvents(compacted, 2), true);
  assert.equal(isSeqCoveredByEvents(compacted, 3), true);
  assert.equal(isSeqCoveredByEvents(compacted, 4), false);
  assert.equal(isSeqCoveredByEvents(compacted, 0), false);
});

test("recovery replay overlapping a compacted chunk row does not duplicate assistant text", () => {
  // Live stream delivered chunks 1..5, which the client compacted into one
  // row carrying seq 5. A gap-recovery replay (request_events_since 2)
  // re-delivers 3..5 plus the missing 6: only 6 may be inserted.
  const existing = mergeAgentConversationEventBatch(
    [],
    [
      chunkEvent(1, "the "),
      chunkEvent(2, "quick "),
      chunkEvent(3, "brown "),
      chunkEvent(4, "fox "),
      chunkEvent(5, "jumps "),
    ]
  );
  assert.equal(existing.length, 1);

  const merged = mergeAgentConversationEventBatch(existing, [
    chunkEvent(3, "brown "),
    chunkEvent(4, "fox "),
    chunkEvent(5, "jumps "),
    chunkEvent(6, "high"),
  ]);

  assert.equal(assistantText(merged), "the quick brown fox jumps high");
  assert.equal(merged.at(-1)!.seq, 6);
});

test("gap-fill replay inserts missing middle events in seq order", () => {
  // Frames 3..4 were dropped; 5 arrived live, then the delta replays 3..5.
  const existing = mergeAgentConversationEventBatch(
    [systemEvent(1, "one"), systemEvent(2, "two")],
    [systemEvent(5, "five")]
  );

  const merged = mergeAgentConversationEventBatch(existing, [
    systemEvent(3, "three"),
    systemEvent(4, "four"),
    systemEvent(5, "five-replayed"),
  ]);

  assert.deepEqual(
    merged.map((event) => [event.seq, event.eventId]),
    [
      [1, "one"],
      [2, "two"],
      [3, "three"],
      [4, "four"],
      [5, "five"],
    ]
  );
});

test("gap-fill replay around compacted chunks keeps the transcript intact", () => {
  // Chunks 1..2 streamed and compacted, 3..4 were lost, 5..6 streamed and
  // compacted separately. The recovery delta replays everything after 2.
  const beforeGap = mergeAgentConversationEventBatch(
    [],
    [chunkEvent(1, "alpha "), chunkEvent(2, "beta ")]
  );
  const withPostGap = mergeAgentConversationEventBatch(beforeGap, [
    chunkEvent(5, "epsilon "),
    chunkEvent(6, "zeta"),
  ]);
  assert.equal(assistantText(withPostGap), "alpha beta epsilon zeta");

  const healed = mergeAgentConversationEventBatch(withPostGap, [
    chunkEvent(3, "gamma "),
    chunkEvent(4, "delta "),
    chunkEvent(5, "epsilon "),
    chunkEvent(6, "zeta"),
  ]);

  assert.equal(assistantText(healed), "alpha beta gamma delta epsilon zeta");
});

test("snapshot head merge drops compacted rows overlapping the incoming window", () => {
  // Local log compacted chunks 2..4 into one row (seq 4). A fresh snapshot
  // head advertises window [2, 5] with raw rows; keeping the compacted row
  // would duplicate its text.
  const compactedLocal = mergeAgentConversationEventBatch(
    [systemEvent(1, "user")],
    [chunkEvent(2, "a"), chunkEvent(3, "b"), chunkEvent(4, "c")]
  );
  const merged = mergeAgentConversationSnapshotHeadEvents(
    compactedLocal,
    [chunkEvent(2, "a"), chunkEvent(3, "b"), chunkEvent(4, "c"), systemEvent(5, "idle")],
    { oldestSeq: 2, newestSeq: 5 }
  );

  assert.equal(assistantText(merged), "abc");
  assert.deepEqual(
    merged.map((event) => event.seq),
    [1, 2, 3, 4, 5]
  );
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
