import assert from "node:assert/strict";
import { test } from "node:test";

test("stripSpuriousAcpToolCallReplays drops replayed tool_call after a later user turn", async () => {
  const {
    stripSpuriousAcpToolCallReplays,
    projectAgentEventsToChatMessages,
    isIncomingEventDroppedByAcpToolStrip,
  } = await import("../src/lib/agent-chat.ts");
  const base = { conversationId: "c1", eventId: "", createdAt: 0 };
  const events = [
    {
      ...base,
      seq: 1,
      eventId: "u1",
      kind: "user_message" as const,
      messageId: "m1",
      content: "first",
    },
    {
      ...base,
      seq: 2,
      eventId: "t1a",
      kind: "tool_call" as const,
      toolCallId: "read-1",
      title: "Read file",
      toolKind: "read",
      status: "pending" as const,
    },
    {
      ...base,
      seq: 3,
      eventId: "t1b",
      kind: "tool_call_update" as const,
      toolCallId: "read-1",
      title: "Read file",
      toolKind: "read",
      status: "completed" as const,
    },
    {
      ...base,
      seq: 4,
      eventId: "u2",
      kind: "user_message" as const,
      messageId: "m2",
      content: "second",
    },
    {
      ...base,
      seq: 5,
      eventId: "t2-ghost",
      kind: "tool_call" as const,
      toolCallId: "read-1",
      title: "Read file",
      toolKind: "read",
      status: "in_progress" as const,
    },
  ];

  const filtered = stripSpuriousAcpToolCallReplays(events);
  const toolCallKinds = filtered.filter((e) => e.kind === "tool_call");
  assert.equal(toolCallKinds.length, 1);
  const prior = events.slice(0, 4);
  assert.equal(isIncomingEventDroppedByAcpToolStrip(prior, events[4]!), true);
  assert.equal(isIncomingEventDroppedByAcpToolStrip(prior, events[1]!), false);

  const messages = projectAgentEventsToChatMessages(events, {});
  const toolEntryCount = messages
    .flatMap((m) => (m.type === "worked-session" ? m.workedEntries ?? [] : []))
    .filter((e) => e.kind === "tool").length;
  assert.equal(toolEntryCount, 1);
});

test("stripSpuriousAcpToolCallReplays drops replayed plan (todo) after a later user turn", async () => {
  const {
    stripSpuriousAcpToolCallReplays,
    projectAgentEventsToChatMessages,
    isIncomingEventDroppedByAcpToolStrip,
  } = await import("../src/lib/agent-chat.ts");
  const base = { conversationId: "c1", eventId: "", createdAt: 0 };
  const entries = [
    {
      id: "s1",
      content: "Step one",
      status: "completed" as const,
    },
    {
      id: "s2",
      content: "Step two",
      status: "completed" as const,
    },
  ];
  const events = [
    {
      ...base,
      seq: 1,
      eventId: "u1",
      kind: "user_message" as const,
      messageId: "m1",
      content: "do the thing",
    },
    {
      ...base,
      seq: 2,
      eventId: "p1",
      kind: "plan" as const,
      planId: "c1-plan",
      entries,
    },
    {
      ...base,
      seq: 3,
      eventId: "u2",
      kind: "user_message" as const,
      messageId: "m2",
      content: "actually fix the UI",
    },
    {
      ...base,
      seq: 4,
      eventId: "p-ghost",
      kind: "plan" as const,
      planId: "c1-plan",
      entries,
    },
  ];

  const filtered = stripSpuriousAcpToolCallReplays(events);
  assert.equal(filtered.filter((e) => e.kind === "plan").length, 1);

  const prior = events.slice(0, 3);
  assert.equal(isIncomingEventDroppedByAcpToolStrip(prior, events[3]!), true);

  const messages = projectAgentEventsToChatMessages(events, {});
  const todoMessages = messages.filter((m) => m.type === "todo");
  assert.equal(todoMessages.length, 1);
});

test("genuine new tool_invocation in a later turn with different id is not stripped", async () => {
  const { stripSpuriousAcpToolCallReplays } = await import("../src/lib/agent-chat.ts");
  const base = { conversationId: "c1", eventId: "", createdAt: 0 };
  const events = [
    {
      ...base,
      seq: 1,
      eventId: "u1",
      kind: "user_message" as const,
      messageId: "m1",
      content: "a",
    },
    {
      ...base,
      seq: 2,
      eventId: "t1",
      kind: "tool_call" as const,
      toolCallId: "a",
      title: "Read",
      toolKind: "read",
      status: "pending" as const,
    },
    {
      ...base,
      seq: 3,
      eventId: "t1d",
      kind: "tool_call_update" as const,
      toolCallId: "a",
      title: "Read",
      toolKind: "read",
      status: "completed" as const,
    },
    {
      ...base,
      seq: 4,
      eventId: "u2",
      kind: "user_message" as const,
      messageId: "m2",
      content: "b",
    },
    {
      ...base,
      seq: 5,
      eventId: "t2",
      kind: "tool_call" as const,
      toolCallId: "b",
      title: "Grep",
      toolKind: "grep",
      status: "pending" as const,
    },
  ];
  const filtered = stripSpuriousAcpToolCallReplays(events);
  assert.equal(filtered.filter((e) => e.kind === "tool_call").length, 2);
});

test("stripSpuriousAcpToolCallReplays drops replayed tool_call_update after a later user turn (no replay tool_call)", async () => {
  const {
    stripSpuriousAcpToolCallReplays,
    projectAgentEventsToChatMessages,
    isIncomingEventDroppedByAcpToolStrip,
  } = await import("../src/lib/agent-chat.ts");
  const base = { conversationId: "c1", eventId: "", createdAt: 0 };
  const events = [
    {
      ...base,
      seq: 1,
      eventId: "u1",
      kind: "user_message" as const,
      messageId: "m1",
      content: "first",
    },
    {
      ...base,
      seq: 2,
      eventId: "t1a",
      kind: "tool_call" as const,
      toolCallId: "cmd-1",
      title: "Shell",
      toolKind: "terminal",
      status: "pending" as const,
    },
    {
      ...base,
      seq: 3,
      eventId: "t1b",
      kind: "tool_call_update" as const,
      toolCallId: "cmd-1",
      title: "Shell",
      toolKind: "terminal",
      status: "completed" as const,
    },
    {
      ...base,
      seq: 4,
      eventId: "u2",
      kind: "user_message" as const,
      messageId: "m2",
      content: "second",
    },
    {
      ...base,
      seq: 5,
      eventId: "t2-ghost-upd",
      kind: "tool_call_update" as const,
      toolCallId: "cmd-1",
      title: "Shell",
      toolKind: "terminal",
      status: "completed" as const,
    },
  ];

  const filtered = stripSpuriousAcpToolCallReplays(events);
  assert.equal(
    filtered.filter((e) => e.kind === "tool_call_update").length,
    1
  );
  const prior = events.slice(0, 4);
  assert.equal(isIncomingEventDroppedByAcpToolStrip(prior, events[4]!), true);

  const messages = projectAgentEventsToChatMessages(events, {});
  const toolEntryCount = messages
    .flatMap((m) => (m.type === "worked-session" ? m.workedEntries ?? [] : []))
    .filter((e) => e.kind === "tool").length;
  assert.equal(toolEntryCount, 1);
});

test("projectAgentEventsToChatMessages shows Ran for read tools without paths", async () => {
  const { projectAgentEventsToChatMessages } = await import("../src/lib/agent-chat.ts");
  const base = { conversationId: "c1", eventId: "", createdAt: 0 };
  const messages = projectAgentEventsToChatMessages(
    [
      {
        ...base,
        seq: 1,
        eventId: "u1",
        kind: "user_message" as const,
        messageId: "m1",
        content: "read something",
      },
      {
        ...base,
        seq: 2,
        eventId: "t1",
        kind: "tool_call" as const,
        toolCallId: "read-unknown",
        title: "Read file",
        toolKind: "read",
        status: "completed" as const,
      },
    ],
    {}
  );
  const tool = messages
    .flatMap((message) =>
      message.type === "worked-session" ? message.workedEntries ?? [] : []
    )
    .find((entry) => entry.kind === "tool");
  assert.ok(tool && tool.kind === "tool");
  assert.equal(tool.title, "Ran");
});
