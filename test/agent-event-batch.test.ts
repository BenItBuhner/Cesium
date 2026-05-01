import test from "node:test";
import assert from "node:assert/strict";
import { mergeIncomingEventBatch } from "../src/lib/agent-event-batch.ts";
import type { AgentStoredEvent } from "../src/lib/agent-types.ts";

function userEvent(seq: number, eventId = `e-${seq}`): AgentStoredEvent {
  return {
    kind: "user_message",
    conversationId: "c1",
    eventId,
    seq,
    createdAt: seq,
    messageId: `m-${seq}`,
    content: `message ${seq}`,
  } as AgentStoredEvent;
}

test("mergeIncomingEventBatch appends monotonic events without reordering", () => {
  const existing = [userEvent(1), userEvent(2)];
  const merged = mergeIncomingEventBatch(existing, [userEvent(3), userEvent(4)]);

  assert.deepEqual(
    merged?.map((event) => event.seq),
    [1, 2, 3, 4]
  );
});

test("mergeIncomingEventBatch ignores duplicate seqs and event ids", () => {
  const existing = [userEvent(1), userEvent(2, "dupe-id")];
  const merged = mergeIncomingEventBatch(existing, [
    userEvent(2),
    userEvent(3, "dupe-id"),
    userEvent(4),
  ]);

  assert.deepEqual(
    merged?.map((event) => event.seq),
    [1, 2, 4]
  );
});

test("mergeIncomingEventBatch sorts out-of-order accepted events", () => {
  const existing = [userEvent(5)];
  const merged = mergeIncomingEventBatch(existing, [userEvent(3), userEvent(7)]);

  assert.deepEqual(
    merged?.map((event) => event.seq),
    [3, 5, 7]
  );
});

test("mergeIncomingEventBatch returns null when nothing changes", () => {
  const existing = [userEvent(1)];
  assert.equal(mergeIncomingEventBatch(existing, [userEvent(1)]), null);
});
