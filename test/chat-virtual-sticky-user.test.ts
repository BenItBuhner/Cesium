import assert from "node:assert/strict";
import test from "node:test";
import { findVirtualStickyUserTurn } from "../src/components/chat/MessageThreadContent";
import { buildMessageThreadSegments } from "../src/components/chat/message-thread-rows";
import type { ChatMessage } from "../src/lib/types";

const messages: ChatMessage[] = [
  { id: "u1", type: "user", content: "first user" },
  { id: "a1", type: "assistant", content: "first answer" },
  { id: "u2", type: "user", content: "second user" },
  { id: "a2", type: "assistant", content: "second answer" },
  { id: "u3", type: "user", content: "third user" },
  { id: "a3", type: "assistant", content: "third answer" },
];

const segments = buildMessageThreadSegments(messages);
const virtualItems = [
  { index: 0, start: 0, size: 420, end: 420 },
  { index: 1, start: 420, size: 500, end: 920 },
  { index: 2, start: 920, size: 400, end: 1320 },
];

test("virtual sticky user header follows the turn containing the top rail", () => {
  assert.equal(findVirtualStickyUserTurn(segments, virtualItems, 40, 10), 0);
  assert.equal(findVirtualStickyUserTurn(segments, virtualItems, 600, 10), 1);
  assert.equal(findVirtualStickyUserTurn(segments, virtualItems, 1050, 10), 2);
});

test("virtual sticky user header switches exactly when the next turn reaches the rail", () => {
  assert.equal(findVirtualStickyUserTurn(segments, virtualItems, 409, 10), 0);
  assert.equal(findVirtualStickyUserTurn(segments, virtualItems, 410, 10), 1);
});

test("virtual sticky user header is absent outside rendered turn bounds", () => {
  assert.equal(findVirtualStickyUserTurn(segments, [], 600, 10), null);
  assert.equal(findVirtualStickyUserTurn(segments, virtualItems, 1400, 10), null);
});
