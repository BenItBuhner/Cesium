import assert from "node:assert/strict";
import { describe, test } from "node:test";
import {
  deriveMobileAgentProjection,
  findMobilePullRequestUrl,
  formatMobileEditStats,
  getMobileAgentPhaseLabel,
  getMobileNotificationChip,
  isMobileAgentRunActive,
  summarizeMobileAssistantReply,
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

  test("surfaces the pending question prompt verbatim", () => {
    const conversation = createConversation({
      status: "awaiting_question",
      lastEventSeq: 1,
      pendingQuestion: { questionId: "q1", requestedAt: 2000 },
    });
    const events: AgentStoredEvent[] = [
      {
        seq: 1,
        eventId: "q1",
        conversationId: "c1",
        createdAt: 2000,
        kind: "question",
        questionId: "q1",
        prompt: "Which area of the Model-Proxy monorepo should this land in?",
        options: [
          { id: "a", label: "packages/server" },
          { id: "b", label: "packages/contracts" },
        ],
        status: "pending",
      },
    ];

    const projection = deriveMobileAgentProjection(conversation, events, { now: 2500 });
    assert.equal(projection.pendingIntervention, "question");
    assert.equal(
      projection.currentActivity,
      "Which area of the Model-Proxy monorepo should this land in?"
    );
    assert.equal(getMobileNotificationChip(projection.status), "INPUT");
  });

  test("falls back to the first sub-question prompt, then a generic answer label", () => {
    const conversation = createConversation({
      status: "awaiting_question",
      lastEventSeq: 1,
      pendingQuestion: { questionId: "q2", requestedAt: 2000 },
    });
    const multiStep = deriveMobileAgentProjection(
      conversation,
      [
        {
          seq: 1,
          eventId: "q2",
          conversationId: "c1",
          createdAt: 2000,
          kind: "question",
          questionId: "q2",
          prompt: "  ",
          options: [],
          questions: [
            {
              id: "step-1",
              prompt: "Pick a storage driver",
              options: [{ id: "a", label: "legacy-json" }],
            },
          ],
          status: "pending",
        },
      ],
      { now: 2500 }
    );
    assert.equal(multiStep.currentActivity, "Pick a storage driver");

    // Question event outside the loaded window: keep the generic label.
    const noEvent = deriveMobileAgentProjection(conversation, [], { now: 2500 });
    assert.equal(noEvent.currentActivity, "Needs an answer");
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

describe("run phase, edit stats, and outcome", () => {
  const running = (): AgentConversationRecord =>
    createConversation({ status: "running", lastEventSeq: 9, updatedAt: 5000 });

  const statusEvent = (
    seq: number,
    status: AgentStoredEvent extends { kind: "status"; status: infer S } ? S : never,
    createdAt = seq * 1000
  ): AgentStoredEvent => ({
    seq,
    eventId: `status-${seq}`,
    conversationId: "c1",
    createdAt,
    kind: "status",
    status,
  });

  const editCall = (
    seq: number,
    toolCallId: string,
    path: string | undefined,
    addedLines: number,
    removedLines: number,
    status: "pending" | "in_progress" | "completed" | "failed" = "completed"
  ): AgentStoredEvent => ({
    seq,
    eventId: `edit-${seq}`,
    conversationId: "c1",
    createdAt: seq * 1000,
    kind: "tool_call",
    toolCallId,
    title: `Edit ${path ?? "file"}`,
    toolKind: "edit",
    status,
    editPreview: { path, source: "replace", addedLines, removedLines, lines: [] },
  });

  const chunk = (seq: number, messageId: string, text: string): AgentStoredEvent => ({
    seq,
    eventId: `chunk-${seq}`,
    conversationId: "c1",
    createdAt: seq * 1000,
    kind: "assistant_message_chunk",
    messageId,
    text,
  });

  test("a run with no activity yet is starting", () => {
    const projection = deriveMobileAgentProjection(
      running(),
      [
        {
          seq: 1,
          eventId: "u1",
          conversationId: "c1",
          createdAt: 1000,
          kind: "user_message",
          messageId: "m1",
          content: "Go",
        },
        statusEvent(2, "running"),
      ],
      { now: 3000 }
    );
    assert.equal(projection.phase, "starting");
    assert.equal(getMobileAgentPhaseLabel(projection.phase), "Starting");
    assert.equal(projection.editStats, null);
    assert.equal(projection.summary, null);
    assert.equal(projection.pullRequestUrl, null);
  });

  test("the phase follows the most recent activity event", () => {
    const base = [statusEvent(1, "running")];
    const editing = deriveMobileAgentProjection(
      running(),
      [...base, editCall(2, "call-1", "src/app.ts", 3, 1, "in_progress")],
      { now: 3000 }
    );
    assert.equal(editing.phase, "editing");

    const writing = deriveMobileAgentProjection(
      running(),
      [...base, editCall(2, "call-1", "src/app.ts", 3, 1), chunk(3, "m1", "Now I will")],
      { now: 4000 }
    );
    assert.equal(writing.phase, "writing");

    const thinking = deriveMobileAgentProjection(
      running(),
      [...base, editCall(2, "call-1", "src/app.ts", 3, 1)],
      { now: 3000 }
    );
    // Between tool calls the model is deciding its next step.
    assert.equal(thinking.phase, "thinking");

    const reading = deriveMobileAgentProjection(
      running(),
      [
        ...base,
        {
          seq: 2,
          eventId: "t2",
          conversationId: "c1",
          createdAt: 2000,
          kind: "tool_call",
          toolCallId: "call-2",
          title: "Read file",
          toolKind: "read",
          status: "pending",
        },
        // An update that omits the kind recovers it from the originating call.
        {
          seq: 3,
          eventId: "t3",
          conversationId: "c1",
          createdAt: 2500,
          kind: "tool_call_update",
          toolCallId: "call-2",
          status: "in_progress",
        },
      ],
      { now: 3000 }
    );
    assert.equal(reading.phase, "reading");

    const delegating = deriveMobileAgentProjection(
      running(),
      [
        ...base,
        {
          seq: 2,
          eventId: "sub",
          conversationId: "c1",
          createdAt: 2000,
          kind: "subagent",
          subagentId: "s1",
          title: "Explore",
          status: "running",
          transcript: [],
        },
      ],
      { now: 3000 }
    );
    assert.equal(delegating.phase, "delegating");
    assert.equal(getMobileAgentPhaseLabel(delegating.phase), "Delegating");
  });

  test("interventions, pausing, and terminal states outrank tool activity", () => {
    const needsPermission = deriveMobileAgentProjection(
      createConversation({
        status: "awaiting_permission",
        pendingPermission: { requestId: "perm", requestedAt: 2000, options: [] },
      }),
      [statusEvent(1, "running"), editCall(2, "call-1", "a.ts", 1, 0, "in_progress")],
      { now: 3000 }
    );
    assert.equal(needsPermission.phase, "needs_permission");
    assert.equal(getMobileAgentPhaseLabel(needsPermission.phase), "Needs permission");

    const needsAnswer = deriveMobileAgentProjection(
      createConversation({
        status: "awaiting_question",
        pendingQuestion: { questionId: "q1", requestedAt: 2000 },
      }),
      [],
      { now: 3000 }
    );
    assert.equal(needsAnswer.phase, "needs_answer");

    const pausing = deriveMobileAgentProjection(
      createConversation({ status: "pausing" }),
      [statusEvent(1, "running"), chunk(2, "m1", "text")],
      { now: 3000 }
    );
    assert.equal(pausing.phase, "pausing");

    const finished = deriveMobileAgentProjection(
      createConversation({ status: "idle", updatedAt: 5000 }),
      [statusEvent(1, "running"), chunk(2, "m1", "Done."), statusEvent(3, "idle")],
      { now: 6000 }
    );
    assert.equal(finished.status, "completed");
    assert.equal(finished.phase, "finished");

    const failed = deriveMobileAgentProjection(
      createConversation({ status: "failed", lastError: "boom" }),
      [],
      { now: 6000 }
    );
    assert.equal(failed.phase, "failed");
  });

  test("the last open todo marks the run as finishing", () => {
    const projection = deriveMobileAgentProjection(
      running(),
      [
        statusEvent(1, "running"),
        {
          seq: 2,
          eventId: "p1",
          conversationId: "c1",
          createdAt: 2000,
          kind: "plan",
          planId: "plan",
          entries: [
            { id: "a", content: "Wire bridge", status: "completed" },
            { id: "b", content: "Update tests", status: "completed" },
            { id: "c", content: "Write changelog", status: "in_progress" },
          ],
        },
        editCall(3, "call-1", "CHANGELOG.md", 4, 0, "in_progress"),
      ],
      { now: 4000 }
    );
    assert.equal(projection.phase, "finishing");
    assert.equal(getMobileAgentPhaseLabel(projection.phase), "Finishing");
  });

  test("a goal past ninety percent is finishing", () => {
    const projection = deriveMobileAgentProjection(
      running(),
      [
        statusEvent(1, "running", 0),
        {
          seq: 2,
          eventId: "goal-set",
          conversationId: "c1",
          createdAt: 10_000,
          kind: "tool_call_update",
          toolCallId: "goal-set",
          status: "completed",
          raw: { request: { name: "goal_set", arguments: { objective: "Ship it" } } },
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
              arguments: { progressPercent: 92, headline: "Final verification" },
            },
          },
        },
        editCall(4, "call-1", "src/app.ts", 2, 2, "in_progress"),
      ],
      { now: 70_000 }
    );
    assert.equal(projection.goalProgress?.percent, 92);
    assert.equal(projection.phase, "finishing");
  });

  test("edit stats sum each tool call's latest preview across distinct files", () => {
    const projection = deriveMobileAgentProjection(
      running(),
      [
        statusEvent(1, "running"),
        editCall(2, "call-1", "src/app.ts", 10, 2, "pending"),
        // The completed update for the same call supersedes the pending preview.
        {
          seq: 3,
          eventId: "edit-3",
          conversationId: "c1",
          createdAt: 3000,
          kind: "tool_call_update",
          toolCallId: "call-1",
          status: "completed",
          editPreview: {
            path: "src/app.ts",
            source: "replace",
            addedLines: 12,
            removedLines: 3,
            lines: [],
          },
        },
        // Same file again: lines add up, the file counts once.
        editCall(4, "call-2", "file://src/app.ts", 5, 1),
        editCall(5, "call-3", "README.md", 20, 0),
        // Failed edits never landed.
        editCall(6, "call-4", "broken.ts", 100, 100, "failed"),
        // A preview with no path still counts as one touched file.
        editCall(7, "call-5", undefined, 1, 1),
      ],
      { now: 8000 }
    );
    assert.deepEqual(projection.editStats, { files: 3, additions: 38, deletions: 5 });
    assert.equal(formatMobileEditStats(projection.editStats), "+38 −5 · 3 files");
  });

  test("edit stats and the phase are scoped to the current run", () => {
    const events: AgentStoredEvent[] = [
      statusEvent(1, "running"),
      editCall(2, "old-1", "old.ts", 50, 50),
      chunk(3, "m1", "First run done"),
      statusEvent(4, "idle"),
      {
        seq: 5,
        eventId: "u2",
        conversationId: "c1",
        createdAt: 5000,
        kind: "user_message",
        messageId: "m2",
        content: "Again",
      },
      statusEvent(6, "running"),
    ];
    const fresh = deriveMobileAgentProjection(running(), events, { now: 7000 });
    assert.equal(fresh.editStats, null);
    assert.equal(fresh.phase, "starting");

    const editing = deriveMobileAgentProjection(
      running(),
      [...events, editCall(7, "new-1", "new.ts", 4, 1, "in_progress")],
      { now: 8000 }
    );
    assert.deepEqual(editing.editStats, { files: 1, additions: 4, deletions: 1 });
    assert.equal(editing.phase, "editing");
  });

  test("terminal runs carry a clean excerpt of the final reply and its PR link", () => {
    const projection = deriveMobileAgentProjection(
      createConversation({ status: "idle", updatedAt: 9000 }),
      [
        statusEvent(1, "running"),
        chunk(2, "m1", "Let me look."),
        editCall(3, "call-1", "src/app.ts", 609, 17),
        chunk(4, "m2", "## Summary\n\n"),
        chunk(
          5,
          "m2",
          "Goal complete. v5 is on `cursor/thirty-day-fast-track-v5-4dbe`, stacked on **v4**; " +
            "see [the PR](https://github.com/acme/app/pull/41) and the base https://github.com/acme/app/pull/40.\n\n" +
            "```ts\nconst hidden = true;\n```\n"
        ),
        statusEvent(6, "idle"),
      ],
      { now: 10_000 }
    );
    assert.equal(projection.status, "completed");
    // The "## Summary" heading is dropped, not promoted to the excerpt.
    assert.equal(
      projection.summary,
      "Goal complete. v5 is on cursor/thirty-day-fast-track-v5-4dbe, stacked on v4; see the PR and the base https://github.com/acme/app/pull/40."
    );
    // The first link in the reply is the PR being announced; the base it
    // stacks on comes later.
    assert.equal(projection.pullRequestUrl, "https://github.com/acme/app/pull/41");
    assert.deepEqual(projection.editStats, { files: 1, additions: 609, deletions: 17 });
  });

  test("the outcome is only derived for terminal runs", () => {
    const projection = deriveMobileAgentProjection(
      running(),
      [
        statusEvent(1, "running"),
        chunk(2, "m1", "Opened https://github.com/acme/app/pull/7 for review."),
      ],
      { now: 3000 }
    );
    assert.equal(projection.summary, null);
    assert.equal(projection.pullRequestUrl, null);
  });

  test("a PR created by a tool outranks links mentioned in the reply", () => {
    const projection = deriveMobileAgentProjection(
      createConversation({ status: "idle", updatedAt: 9000 }),
      [
        statusEvent(1, "running"),
        {
          seq: 2,
          eventId: "pr-tool",
          conversationId: "c1",
          createdAt: 2000,
          kind: "tool_call_update",
          toolCallId: "pr-1",
          status: "completed",
          detail: '{"url":"https://gitlab.com/acme/app/-/merge_requests/12","state":"open"}',
        },
        chunk(
          3,
          "m1",
          "Opened the merge request on top of https://gitlab.com/acme/app/-/merge_requests/11."
        ),
        statusEvent(4, "idle"),
      ],
      { now: 10_000 }
    );
    assert.equal(
      projection.summary,
      "Opened the merge request on top of https://gitlab.com/acme/app/-/merge_requests/11."
    );
    assert.equal(projection.pullRequestUrl, "https://gitlab.com/acme/app/-/merge_requests/12");
  });

  test("long summaries are cut at a sentence boundary", () => {
    const sentence = "This first sentence explains the change in some detail so it is long enough.";
    const overflow =
      "The second sentence keeps going and going and going and going and going well past the one hundred and sixty character budget.";
    const summary = summarizeMobileAssistantReply(`${sentence} ${overflow}`);
    assert.equal(summary, sentence);
    // Without a usable boundary the excerpt is hard-truncated instead.
    const truncated = summarizeMobileAssistantReply(overflow.replace(/\./g, "").repeat(2));
    assert.ok(truncated != null && truncated.endsWith("…") && truncated.length <= 160);
    assert.equal(summarizeMobileAssistantReply("   \n\n  "), null);
    // Payload-shaped replies never become a summary.
    assert.equal(summarizeMobileAssistantReply('{"ok":true}'), null);
  });

  test("findMobilePullRequestUrl strips trailing punctuation and handles other forges", () => {
    assert.equal(
      findMobilePullRequestUrl("Done: https://bitbucket.org/acme/app/pull-requests/5."),
      "https://bitbucket.org/acme/app/pull-requests/5"
    );
    assert.equal(
      findMobilePullRequestUrl("(https://dev.azure.com/acme/app/_git/app/pullrequest/9)"),
      "https://dev.azure.com/acme/app/_git/app/pullrequest/9"
    );
    assert.equal(findMobilePullRequestUrl("https://github.com/acme/app/issues/3"), null);
    assert.equal(findMobilePullRequestUrl(null), null);
  });

  test("formatMobileEditStats pluralizes and hides empty stats", () => {
    assert.equal(
      formatMobileEditStats({ files: 1, additions: 4, deletions: 0 }),
      "+4 −0 · 1 file"
    );
    assert.equal(formatMobileEditStats(null), null);
    assert.equal(formatMobileEditStats({ files: 0, additions: 0, deletions: 0 }), null);
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
