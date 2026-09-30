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

test("goalProgressFromRecord builds the pill from the Goal record, not from tool arguments", async () => {
  const { goalProgressFromRecord, goalRecordRefreshKey } = await import("../src/lib/agent-chat");
  const events: AgentStoredEvent[] = [
    {
      seq: 1,
      eventId: "e1",
      conversationId: "c1",
      createdAt: 100,
      kind: "tool_call_update",
      toolCallId: "t1",
      status: "completed",
      raw: { request: { name: "goal_set", arguments: { objective: "Ship it" } } },
    },
  ];
  const noSnapshots = goalProgressFromRecord(
    {
      objective: "Ship it",
      status: "active",
      progressPercent: 50,
      headline: null,
      todosCompleted: 1,
      todosTotal: 2,
      tokenBudget: null,
      tokensUsed: 0,
      snapshots: [],
      updatedAt: 200,
      completedAt: null,
    },
    events,
    "idle"
  );
  assert.equal(noSnapshots.progressPercent, 50);
  assert.equal(noSnapshots.headline, "Ship it", "the objective stands in for a missing headline");
  assert.equal(noSnapshots.history.length, 1);

  const withSnapshots = goalProgressFromRecord(
    {
      objective: "Ship it",
      status: "complete",
      progressPercent: 100,
      headline: "Shipped",
      todosCompleted: 2,
      todosTotal: 2,
      tokenBudget: 10_000,
      tokensUsed: 4_000,
      snapshots: [
        { id: "s1", createdAt: 150, progressPercent: 40, summary: "## Progress\n- Half.", headline: "Halfway" },
        { id: "s2", createdAt: 190, progressPercent: 90, summary: "", headline: null },
      ],
      updatedAt: 210,
      completedAt: 205,
    },
    events,
    "idle"
  );
  assert.equal(withSnapshots.headline, "Shipped");
  assert.deepEqual(
    withSnapshots.history.map((item) => [item.toolCallId, item.progressPercent, item.summary]),
    [
      ["s1", 40, "## Progress\n- Half."],
      ["s2", 90, null],
    ]
  );
  assert.equal(withSnapshots.completedAt, 205);

  const before = goalRecordRefreshKey(events, "running");
  const after = goalRecordRefreshKey(
    [
      ...events,
      {
        seq: 2,
        eventId: "e2",
        conversationId: "c1",
        createdAt: 300,
        kind: "system",
        level: "info",
        text: "The Goal's token budget is spent.",
      } as AgentStoredEvent,
    ],
    "running"
  );
  assert.notEqual(before, after, "a runtime notice refreshes the record");
  assert.notEqual(before, goalRecordRefreshKey(events, "idle"), "a status change refreshes it too");
});
