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
  pendingPermissionRequestId: null,
  pendingPermissionAllowOptionId: null,
  pendingPermissionDenyOptionId: null,
  pendingQuestionId: null,
  startedAt: 1_000,
  updatedAt: 2_000,
  completedAt: null,
  elapsedMs: 60_000,
  lastError: null,
  todoProgress: null,
  goalProgress: null,
};

const todoProjection = {
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
};

test("todo runs show progression without a time estimate by default", () => {
  const payload = toLiveUpdatePayload(todoProjection);

  assert.equal(payload.progressKind, "todo");
  assert.equal(payload.progress, 1);
  assert.equal(payload.progressMax, 4);
  assert.equal(payload.progressLabel, "1/4");
  assert.equal(payload.shortText, "1/4");
  // Todo estimates swing with per-task complexity; the time-estimate body
  // suffix stays off unless the user opts in, and the chip shows the
  // fraction plus the elapsed count-up chronometer either way.
  assert.equal(payload.estimatedCompletionAt, null);
  assert.equal(payload.estimatedRemainingSeconds, null);
  assert.equal(payload.body, "Implement notifications");
  assert.equal(payload.promote, true);
});

test("etaMode 'always' restores the todo time estimate", () => {
  const payload = toLiveUpdatePayload(todoProjection, { etaMode: "always" });

  assert.equal(payload.estimatedCompletionAt, 240_000);
  assert.equal(payload.estimatedRemainingSeconds, 180);
  assert.equal(payload.body, "Implement notifications · ~3m left");
});

test("etaMode 'off' strips the goal time estimate too", () => {
  const payload = toLiveUpdatePayload(
    {
      ...baseProjection,
      goalProgress: {
        percent: 62,
        headline: "Goal verification",
        runtimeMs: 120_000,
        estimatedRemainingMs: 74_000,
        estimatedCompletionAt: 196_000,
      },
    },
    { etaMode: "off" }
  );

  assert.equal(payload.estimatedCompletionAt, null);
  assert.equal(payload.estimatedRemainingSeconds, null);
  assert.equal(payload.body, "Goal verification");
});

test("pending intervention outranks the todo fraction in the chip", () => {
  const payload = toLiveUpdatePayload({
    ...todoProjection,
    status: "awaiting_permission",
    pendingIntervention: "permission",
  });

  assert.equal(payload.progressKind, "todo");
  assert.equal(payload.shortText, "INPUT");
  assert.equal(payload.progressLabel, "1/4");
});

test("permission quick-action ids ride along while the run is blocked", () => {
  const payload = toLiveUpdatePayload({
    ...todoProjection,
    status: "awaiting_permission",
    pendingIntervention: "permission",
    pendingPermissionRequestId: "req-1",
    pendingPermissionAllowOptionId: "opt-allow",
    pendingPermissionDenyOptionId: "opt-deny",
  });

  assert.equal(payload.permissionRequestId, "req-1");
  assert.equal(payload.permissionAllowOptionId, "opt-allow");
  assert.equal(payload.permissionDenyOptionId, "opt-deny");
  assert.equal(payload.questionId, null);
});

test("question id rides along while the run awaits an answer", () => {
  const payload = toLiveUpdatePayload({
    ...baseProjection,
    status: "awaiting_question",
    pendingIntervention: "question",
    pendingQuestionId: "question-7",
  });

  assert.equal(payload.questionId, "question-7");
  assert.equal(payload.permissionRequestId, null);
});

test("terminal payloads never carry quick-action ids", () => {
  const payload = toLiveUpdatePayload({
    ...baseProjection,
    status: "completed",
    pendingIntervention: null,
    pendingPermissionRequestId: "req-stale",
    pendingPermissionAllowOptionId: "opt-stale",
    pendingQuestionId: "question-stale",
  });

  assert.equal(payload.permissionRequestId, undefined);
  assert.equal(payload.permissionAllowOptionId, undefined);
  assert.equal(payload.questionId, undefined);
});

test("pending question text outranks the goal headline in the body", () => {
  const payload = toLiveUpdatePayload({
    ...baseProjection,
    status: "awaiting_question",
    pendingIntervention: "question",
    currentActivity: "Which area of the Model-Proxy monorepo should this land in?",
    goalProgress: {
      percent: 62,
      headline: "Goal verification",
      runtimeMs: 120_000,
      estimatedRemainingMs: 74_000,
      estimatedCompletionAt: 196_000,
    },
  });

  assert.equal(payload.progressKind, "goal");
  assert.equal(payload.shortText, "INPUT");
  // No "~Nm left" suffix: the clock is not running while the agent waits.
  assert.equal(
    payload.body,
    "Which area of the Model-Proxy monorepo should this land in?"
  );
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
  assert.equal(payload.shortText, "62%");
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
  // Stale in-run activity text must not leak into the final notification.
  assert.equal(payload.body, "Agent run completed");
  assert.equal(payload.promote, false);
  assert.equal(payload.ongoing, false);
  assert.equal(payload.cancellable, false);
});

test("failed runs surface the error text in the terminal body", () => {
  const payload = toLiveUpdatePayload({
    ...baseProjection,
    status: "failed",
    lastError: "Provider responded with 401",
  });
  assert.equal(payload.shortText, "ERR");
  assert.equal(payload.body, "Provider responded with 401");
});

test("failed runs collapse multiline errors into one bounded body line", () => {
  const payload = toLiveUpdatePayload({
    ...baseProjection,
    status: "failed",
    lastError:
      "Provider responded with 500.\n" +
      `Request took too long: ${"x".repeat(200)}`,
  });
  assert.equal(payload.shortText, "ERR");
  assert.ok(!payload.body.includes("\n"));
  assert.ok(payload.body.length <= 120);
  assert.ok(payload.body.startsWith("Provider responded with 500."));
  assert.ok(payload.body.endsWith("…"));
});

test("failed runs never show raw JSON error payloads", () => {
  const payload = toLiveUpdatePayload({
    ...baseProjection,
    status: "failed",
    lastError: '{"error":{"message":"Compilation failed","status":500}}',
  });
  assert.equal(payload.shortText, "ERR");
  assert.equal(payload.body, "Agent run failed");
});
