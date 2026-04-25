import assert from "node:assert/strict";
import { describe, test } from "node:test";
import {
  countUserMessageEvents,
  expandSliceToMinUserTurns,
} from "../src/lib/agents/event-log-read.js";

function user(seq: number) {
  return {
    seq,
    eventId: `e${seq}`,
    conversationId: "c1",
    createdAt: seq,
    kind: "user_message" as const,
    messageId: `m${seq}`,
    content: "hi",
  };
}

function filler(seq: number) {
  return {
    seq,
    eventId: `e${seq}`,
    conversationId: "c1",
    createdAt: seq,
    kind: "system" as const,
    level: "info" as const,
    text: "…",
  };
}

describe("expandSliceToMinUserTurns", () => {
  test("extends backward when slice is event-capped below min user turns", () => {
    const all = [
      user(1),
      filler(2),
      user(3),
      filler(4),
      user(5),
      filler(6),
      user(7),
      filler(8),
    ];
    const slice = all.slice(-2);
    assert.equal(countUserMessageEvents(slice), 1);
    const expanded = expandSliceToMinUserTurns(all, slice, 3);
    assert.equal(countUserMessageEvents(expanded), 3);
    assert.equal(expanded[0]!.seq, 3);
    assert.equal(expanded[expanded.length - 1]!.seq, 8);
  });

  test("no-op when already enough user turns", () => {
    const all = [user(1), filler(2), user(3), filler(4), user(5), filler(6)];
    const slice = all.slice(-4);
    assert.ok(countUserMessageEvents(slice) >= 2);
    const expanded = expandSliceToMinUserTurns(all, slice, 2);
    assert.deepEqual(expanded, slice);
  });
});
