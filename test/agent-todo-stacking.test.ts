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

  test("todo tool calls group into the same dropdown as later commands and thoughts", () => {
    const events: AgentStoredEvent[] = [
      {
        ...base,
        seq: 1,
        eventId: "u1",
        kind: "user_message",
        messageId: "m-user",
        content: "Inspect consumption patterns.",
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
        entries: [{ id: "t1", content: "Inspect consumption", status: "in_progress" }],
      },
      {
        ...base,
        seq: 4,
        eventId: "r1",
        kind: "reasoning",
        messageId: "a-1",
        text: "Need the proxy status and recent logs.",
      },
      {
        ...base,
        seq: 5,
        eventId: "term-1",
        kind: "tool_call",
        toolCallId: "term-1",
        title: "Run curl localhost:9100",
        toolKind: "terminal",
        status: "completed",
        raw: { id: "term-1", name: "terminal", arguments: { command: "curl localhost:9100" } },
      },
      {
        ...base,
        seq: 6,
        eventId: "r2",
        kind: "reasoning",
        messageId: "a-1",
        text: "Check the second listener next.",
      },
      {
        ...base,
        seq: 7,
        eventId: "term-2",
        kind: "tool_call",
        toolCallId: "term-2",
        title: "Run ss -lntp",
        toolKind: "terminal",
        status: "completed",
        raw: { id: "term-2", name: "terminal", arguments: { command: "ss -lntp" } },
      },
      {
        ...base,
        seq: 8,
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
    assert.equal(
      workedSessions.length,
      1,
      `expected one dropdown, got labels: ${workedSessions.map((w) => w.workedLabel).join(" | ")}`
    );
    assert.match(
      workedSessions[0]?.workedLabel ?? "",
      /updated todo list/i
    );
    assert.match(workedSessions[0]?.workedLabel ?? "", /ran 2 commands/i);
    assert.match(workedSessions[0]?.workedLabel ?? "", /2 thoughts/i);
    assert.equal(
      messages.some((message) => message.type === "todo"),
      true,
      "checklist card should still render separately"
    );
  });
});
