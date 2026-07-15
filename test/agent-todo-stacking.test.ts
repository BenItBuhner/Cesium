import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { projectAgentEventsToChatMessages } from "../src/lib/agent-chat.ts";
import type { AgentStoredEvent } from "../src/lib/agent-types.ts";

const base = { conversationId: "c1", createdAt: 0, eventId: "" };

describe("todo list stacking", () => {
  test("plan updates mutate the shared todo card without per-item todo-update rows", () => {
    const events: AgentStoredEvent[] = [
      {
        ...base,
        seq: 1,
        eventId: "u1",
        kind: "user_message",
        messageId: "m-user",
        content: "Clean up the repo",
      },
      {
        ...base,
        seq: 2,
        eventId: "p1",
        kind: "plan",
        planId: "plan-1",
        entries: [
          { id: "t1", content: "Explore workspace", status: "in_progress" },
          { id: "t2", content: "Remove files", status: "pending" },
        ],
      },
      {
        ...base,
        seq: 3,
        eventId: "p2",
        kind: "plan",
        planId: "plan-1",
        entries: [
          { id: "t1", content: "Explore workspace", status: "completed" },
          { id: "t2", content: "Remove files", status: "in_progress" },
        ],
      },
    ];

    const messages = projectAgentEventsToChatMessages(events, {
      backendId: "cesium-agent",
    });
    assert.equal(messages.some((message) => message.type === "todo-update"), false);
    const todoCards = messages.filter((message) => message.type === "todo");
    assert.equal(todoCards.length, 1);
    assert.equal(todoCards[0]?.todoLabel, "1 of 2 Done");
    assert.equal(todoCards[0]?.todos?.[1]?.status, "in_progress");
  });

  test("merges consecutive todo-only worked sessions around the checklist card", () => {
    const events: AgentStoredEvent[] = [
      {
        ...base,
        seq: 1,
        eventId: "u1",
        kind: "user_message",
        messageId: "m-user",
        content: "Clean up the repo",
      },
      {
        ...base,
        seq: 2,
        eventId: "tc1",
        kind: "tool_call",
        toolCallId: "todo-1",
        title: "Todo list",
        toolKind: "todo",
        status: "completed",
      },
      {
        ...base,
        seq: 3,
        eventId: "p1",
        kind: "plan",
        planId: "plan-1",
        entries: [{ id: "t1", content: "Explore workspace", status: "in_progress" }],
      },
      {
        ...base,
        seq: 4,
        eventId: "tc2",
        kind: "tool_call",
        toolCallId: "todo-2",
        title: "Todo list",
        toolKind: "todo",
        status: "completed",
      },
      {
        ...base,
        seq: 5,
        eventId: "p2",
        kind: "plan",
        planId: "plan-1",
        entries: [{ id: "t1", content: "Explore workspace", status: "completed" }],
      },
      {
        ...base,
        seq: 6,
        eventId: "idle",
        kind: "status",
        status: "idle",
      },
    ];

    const messages = projectAgentEventsToChatMessages(events, {
      backendId: "cesium-agent",
    });
    const workedSessions = messages.filter(
      (message) => message.type === "worked-session" && !message.loading
    );
    assert.equal(workedSessions.length, 1);
    assert.match(workedSessions[0]?.workedLabel ?? "", /updated todo list 2 times/i);
  });
});
