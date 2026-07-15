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
    assert.equal(projection.burnProgress, null);
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

  test("prioritizes Burn progress and estimates its completion", () => {
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
          eventId: "burn-set",
          conversationId: "c1",
          createdAt: 10_000,
          kind: "tool_call_update",
          toolCallId: "burn-set",
          status: "completed",
          raw: {
            request: {
              name: "burn_goal_set",
              arguments: { objective: "Ship native live updates" },
            },
          },
        },
        {
          seq: 3,
          eventId: "burn-progress",
          conversationId: "c1",
          createdAt: 40_000,
          kind: "tool_call_update",
          toolCallId: "burn-progress",
          status: "completed",
          raw: {
            request: {
              name: "burn_goal_summarize",
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

    assert.equal(projection.burnProgress?.percent, 40);
    assert.equal(projection.burnProgress?.headline, "Implementing notifications");
    assert.equal(projection.burnProgress?.runtimeMs, 60_000);
    assert.equal(projection.burnProgress?.estimatedRemainingMs, 90_000);
    assert.equal(projection.burnProgress?.estimatedCompletionAt, 160_000);
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
