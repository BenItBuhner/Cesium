import assert from "node:assert/strict";
import test from "node:test";
import type { MobileAgentProjection } from "@cesium/core";
import {
  MAX_GROUP_LINES,
  formatRuntime,
  toLiveUpdateGroupPayload,
  toLiveUpdatePayload,
} from "./liveUpdateProjection";

const baseProjection: MobileAgentProjection = {
  workspaceId: "workspace-1",
  conversationId: "conversation-1",
  title: "Ship Android agent mode",
  status: "running",
  lastEventSeq: 4,
  currentActivity: "Editing liveUpdateProjection.ts",
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
  phase: "editing",
  editStats: null,
  summary: null,
  pullRequestUrl: null,
};

const todoProjection: MobileAgentProjection = {
  ...baseProjection,
  currentActivity: "Implement notifications",
  currentTodoId: "todo-2",
  currentTodo: "Implement notifications",
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

const goalProgress = {
  percent: 62,
  headline: "Goal verification",
  runtimeMs: 120_000,
  estimatedRemainingMs: 74_000,
  estimatedCompletionAt: 196_000,
};

test("a lone run lists activity, progress, and diffstat as separate lines", () => {
  const payload = toLiveUpdatePayload({
    ...todoProjection,
    editStats: { files: 4, additions: 120, deletions: 8 },
  });

  assert.equal(payload.title, "Ship Android agent mode");
  assert.equal(payload.body, "Implement notifications");
  // The todo text already owns the first line, so the progress line stays bare.
  assert.equal(
    payload.expandedBody,
    ["Implement notifications", "Task 2 of 4", "+120 −8 · 4 files"].join("\n")
  );
  assert.equal(payload.shortText, "1/4");
  assert.equal(payload.progress, 1);
  assert.equal(payload.progressMax, 4);
  assert.equal(payload.ongoing, true);
  assert.equal(payload.cancellable, true);
  assert.equal(payload.promote, true);
  assert.equal(payload.subText, undefined);
});

test("todo runs show progression without a time estimate by default", () => {
  const payload = toLiveUpdatePayload(todoProjection);

  // Todo estimates swing with per-task complexity; the "~Nm left" hint stays
  // off unless the user opts in.
  assert.equal(payload.expandedBody, "Implement notifications\nTask 2 of 4");
  assert.equal(
    toLiveUpdatePayload(todoProjection, { etaMode: "always" }).expandedBody,
    "Implement notifications\nTask 2 of 4 · ~3m left"
  );
});

test("goal runs lead with the activity and carry percent, headline, and ETA on the progress line", () => {
  const payload = toLiveUpdatePayload({ ...baseProjection, goalProgress });

  assert.equal(payload.body, "Editing liveUpdateProjection.ts");
  assert.equal(
    payload.expandedBody,
    "Editing liveUpdateProjection.ts\nGoal 62% · Goal verification · ~2m left"
  );
  assert.equal(payload.shortText, "62%");
  assert.equal(payload.progress, 62);
  assert.equal(payload.progressMax, 100);

  assert.equal(
    toLiveUpdatePayload({ ...baseProjection, goalProgress }, { etaMode: "off" }).expandedBody,
    "Editing liveUpdateProjection.ts\nGoal 62% · Goal verification"
  );
});

test("goal progress outranks todo progress in the chip and bar", () => {
  const payload = toLiveUpdatePayload({ ...todoProjection, goalProgress });

  assert.equal(payload.shortText, "62%");
  assert.equal(payload.progress, 62);
  assert.equal(payload.progressMax, 100);
  assert.equal(
    payload.expandedBody,
    "Implement notifications\nGoal 62% · Goal verification · ~2m left"
  );
});

test("a run without structured progress has no bar and a chronometer chip", () => {
  const payload = toLiveUpdatePayload(baseProjection);

  assert.equal(payload.expandedBody, "Editing liveUpdateProjection.ts");
  assert.equal(payload.shortText, null);
  assert.equal(payload.progress, undefined);
  assert.equal(payload.progressMax, undefined);
  assert.equal(payload.ongoing, true);
});

test("pending interventions own the first line, the chip, and drop the ETA", () => {
  const payload = toLiveUpdatePayload({
    ...todoProjection,
    status: "awaiting_question",
    pendingIntervention: "question",
    pendingQuestionId: "question-7",
    currentActivity: "Which area of the Model-Proxy monorepo should this land in?",
    phase: "needs_answer",
  });

  assert.equal(payload.body, "Which area of the Model-Proxy monorepo should this land in?");
  // The todo label returns on the progress line now that the question owns line one.
  assert.equal(
    payload.expandedBody,
    [
      "Which area of the Model-Proxy monorepo should this land in?",
      "Task 2 of 4 · Implement notifications",
    ].join("\n")
  );
  assert.equal(payload.shortText, "INPUT");
  assert.equal(payload.questionId, "question-7");
  assert.equal(payload.permissionRequestId, null);
  assert.equal(
    toLiveUpdatePayload(
      {
        ...baseProjection,
        goalProgress,
        status: "awaiting_permission",
        pendingIntervention: "permission",
        currentActivity: "Allow terminal command?",
        phase: "needs_permission",
      },
      { etaMode: "always" }
    ).expandedBody,
    // No "~Nm left" suffix: the clock is not running while the agent waits.
    "Allow terminal command?\nGoal 62% · Goal verification"
  );
});

test("permission quick-action ids ride along while the run is blocked", () => {
  const payload = toLiveUpdatePayload({
    ...todoProjection,
    status: "awaiting_permission",
    pendingIntervention: "permission",
    pendingPermissionRequestId: "req-1",
    pendingPermissionAllowOptionId: "opt-allow",
    pendingPermissionDenyOptionId: "opt-deny",
    phase: "needs_permission",
  });

  assert.equal(payload.permissionRequestId, "req-1");
  assert.equal(payload.permissionAllowOptionId, "opt-allow");
  assert.equal(payload.permissionDenyOptionId, "opt-deny");
  assert.equal(payload.questionId, null);
});

test("the pinned start overrides the projection's own start", () => {
  const payload = toLiveUpdatePayload(baseProjection, { startedAt: 500 });
  assert.equal(payload.startedAt, 500);
  assert.equal(toLiveUpdatePayload(baseProjection).startedAt, 1_000);
});

test("finished runs post a completion card with diffstat, runtime, and the reply excerpt", () => {
  const payload = toLiveUpdatePayload(
    {
      ...baseProjection,
      status: "completed",
      completedAt: 1_044_000,
      goalProgress: { ...goalProgress, percent: 100 },
      editStats: { files: 11, additions: 609, deletions: 17 },
      summary:
        "v5 is on cursor/thirty-day-fast-track-v5-4dbe, stacked on v4/v3/v2 (none merged yet; merging v5 lands everything).",
      pullRequestUrl: "https://github.com/acme/app/pull/5",
      phase: "finished",
    },
    { startedAt: 1_000 }
  );

  assert.equal(payload.title, "Ship Android agent mode");
  assert.equal(payload.subText, "Finished");
  assert.equal(payload.shortText, "DONE");
  assert.equal(
    payload.body,
    "Goal complete (runtime 17m 23s). v5 is on cursor/thirty-day-fast-track-v5-4dbe, stacked on v4/v3/v2 (none merged yet; merging v5 lands everything)."
  );
  assert.equal(
    payload.expandedBody,
    [
      "+609 −17 · 11 files",
      "Goal complete (runtime 17m 23s). v5 is on cursor/thirty-day-fast-track-v5-4dbe, stacked on v4/v3/v2 (none merged yet; merging v5 lands everything).",
    ].join("\n")
  );
  assert.equal(payload.completedAt, 1_044_000);
  assert.equal(payload.startedAt, 1_000);
  assert.equal(payload.pullRequestUrl, "https://github.com/acme/app/pull/5");
  assert.equal(payload.ongoing, false);
  assert.equal(payload.cancellable, false);
  assert.equal(payload.promote, false);
  assert.equal(payload.progress, undefined);
});

test("terminal payloads never carry quick-action ids or stale activity text", () => {
  const payload = toLiveUpdatePayload({
    ...baseProjection,
    status: "completed",
    completedAt: 80_000,
    pendingIntervention: null,
    pendingPermissionRequestId: "req-stale",
    pendingPermissionAllowOptionId: "opt-stale",
    pendingQuestionId: "question-stale",
    phase: "finished",
  });

  assert.equal(payload.permissionRequestId, undefined);
  assert.equal(payload.permissionAllowOptionId, undefined);
  assert.equal(payload.questionId, undefined);
  assert.equal(payload.intervention, null);
  // Plain outcome without a reply excerpt; the in-run activity never leaks.
  assert.equal(payload.body, "Run complete (runtime 1m 19s).");
  assert.equal(payload.expandedBody, "Run complete (runtime 1m 19s).");
});

test("failed runs lead with the error text in the completion card", () => {
  const payload = toLiveUpdatePayload({
    ...baseProjection,
    status: "failed",
    completedAt: 31_000,
    lastError: "Provider responded with 401",
    phase: "failed",
  });
  assert.equal(payload.subText, "Failed");
  assert.equal(payload.shortText, "ERR");
  assert.equal(payload.body, "Run failed (runtime 30s). Provider responded with 401");
});

test("failed runs collapse multiline errors and never show raw JSON payloads", () => {
  const multiline = toLiveUpdatePayload({
    ...baseProjection,
    status: "failed",
    startedAt: null,
    lastError: "Provider responded with 500.\n" + `Request took too long: ${"x".repeat(200)}`,
    phase: "failed",
  });
  assert.ok(!multiline.body.includes("\n"));
  assert.ok(multiline.body.startsWith("Run failed. Provider responded with 500."));
  assert.ok(multiline.body.endsWith("…"));

  const json = toLiveUpdatePayload({
    ...baseProjection,
    status: "failed",
    startedAt: null,
    lastError: '{"error":{"message":"Compilation failed","status":500}}',
    phase: "failed",
  });
  assert.equal(json.body, "Run failed.");
});

test("cancelled and paused runs get their own status sub text", () => {
  const cancelled = toLiveUpdatePayload({
    ...baseProjection,
    status: "cancelled",
    startedAt: null,
    phase: "cancelled",
  });
  assert.equal(cancelled.subText, "Cancelled");
  assert.equal(cancelled.shortText, "STOP");
  assert.equal(cancelled.body, "Run cancelled.");

  const paused = toLiveUpdatePayload({
    ...baseProjection,
    status: "paused",
    startedAt: null,
    phase: "paused",
  });
  assert.equal(paused.subText, "Paused");
  assert.equal(paused.shortText, "PAUSE");
  assert.equal(paused.ongoing, false);
});

test("the consolidated notification lists every agent with its phase", () => {
  const payload = toLiveUpdateGroupPayload(
    [
      { projection: { ...baseProjection, conversationId: "a", title: "Star Trek Fable 5.1", phase: "writing", startedAt: 30 } },
      {
        projection: {
          ...baseProjection,
          conversationId: "b",
          title: "Generalized recursive fusion",
          phase: "starting",
          startedAt: 10,
        },
      },
      {
        projection: {
          ...todoProjection,
          conversationId: "c",
          title: "Market replay engine",
          phase: "finishing",
          startedAt: 20,
          todoProgress: { ...todoProjection.todoProgress!, completed: 3, currentIndex: 4 },
        },
      },
    ],
    "cesium-agents-live:b:10"
  );

  assert.equal(payload.runKey, "cesium-agents-live:b:10");
  assert.equal(payload.title, "3 agents running");
  // Collapsed: a roll-up by phase.
  assert.equal(payload.body, "1 finishing · 1 starting · 1 writing");
  // Expanded: one line per agent, oldest first, progress where known.
  assert.equal(
    payload.expandedBody,
    [
      "• Generalized recursive fusion · Starting",
      "• Market replay engine · Finishing · 3/4",
      "• Star Trek Fable 5.1 · Writing",
    ].join("\n")
  );
  // Elapsed anchors at the earliest running agent; no aggregate progress bar.
  assert.equal(payload.startedAt, 10);
  assert.equal(payload.shortText, null);
  assert.equal(payload.progress, undefined);
  assert.equal(payload.conversationId, null);
  assert.equal(payload.ongoing, true);
  assert.equal(payload.cancellable, false);
  assert.equal(payload.promote, true);
});

test("the consolidated notification surfaces the single blocked agent first with its quick actions", () => {
  const payload = toLiveUpdateGroupPayload(
    [
      { projection: { ...baseProjection, conversationId: "a", title: "Fix build", startedAt: 10 } },
      {
        projection: {
          ...baseProjection,
          conversationId: "b",
          title: "Write docs",
          startedAt: 20,
          status: "awaiting_permission",
          pendingIntervention: "permission",
          pendingPermissionRequestId: "req-1",
          pendingPermissionAllowOptionId: "allow",
          pendingPermissionDenyOptionId: "deny",
          phase: "needs_permission",
        },
        startedAt: 5,
      },
    ],
    "live"
  );

  assert.equal(payload.body, "1 needs input · 1 editing");
  assert.equal(
    payload.expandedBody,
    "• Write docs · Needs permission\n• Fix build · Editing"
  );
  assert.equal(payload.shortText, "INPUT");
  assert.equal(payload.conversationId, "b");
  assert.equal(payload.workspaceId, "workspace-1");
  assert.equal(payload.intervention, "permission");
  assert.equal(payload.permissionRequestId, "req-1");
  assert.equal(payload.permissionAllowOptionId, "allow");
  assert.equal(payload.permissionDenyOptionId, "deny");
  // The pinned start wins over the projection's own.
  assert.equal(payload.startedAt, 5);
});

test("two blocked agents make the quick actions ambiguous", () => {
  const blocked = (id: string): MobileAgentProjection => ({
    ...baseProjection,
    conversationId: id,
    status: "awaiting_question",
    pendingIntervention: "question",
    pendingQuestionId: `q-${id}`,
    phase: "needs_answer",
  });
  const payload = toLiveUpdateGroupPayload(
    [{ projection: blocked("a") }, { projection: blocked("b") }],
    "live"
  );

  assert.equal(payload.body, "2 need input");
  assert.equal(payload.intervention, "question");
  assert.equal(payload.conversationId, null);
  assert.equal(payload.questionId, null);
  assert.equal(payload.shortText, "INPUT");
});

test("the agent list folds past the line budget and clips long titles", () => {
  const runs = Array.from({ length: MAX_GROUP_LINES + 2 }, (_, index) => ({
    projection: {
      ...baseProjection,
      conversationId: `c${index}`,
      title:
        index === 0
          ? "A very long conversation title that keeps going well past the clip"
          : `Agent ${index}`,
      startedAt: index,
    },
  }));
  const payload = toLiveUpdateGroupPayload(runs, "live");
  const lines = payload.expandedBody?.split("\n") ?? [];

  assert.equal(payload.title, `${MAX_GROUP_LINES + 2} agents running`);
  assert.equal(lines.length, MAX_GROUP_LINES + 1);
  assert.equal(lines[0], "• A very long conversation title that… · Editing");
  assert.equal(lines.at(-1), "• +2 more");
  assert.equal(payload.body, `${MAX_GROUP_LINES + 2} editing`);
});

test("formatRuntime renders seconds, minutes, and hours", () => {
  assert.equal(formatRuntime(42_000), "42s");
  assert.equal(formatRuntime(17 * 60_000 + 23_000), "17m 23s");
  assert.equal(formatRuntime(62 * 60_000), "1h 02m");
  assert.equal(formatRuntime(-5), "0s");
});
