import assert from "node:assert/strict";
import test from "node:test";
import type { MobileAgentProjection } from "@cesium/core";
import { toLiveUpdatePayload } from "./liveUpdateProjection";

const baseProjection: MobileAgentProjection = {
  workspaceId: "workspace-1",
  conversationId: "conversation-1",
  title: "Ship Android agent mode",
  status: "running",
  lastEventSeq: 4,
  currentActivity: "Implement notifications",
  currentTodoId: null,
  currentTodo: null,
  pendingIntervention: null,
  startedAt: 1_000,
  updatedAt: 2_000,
  completedAt: null,
  elapsedMs: 60_000,
  lastError: null,
  todoProgress: null,
  goalProgress: null,
};

test("maps todo progress and estimated completion", () => {
  const payload = toLiveUpdatePayload({
    ...baseProjection,
    todoProgress: {
      total: 4,
      completed: 1,
      blocked: 0,
      pending: 2,
      inProgress: 1,
      currentIndex: 2,
      percent: 25,
      estimatedRemainingMs: 180_000,
      estimatedCompletionAt: 240_000,
    },
  });

  assert.equal(payload.progressKind, "todo");
  assert.equal(payload.progress, 1);
  assert.equal(payload.progressMax, 4);
  assert.equal(payload.progressLabel, "1/4");
  assert.equal(payload.estimatedCompletionAt, 240_000);
  assert.equal(payload.body, "Implement notifications · ~3m left");
  assert.equal(payload.promote, true);
});

test("prioritizes Goal percentage over todo progress", () => {
  const payload = toLiveUpdatePayload({
    ...baseProjection,
    todoProgress: {
      total: 2,
      completed: 1,
      blocked: 0,
      pending: 0,
      inProgress: 1,
      currentIndex: 2,
      percent: 50,
      estimatedRemainingMs: null,
      estimatedCompletionAt: null,
    },
    goalProgress: {
      percent: 62,
      headline: "Goal verification",
      runtimeMs: 120_000,
      estimatedRemainingMs: 74_000,
      estimatedCompletionAt: 196_000,
    },
  });

  assert.equal(payload.progressKind, "goal");
  assert.equal(payload.progress, 62);
  assert.equal(payload.progressMax, 100);
  assert.equal(payload.progressLabel, "62%");
  assert.equal(payload.body, "Goal verification · ~2m left");
});

test("uses an indeterminate Live Update before structured progress exists", () => {
  const payload = toLiveUpdatePayload(baseProjection);
  assert.equal(payload.progressKind, "indeterminate");
  assert.equal(payload.indeterminate, true);
  assert.equal(payload.shortText, null);
  assert.equal(payload.ongoing, true);
});

test("terminal states stop requesting promotion", () => {
  const payload = toLiveUpdatePayload({
    ...baseProjection,
    status: "completed",
    completedAt: 80_000,
  });
  assert.equal(payload.progressKind, "terminal");
  assert.equal(payload.progress, 100);
  assert.equal(payload.shortText, "DONE");
  assert.equal(payload.promote, false);
  assert.equal(payload.ongoing, false);
  assert.equal(payload.cancellable, false);
});
