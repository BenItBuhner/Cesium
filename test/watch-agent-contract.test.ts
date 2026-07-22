import assert from "node:assert/strict";
import { describe, test } from "node:test";
import type { MobileAgentProjection } from "../src/lib/mobile-agent-projection.ts";
import {
  availableWatchActions,
  toWatchAgentProjection,
  toWatchSyncEnvelope,
} from "../src/lib/watch-agent-contract.ts";

const baseProjection: MobileAgentProjection = {
  workspaceId: "workspace-1",
  conversationId: "conversation-1",
  title: "Implement Wear shell",
  status: "running",
  lastEventSeq: 12,
  currentActivity: "Building the watch client",
  currentTodoId: "todo-1",
  currentTodo: "Wire direct mode",
  pendingIntervention: null,
  startedAt: 1_000,
  updatedAt: 2_000,
  completedAt: null,
  elapsedMs: 25_000,
  lastError: null,
  todoProgress: null,
  goalProgress: null,
};

describe("watch agent contract", () => {
  test("maps mobile projection into stable watch projection", () => {
    const projection = toWatchAgentProjection(baseProjection, {
      source: "direct_server",
      now: 10_000,
    });

    assert.equal(projection.schemaVersion, 2);
    assert.equal(projection.chip, "RUN");
    assert.equal(projection.source, "direct_server");
    assert.equal(projection.staleAt, 55_000);
    assert.deepEqual(projection.availableActions, ["open", "pause", "cancel", "open_on_phone"]);
  });

  test("carries todo and Goal progress to Wear surfaces", () => {
    const todo = toWatchAgentProjection(
      {
        ...baseProjection,
        todoProgress: {
          total: 5,
          completed: 2,
          blocked: 0,
          pending: 2,
          inProgress: 1,
          currentIndex: 3,
          percent: 40,
          estimatedRemainingMs: 120_000,
          estimatedCompletionAt: 140_000,
        },
      },
      { source: "phone_companion" }
    );
    assert.equal(todo.progressKind, "todo");
    assert.equal(todo.progress, 2);
    assert.equal(todo.progressMax, 5);
    assert.equal(todo.progressLabel, "2/5");

    const burn = toWatchAgentProjection(
      {
        ...baseProjection,
        goalProgress: {
          percent: 68,
          headline: "Verification",
          runtimeMs: 60_000,
          estimatedRemainingMs: 30_000,
          estimatedCompletionAt: 90_000,
        },
      },
      { source: "phone_companion" }
    );
    assert.equal(burn.progressKind, "goal");
    assert.equal(burn.progress, 68);
    assert.equal(burn.progressLabel, "68%");
  });

  test("adds intervention actions for questions and permissions", () => {
    assert.deepEqual(
      availableWatchActions({
        status: "awaiting_question",
        pendingIntervention: "question",
      }),
      ["open", "answer_question", "pause", "cancel", "open_on_phone"]
    );
    assert.deepEqual(
      availableWatchActions({
        status: "awaiting_permission",
        pendingIntervention: "permission",
      }),
      ["open", "answer_permission", "pause", "cancel", "open_on_phone"]
    );
  });

  test("wraps latest projection in sync envelope", () => {
    const projection = toWatchAgentProjection(baseProjection, {
      source: "phone_companion",
      now: 20_000,
    });
    const envelope = toWatchSyncEnvelope({
      projection,
      source: "phone_companion",
      updatedAt: 21_000,
      server: {
        label: "This device",
        baseUrl: "http://10.0.2.2:9100",
      },
      focused: {
        workspaceId: "workspace-1",
        conversationId: "conversation-1",
        lastEventSeq: 12,
      },
    });

    assert.equal(envelope.schemaVersion, 2);
    assert.equal(envelope.projection?.conversationId, "conversation-1");
    assert.equal(envelope.server?.label, "This device");
    assert.equal(envelope.updatedAt, 21_000);
  });
});
