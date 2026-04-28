import assert from "node:assert/strict";
import { test } from "node:test";

test("extractComposerUserMessageHistory returns newest-first raw content", async () => {
  const { extractComposerUserMessageHistory } = await import(
    "../src/lib/agent-chat.ts"
  );
  const base = { conversationId: "c1", eventId: "", createdAt: 0 };
  const events = [
    { ...base, seq: 1, eventId: "u1", kind: "user_message" as const, messageId: "m1", content: "hello" },
    { ...base, seq: 2, eventId: "a1", kind: "assistant_message_chunk" as const, messageId: "a1", text: "hi" },
    { ...base, seq: 3, eventId: "u2", kind: "user_message" as const, messageId: "m2", content: "second" },
    { ...base, seq: 4, eventId: "u3", kind: "user_message" as const, messageId: "m3", content: "third" },
  ];
  const history = extractComposerUserMessageHistory(events);
  assert.deepEqual(history, ["third", "second", "hello"]);
});

test("extractComposerUserMessageHistory collapses consecutive duplicates", async () => {
  const { extractComposerUserMessageHistory } = await import(
    "../src/lib/agent-chat.ts"
  );
  const base = { conversationId: "c1", eventId: "", createdAt: 0 };
  const events = [
    { ...base, seq: 1, eventId: "u1", kind: "user_message" as const, messageId: "m1", content: "abc" },
    { ...base, seq: 2, eventId: "u2", kind: "user_message" as const, messageId: "m2", content: "abc" },
    { ...base, seq: 3, eventId: "u3", kind: "user_message" as const, messageId: "m3", content: "xyz" },
  ];
  const history = extractComposerUserMessageHistory(events);
  assert.deepEqual(history, ["xyz", "abc"]);
});

test("extractComposerUserMessageHistory skips blank content", async () => {
  const { extractComposerUserMessageHistory } = await import(
    "../src/lib/agent-chat.ts"
  );
  const base = { conversationId: "c1", eventId: "", createdAt: 0 };
  const events = [
    { ...base, seq: 1, eventId: "u1", kind: "user_message" as const, messageId: "m1", content: "keep" },
    { ...base, seq: 2, eventId: "u2", kind: "user_message" as const, messageId: "m2", content: "   " },
    { ...base, seq: 3, eventId: "u3", kind: "user_message" as const, messageId: "m3", content: "" },
  ];
  const history = extractComposerUserMessageHistory(events);
  assert.deepEqual(history, ["keep"]);
});

test("extractComposerUserMessageHistory tolerates out-of-order events", async () => {
  const { extractComposerUserMessageHistory } = await import(
    "../src/lib/agent-chat.ts"
  );
  const base = { conversationId: "c1", eventId: "", createdAt: 0 };
  const events = [
    { ...base, seq: 3, eventId: "u3", kind: "user_message" as const, messageId: "m3", content: "third" },
    { ...base, seq: 1, eventId: "u1", kind: "user_message" as const, messageId: "m1", content: "first" },
    { ...base, seq: 2, eventId: "u2", kind: "user_message" as const, messageId: "m2", content: "second" },
  ];
  const history = extractComposerUserMessageHistory(events);
  assert.deepEqual(history, ["third", "second", "first"]);
});
