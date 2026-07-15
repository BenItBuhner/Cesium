import assert from "node:assert/strict";
import test from "node:test";
import {
  extractFinalAssistantResponseForTurn,
  getSettledTurnContext,
  isSettledWorkIndex,
} from "../src/components/chat/turn-settle";
import type { ChatMessage } from "../src/lib/types";
import type { MessageThreadSegment } from "../src/components/chat/message-thread-rows";

test("getSettledTurnContext marks turn settled after assistant while not busy", () => {
  const messages: ChatMessage[] = [
    { id: "u1", type: "user", content: "go" },
    { id: "w1", type: "worked-session", workedLabel: "Read file", workedEntries: [] },
    { id: "a1", type: "assistant", content: "Done." },
  ];
  const segments: MessageThreadSegment[] = [
    {
      type: "turn",
      key: "turn-u1",
      stackOrder: 0,
      userKind: "user",
      userIndex: 0,
      tailIndices: [1, 2],
    },
  ];
  const context = getSettledTurnContext(segments, messages, false);
  assert.equal(context.settled, true);
  assert.equal(context.lastAssistantIndex, 2);
  assert.equal(isSettledWorkIndex(1, context), true);
  assert.equal(isSettledWorkIndex(2, context), false);
});

test("extractFinalAssistantResponseForTurn returns only the last assistant bubble", () => {
  const messages: ChatMessage[] = [
    { id: "u1", type: "user", content: "go" },
    { id: "a1", type: "assistant", content: "Working on it." },
    { id: "w1", type: "worked-session", workedLabel: "Read file", workedEntries: [] },
    { id: "a2", type: "assistant", content: "Here is the final answer." },
    { id: "u2", type: "user", content: "next" },
    { id: "a3", type: "assistant", content: "Another reply." },
  ];

  assert.equal(
    extractFinalAssistantResponseForTurn(messages, "u1"),
    "Here is the final answer."
  );
  assert.equal(
    extractFinalAssistantResponseForTurn(messages, "u2"),
    "Another reply."
  );
});

test("extractFinalAssistantResponseForTurn ignores empty final assistant bubbles", () => {
  const messages: ChatMessage[] = [
    { id: "u1", type: "user", content: "go" },
    { id: "a1", type: "assistant", content: "Partial" },
    { id: "a2", type: "assistant", content: "   " },
  ];

  assert.equal(extractFinalAssistantResponseForTurn(messages, "u1"), null);
});

test("getSettledTurnContext stays unsettled while conversation is busy", () => {
  const messages: ChatMessage[] = [
    { id: "u1", type: "user", content: "go" },
    { id: "w1", type: "worked-session", workedLabel: "Working", workedEntries: [] },
    { id: "a1", type: "assistant", content: "Partial" },
  ];
  const segments: MessageThreadSegment[] = [
    {
      type: "turn",
      key: "turn-u1",
      stackOrder: 0,
      userKind: "user",
      userIndex: 0,
      tailIndices: [1, 2],
    },
  ];
  const context = getSettledTurnContext(segments, messages, true);
  assert.equal(context.settled, false);
});
