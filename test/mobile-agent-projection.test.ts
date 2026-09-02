import assert from "node:assert/strict";
import { describe, test } from "node:test";
import {
  deriveMobileAgentProjection,
  getMobileNotificationChip,
  isMobileAgentRunActive,
} from "../src/lib/mobile-agent-projection.ts";
import type { AgentConversationRecord, AgentStoredEvent } from "../src/lib/agent-types.ts";

describe("mobile agent projection", () => {
  test("projects the active todo and running notification chip", () => {
    const conversation = createConversation({
      status: "running",
      lastEventSeq: 3,
      updatedAt: 3000,
    });
    const events: AgentStoredEvent[] = [
      {
        seq: 1,
        eventId: "u1",
        conversationId: "c1",
        createdAt: 1000,
        kind: "user_message",
        messageId: "m1",
        content: "Ship it",
      },
      {
        seq: 2,
        eventId: "s1",
        conversationId: "c1",
        createdAt: 1100,
        kind: "status",
        status: "running",
      },
      {
        seq: 3,
        eventId: "p1",
        conversationId: "c1",
        createdAt: 1200,
        kind: "plan",
        planId: "plan",
        entries: [
          { id: "todo-1", content: "Wire mobile bridge", status: "completed" },
          { id: "todo-2", content: "Update Live Update", status: "in_progress" },
        ],
      },
    ];

    const projection = deriveMobileAgentProjection(conversation, events, { now: 4000 });
    assert.equal(projection.currentTodoId, "todo-2");
    assert.equal(projection.currentActivity, "Update Live Update");
    assert.equal(projection.startedAt, 1100);
    assert.equal(projection.elapsedMs, 2900);
    assert.equal(isMobileAgentRunActive(projection.status), true);
    assert.equal(getMobileNotificationChip(projection.status), "RUN");
    assert.deepEqual(projection.todoProgress, {
      total: 2,
      completed: 1,
      blocked: 0,
      pending: 0,
      inProgress: 1,
      currentIndex: 2,
      percent: 50,
      estimatedRemainingMs: null,
      estimatedCompletionAt: null,
    });
    assert.equal(projection.goalProgress, null);
  });

  test("surfaces pending intervention over todo activity", () => {
    const conversation = createConversation({
      status: "awaiting_permission",
      pendingPermission: {
        requestId: "perm",
        requestedAt: 2000,
        title: "Allow terminal command?",
        options: [],
      },
    });
    const projection = deriveMobileAgentProjection(conversation, [], { now: 2500 });
    assert.equal(projection.pendingIntervention, "permission");
    assert.equal(projection.currentActivity, "Allow terminal command?");
    assert.equal(getMobileNotificationChip(projection.status), "INPUT");
  });

  test("projects blocked todo when no item is in progress", () => {
    const conversation = createConversation({
      status: "running",
      lastEventSeq: 1,
      updatedAt: 3000,
    });
    const events: AgentStoredEvent[] = [
      {
        seq: 1,
        eventId: "p1",
        conversationId: "c1",
        createdAt: 1200,
        kind: "plan",
        planId: "plan",
        entries: [
          { id: "todo-1", content: "Wait for credentials", status: "blocked" },
          { id: "todo-2", content: "Verify deploy", status: "pending" },
        ],
      },
    ];

    const projection = deriveMobileAgentProjection(conversation, events, { now: 4000 });
    assert.equal(projection.currentTodoId, "todo-1");
    assert.equal(projection.currentActivity, "Wait for credentials");
  });

  test("treats idle status event as completed for final notifications", () => {
    const conversation = createConversation({
      status: "idle",
      updatedAt: 5000,
      lastEventSeq: 2,
    });
    const projection = deriveMobileAgentProjection(
      conversation,
      [
        {
          seq: 2,
          eventId: "done",
          conversationId: "c1",
          createdAt: 5000,
          kind: "status",
          status: "idle",
        },
      ],
      { now: 6000 }
    );
    assert.equal(projection.status, "completed");
    assert.equal(projection.completedAt, 5000);
    assert.equal(getMobileNotificationChip(projection.status), "DONE");
  });

  test("preserves a run start through completion but resets it for the next turn", () => {
    const firstRunEvents: AgentStoredEvent[] = [
      {
        seq: 1,
        eventId: "first-running",
        conversationId: "c1",
        createdAt: 1_100,
        kind: "status",
        status: "running",
      },
    ];
    const firstRun = deriveMobileAgentProjection(
      createConversation({
        status: "running",
        updatedAt: 1_100,
        lastEventSeq: 1,
      }),
      firstRunEvents,
      { now: 1_500 }
    );
    const completedEvents: AgentStoredEvent[] = [
      ...firstRunEvents,
      {
        seq: 2,
        eventId: "first-idle",
        conversationId: "c1",
        createdAt: 2_000,
        kind: "status",
        status: "idle",
      },
    ];
    const completed = deriveMobileAgentProjection(
      createConversation({
        status: "idle",
        updatedAt: 2_000,
        lastEventSeq: 2,
      }),
      completedEvents,
      { now: 2_100, previous: firstRun }
    );
    const secondRunEvents: AgentStoredEvent[] = [
      ...completedEvents,
      {
        seq: 3,
        eventId: "second-user",
        conversationId: "c1",
        createdAt: 3_000,
        kind: "user_message",
        messageId: "second-message",
        content: "Run again",
      },
      {
        seq: 4,
        eventId: "second-running",
        conversationId: "c1",
        createdAt: 3_100,
        kind: "status",
        status: "running",
      },
    ];
    const secondRun = deriveMobileAgentProjection(
      createConversation({
        status: "running",
        updatedAt: 3_100,
        lastEventSeq: 4,
      }),
      secondRunEvents,
      { now: 3_500, previous: completed }
    );

    assert.equal(firstRun.startedAt, 1_100);
    assert.equal(completed.startedAt, 1_100);
    assert.equal(secondRun.startedAt, 3_100);
  });

  test("anchors a fresh derive to the current run, not the first run in the window", () => {
    // A reloaded client derives with no previous projection but a window that
    // spans several runs. The chronometer must anchor to the CURRENT run's
    // start (after the last terminal boundary), not a long-finished one.
    const events: AgentStoredEvent[] = [
      {
        seq: 1,
        eventId: "old-running",
        conversationId: "c1",
        createdAt: 10_000,
        kind: "status",
        status: "running",
      },
      {
        seq: 2,
        eventId: "old-idle",
        conversationId: "c1",
        createdAt: 20_000,
        kind: "status",
        status: "idle",
      },
      {
        seq: 3,
        eventId: "new-user",
        conversationId: "c1",
        createdAt: 500_000,
        kind: "user_message",
        messageId: "m2",
        content: "Again",
      },
      {
        seq: 4,
        eventId: "new-running",
        conversationId: "c1",
        createdAt: 500_100,
        kind: "status",
        status: "running",
      },
    ];
    const projection = deriveMobileAgentProjection(
      createConversation({ status: "running", updatedAt: 500_100, lastEventSeq: 4 }),
      events,
      { now: 500_500 }
    );
    assert.equal(projection.startedAt, 500_100);
    assert.equal(projection.elapsedMs, 400);
  });

  test("drops a stale previous start when a terminal boundary landed after it", () => {
    // The previous projection can be a pre-disconnect snapshot that still
    // says "running". If the caught-up events show that run ended and a new
    // one began, the old startedAt must not leak into the new run.
    const stalePrevious = deriveMobileAgentProjection(
      createConversation({ status: "running", updatedAt: 1_100, lastEventSeq: 1 }),
      [
        {
          seq: 1,
          eventId: "first-running",
          conversationId: "c1",
          createdAt: 1_100,
          kind: "status",
          status: "running",
        },
      ],
      { now: 1_500 }
    );
    const caughtUpEvents: AgentStoredEvent[] = [
      {
        seq: 1,
        eventId: "first-running",
        conversationId: "c1",
        createdAt: 1_100,
        kind: "status",
        status: "running",
      },
      {
        seq: 2,
        eventId: "first-idle",
        conversationId: "c1",
        createdAt: 2_000,
        kind: "status",
        status: "idle",
      },
      {
        seq: 3,
        eventId: "second-running",
        conversationId: "c1",
        createdAt: 900_000,
        kind: "status",
        status: "running",
      },
    ];
    const next = deriveMobileAgentProjection(
      createConversation({ status: "running", updatedAt: 900_000, lastEventSeq: 3 }),
      caughtUpEvents,
      { now: 900_400, previous: stalePrevious }
    );
    assert.equal(next.startedAt, 900_000);
    assert.equal(next.elapsedMs, 400);
  });

  test("uses the record update time when retrying a terminal run without new events", () => {
    const failed = deriveMobileAgentProjection(
      createConversation({
        status: "failed",
        updatedAt: 2_000,
        lastEventSeq: 2,
      }),
      [],
      { now: 2_100 }
    );
    const retry = deriveMobileAgentProjection(
      createConversation({
        status: "running",
        updatedAt: 4_000,
        lastEventSeq: 2,
      }),
      [],
      { now: 4_100, previous: { ...failed, startedAt: 1_100 } }
    );

    assert.equal(retry.startedAt, 4_000);
  });

  test("estimates todo completion after at least one completed item", () => {
    const conversation = createConversation({
      status: "running",
      lastEventSeq: 3,
      updatedAt: 1000,
    });
    const projection = deriveMobileAgentProjection(
      conversation,
      [
        {
          seq: 1,
          eventId: "started",
          conversationId: "c1",
          createdAt: 1000,
          kind: "status",
          status: "running",
        },
        {
          seq: 2,
          eventId: "plan",
          conversationId: "c1",
          createdAt: 2000,
          kind: "plan",
          planId: "plan",
          entries: [
            { id: "a", content: "One", status: "completed" },
            { id: "b", content: "Two", status: "in_progress" },
            { id: "c", content: "Three", status: "pending" },
            { id: "d", content: "Four", status: "pending" },
          ],
        },
      ],
      { now: 61_000 }
    );

    assert.equal(projection.todoProgress?.percent, 25);
    assert.equal(projection.todoProgress?.estimatedRemainingMs, 180_000);
    assert.equal(projection.todoProgress?.estimatedCompletionAt, 241_000);
  });

  test("prioritizes Goal progress and estimates its completion", () => {
    const conversation = createConversation({
      status: "running",
      lastEventSeq: 4,
      updatedAt: 1000,
    });
    const projection = deriveMobileAgentProjection(
      conversation,
      [
        {
          seq: 1,
          eventId: "started",
          conversationId: "c1",
          createdAt: 0,
          kind: "status",
          status: "running",
        },
        {
          seq: 2,
          eventId: "goal-set",
          conversationId: "c1",
          createdAt: 10_000,
          kind: "tool_call_update",
          toolCallId: "goal-set",
          status: "completed",
          raw: {
            request: {
              name: "goal_set",
              arguments: { objective: "Ship native live updates" },
            },
          },
        },
        {
          seq: 3,
          eventId: "goal-progress",
          conversationId: "c1",
          createdAt: 40_000,
          kind: "tool_call_update",
          toolCallId: "goal-progress",
          status: "completed",
          raw: {
            request: {
              name: "goal_summarize",
              arguments: {
                progressPercent: 40,
                headline: "Implementing notifications",
              },
            },
          },
        },
      ],
      { now: 70_000 }
    );

    assert.equal(projection.goalProgress?.percent, 40);
    assert.equal(projection.goalProgress?.headline, "Implementing notifications");
    assert.equal(projection.goalProgress?.runtimeMs, 60_000);
    assert.equal(projection.goalProgress?.estimatedRemainingMs, 90_000);
    assert.equal(projection.goalProgress?.estimatedCompletionAt, 160_000);
  });
});

describe("notification activity hygiene", () => {
  const LONG_COMMAND =
    'find / -name "bun" -type f -not -path "*/node_modules/*" 2>/dev/null | head -5; echo "---"; ls -la ~/.bun/bin';

  test("never surfaces raw tool-call JSON arguments as the activity", () => {
    const conversation = createConversation({
      status: "running",
      lastEventSeq: 1,
      updatedAt: 1000,
    });
    const projection = deriveMobileAgentProjection(
      conversation,
      [
        {
          seq: 1,
          eventId: "t1",
          conversationId: "c1",
          createdAt: 1000,
          kind: "tool_call",
          toolCallId: "call-1",
          title: `Run ${LONG_COMMAND}`,
          toolKind: "terminal",
          status: "in_progress",
          detail: `{"command":"${LONG_COMMAND}"}`,
        },
      ],
      { now: 2000 }
    );
    assert.equal(projection.currentActivity, "Running a terminal command");
  });

  test("keeps short clean tool titles verbatim", () => {
    const conversation = createConversation({
      status: "running",
      lastEventSeq: 1,
      updatedAt: 1000,
    });
    const projection = deriveMobileAgentProjection(
      conversation,
      [
        {
          seq: 1,
          eventId: "t1",
          conversationId: "c1",
          createdAt: 1000,
          kind: "tool_call",
          toolCallId: "call-1",
          title: "Read package.json",
          toolKind: "read",
          status: "in_progress",
          detail: '{"path":"package.json"}',
        },
      ],
      { now: 2000 }
    );
    assert.equal(projection.currentActivity, "Read package.json");
  });

  test("humanizes edits to the file basename when the title is oversized", () => {
    const longPath =
      "apps/mobile/src/services/deeply/nested/directories/LiveUpdateController.ts";
    const conversation = createConversation({
      status: "running",
      lastEventSeq: 1,
      updatedAt: 1000,
    });
    const projection = deriveMobileAgentProjection(
      conversation,
      [
        {
          seq: 1,
          eventId: "t1",
          conversationId: "c1",
          createdAt: 1000,
          kind: "tool_call",
          toolCallId: "call-1",
          title: `Edit ${longPath} and rewrite the reconciliation loop plus tests`,
          toolKind: "edit",
          status: "in_progress",
          locations: [{ path: longPath }],
        },
      ],
      { now: 2000 }
    );
    assert.equal(projection.currentActivity, "Editing LiveUpdateController.ts");
  });

  test("tool_call_update without descriptive fields inherits them from the originating call", () => {
    const conversation = createConversation({
      status: "running",
      lastEventSeq: 2,
      updatedAt: 1000,
    });
    const projection = deriveMobileAgentProjection(
      conversation,
      [
        {
          seq: 1,
          eventId: "t1",
          conversationId: "c1",
          createdAt: 1000,
          kind: "tool_call",
          toolCallId: "call-1",
          title: `Run ${LONG_COMMAND}`,
          toolKind: "terminal",
          status: "pending",
        },
        {
          seq: 2,
          eventId: "t2",
          conversationId: "c1",
          createdAt: 1100,
          kind: "tool_call_update",
          toolCallId: "call-1",
          status: "in_progress",
          detail: "chunk of raw stdout\nwith newlines",
        },
      ],
      { now: 2000 }
    );
    assert.equal(projection.currentActivity, "Running a terminal command");
  });

  test("skips verbose auto-accept status details instead of showing command soup", () => {
    const conversation = createConversation({
      status: "running",
      lastEventSeq: 2,
      updatedAt: 1000,
    });
    const projection = deriveMobileAgentProjection(
      conversation,
      [
        {
          seq: 1,
          eventId: "s1",
          conversationId: "c1",
          createdAt: 900,
          kind: "status",
          status: "running",
        },
        {
          seq: 2,
          eventId: "s2",
          conversationId: "c1",
          createdAt: 1000,
          kind: "status",
          status: "running",
          detail: `Auto-accepted Run ${LONG_COMMAND} (auto-accept all permissions).`,
        },
      ],
      { now: 2000 }
    );
    assert.equal(projection.currentActivity, "Agent is working");
  });

  test("keeps short clean status details", () => {
    const conversation = createConversation({
      status: "running",
      lastEventSeq: 1,
      updatedAt: 1000,
    });
    const projection = deriveMobileAgentProjection(
      conversation,
      [
        {
          seq: 1,
          eventId: "s1",
          conversationId: "c1",
          createdAt: 1000,
          kind: "status",
          status: "running",
          detail: "Auto-accepted Run npm test.",
        },
      ],
      { now: 2000 }
    );
    assert.equal(projection.currentActivity, "Auto-accepted Run npm test.");
  });

  test("falls back to a category label when a permission title is oversized", () => {
    const conversation = createConversation({
      status: "awaiting_permission",
      pendingPermission: {
        requestId: "perm",
        requestedAt: 2000,
        permission: "terminal",
        title: `Run ${LONG_COMMAND}`,
        detail: `{"command":"${LONG_COMMAND}"}`,
        options: [],
      },
    });
    const projection = deriveMobileAgentProjection(conversation, [], { now: 2500 });
    assert.equal(projection.currentActivity, "Wants to run a terminal command");
  });

  test("collapses multiline failure text to one bounded line", () => {
    const conversation = createConversation({
      status: "failed",
      lastError: "Provider responded with 401\n  at fetchCompletion (chat.ts:42)\n  at run (loop.ts:7)",
      updatedAt: 5000,
    });
    const projection = deriveMobileAgentProjection(conversation, [], { now: 6000 });
    assert.equal(
      projection.currentActivity,
      "Provider responded with 401 at fetchCompletion (chat.ts:42) at run (loop.ts:7)"
    );
  });

  test("replaces JSON-shaped failure payloads with a plain label", () => {
    const conversation = createConversation({
      status: "failed",
      lastError: '{"error":{"message":"Compilation failed","code":500}}',
      updatedAt: 5000,
    });
    const projection = deriveMobileAgentProjection(conversation, [], { now: 6000 });
    assert.equal(projection.currentActivity, "Agent run failed");
  });
});

function createConversation(
  overrides: Partial<AgentConversationRecord>
): AgentConversationRecord {
  return {
    schemaVersion: 1,
    id: "c1",
    workspaceId: "w1",
    title: "Mobile run",
    createdAt: 1000,
    updatedAt: 1000,
    lastEventSeq: 0,
    status: "idle",
    config: {
      backendId: "cesium-agent",
      mode: "agent",
      modelId: "m",
      modelName: "Model",
    },
    providerSessionId: null,
    configOptions: [],
    capabilities: {
      supportsLoadSession: true,
      supportsModeSelection: true,
      supportsModelSelection: true,
      supportsSlashCommands: true,
      supportsPermissions: true,
      supportsToolCalls: true,
      supportsStructuredPlans: true,
      supportsTodos: true,
      supportsSessionResume: true,
      supportsPromptImages: true,
      supportsInlineReasoning: true,
      supportsCompletionRetry: true,
    },
    pendingPermission: null,
    pendingQuestion: null,
    lastError: null,
    experimental: false,
    archivedAt: null,
    lastReadSeq: 0,
    queuedPrompts: [],
    ...overrides,
  };
}
