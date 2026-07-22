import assert from "node:assert/strict";
import { test } from "node:test";
import { goalProgressStatuses, latestGoalProgressStatus } from "../src/lib/agent-chat";
import type { AgentStoredEvent } from "../src/lib/agent-types";

test("latestGoalProgressStatus reads the latest completed Goal summarize tool event", () => {
  const events: AgentStoredEvent[] = [
    {
      seq: 1,
      eventId: "event-1",
      conversationId: "conversation-1",
      createdAt: 10,
      kind: "tool_call_update",
      toolCallId: "tool-1",
      status: "completed",
      raw: {
        request: {
          name: "goal_summarize",
          arguments: {
            progressPercent: 33,
            headline: "Initial Goal snapshot",
            summary: "## Progress\n- Started.",
          },
        },
      },
    },
    {
      seq: 2,
      eventId: "event-2",
      conversationId: "conversation-1",
      createdAt: 20,
      kind: "tool_call_update",
      toolCallId: "tool-2",
      status: "completed",
      raw: {
        request: {
          name: "goal_summarize_state",
          arguments: {
            progressPercent: 67.4,
            headline: "Goal verification underway",
            summary: "## Progress\n- Most implementation is done.",
          },
        },
      },
    },
  ];

  assert.deepEqual(latestGoalProgressStatus(events), {
    progressPercent: 67,
    headline: "Goal verification underway",
    summary: "## Progress\n- Most implementation is done.",
    updatedAt: 20,
    toolCallId: "tool-2",
    history: [
      {
        progressPercent: 33,
        headline: "Initial Goal snapshot",
        summary: "## Progress\n- Started.",
        updatedAt: 10,
        toolCallId: "tool-1",
      },
      {
        progressPercent: 67,
        headline: "Goal verification underway",
        summary: "## Progress\n- Most implementation is done.",
        updatedAt: 20,
        toolCallId: "tool-2",
      },
    ],
  });
  assert.equal(goalProgressStatuses(events).length, 2);
});

test("latestGoalProgressStatus ignores failed or unrelated tool events", () => {
  const events: AgentStoredEvent[] = [
    {
      seq: 1,
      eventId: "event-1",
      conversationId: "conversation-1",
      createdAt: 10,
      kind: "tool_call_update",
      toolCallId: "tool-1",
      status: "failed",
      raw: {
        request: {
          name: "goal_summarize_state",
          arguments: { progressPercent: 50 },
        },
      },
    },
    {
      seq: 2,
      eventId: "event-2",
      conversationId: "conversation-1",
      createdAt: 20,
      kind: "tool_call_update",
      toolCallId: "tool-2",
      status: "completed",
      raw: {
        request: {
          name: "goal_set",
          arguments: { progressPercent: 99 },
        },
      },
    },
  ];

  assert.equal(latestGoalProgressStatus(events), null);
});

test("latestGoalProgressStatus marks progress completed after goal_complete", () => {
  const events: AgentStoredEvent[] = [
    {
      seq: 1,
      eventId: "summary-1",
      conversationId: "conversation-1",
      createdAt: 10,
      kind: "tool_call_update",
      toolCallId: "tool-summary",
      status: "completed",
      raw: {
        request: {
          name: "goal_summarize",
          arguments: {
            progressPercent: 100,
            headline: "Done",
            summary: "## Progress\n- Verified.",
          },
        },
      },
    },
    {
      seq: 2,
      eventId: "complete-1",
      conversationId: "conversation-1",
      createdAt: 20,
      kind: "tool_call_update",
      toolCallId: "tool-complete",
      status: "completed",
      raw: {
        request: {
          name: "goal_complete",
          arguments: {},
        },
      },
    },
  ];

  assert.equal(latestGoalProgressStatus(events)?.completedAt, 20);
});

test("latestGoalProgressStatus ignores completion before the latest progress snapshot", () => {
  const events: AgentStoredEvent[] = [
    {
      seq: 1,
      eventId: "complete-1",
      conversationId: "conversation-1",
      createdAt: 10,
      kind: "tool_call_update",
      toolCallId: "tool-complete",
      status: "completed",
      raw: {
        request: {
          name: "goal_complete",
          arguments: {},
        },
      },
    },
    {
      seq: 2,
      eventId: "summary-1",
      conversationId: "conversation-1",
      createdAt: 20,
      kind: "tool_call_update",
      toolCallId: "tool-summary",
      status: "completed",
      raw: {
        request: {
          name: "goal_summarize",
          arguments: {
            progressPercent: 25,
            headline: "New goal",
            summary: "## Progress\n- Restarted.",
          },
        },
      },
    },
  ];

  assert.equal(latestGoalProgressStatus(events)?.completedAt, undefined);
});

test("latestGoalProgressStatus tracks goal runtime only during running spans", () => {
  const events: AgentStoredEvent[] = [
    {
      seq: 1,
      eventId: "status-running-1",
      conversationId: "conversation-1",
      createdAt: 0,
      kind: "status",
      status: "running",
    },
    {
      seq: 2,
      eventId: "set-goal",
      conversationId: "conversation-1",
      createdAt: 60_000,
      kind: "tool_call_update",
      toolCallId: "tool-set",
      status: "completed",
      raw: {
        request: {
          name: "goal_set",
          arguments: { objective: "Ship the goal runtime footer" },
        },
      },
    },
    {
      seq: 3,
      eventId: "summary-1",
      conversationId: "conversation-1",
      createdAt: 120_000,
      kind: "tool_call_update",
      toolCallId: "tool-summary",
      status: "completed",
      raw: {
        request: {
          name: "goal_summarize",
          arguments: {
            progressPercent: 40,
            headline: "Footer underway",
            summary: "## Progress\n- Added runtime derivation.",
          },
        },
      },
    },
    {
      seq: 4,
      eventId: "status-idle",
      conversationId: "conversation-1",
      createdAt: 300_000,
      kind: "status",
      status: "idle",
    },
    {
      seq: 5,
      eventId: "status-running-2",
      conversationId: "conversation-1",
      createdAt: 420_000,
      kind: "status",
      status: "running",
    },
  ];

  const status = latestGoalProgressStatus(events, "running");

  assert.equal(status?.runtimeSeconds, 240);
  assert.equal(status?.runtimeActiveSince, 420_000);
});
