import assert from "node:assert/strict";
import { test } from "node:test";
import {
  PROJECT_HOME_ENGINE_ID,
  PROJECT_NOTICE_DISPLAY_PREFIX,
  diffProjectChildren,
  formatProjectNoticeDisplay,
  isProjectChildBusy,
  isProjectChildRemote,
  normalizeProjectAgentName,
  parseProjectNoticeNames,
  projectChildBucket,
  projectChildBucketLabel,
  projectChildChangeNotice,
  projectDeliveryLabel,
  projectSummaryStatusLine,
  sameProjectEngineUrl,
  sortProjectChildren,
  type ProjectChildSummary,
} from "../packages/core/src/projects.ts";

function child(overrides: Partial<ProjectChildSummary> & Pick<ProjectChildSummary, "id">): ProjectChildSummary {
  return {
    name: overrides.id,
    engineId: PROJECT_HOME_ENGINE_ID,
    engineLabel: "This engine",
    repoId: null,
    repoName: null,
    workspaceId: "ws",
    conversationId: `conv-${overrides.id}`,
    backendId: "cesium-agent",
    modelId: null,
    modelName: null,
    mode: "agent",
    status: "idle",
    bucket: "idle",
    queued: 0,
    turnsCompleted: 0,
    lastReplyPreview: null,
    lastError: null,
    attention: null,
    createdBy: "orchestrator",
    createdAt: 1,
    updatedAt: null,
    deletedAt: null,
    ...overrides,
  };
}

test("busy statuses cover every in-turn state and nothing else", () => {
  for (const status of [
    "running",
    "pause_requested",
    "pausing",
    "paused",
    "awaiting_permission",
    "awaiting_question",
  ]) {
    assert.equal(isProjectChildBusy(status), true, status);
  }
  for (const status of ["idle", "failed", "cancelled", "interrupted", "unknown"]) {
    assert.equal(isProjectChildBusy(status), false, status);
  }
});

test("child buckets group statuses the way the Project panel shows them", () => {
  assert.equal(projectChildBucket({ status: "awaiting_question" }), "needs_attention");
  assert.equal(projectChildBucket({ status: "awaiting_permission" }), "needs_attention");
  assert.equal(projectChildBucket({ status: "running" }), "working");
  assert.equal(projectChildBucket({ status: "paused" }), "working");
  assert.equal(projectChildBucket({ status: "failed" }), "failed");
  assert.equal(projectChildBucket({ status: "cancelled" }), "stopped");
  assert.equal(projectChildBucket({ status: "interrupted" }), "stopped");
  assert.equal(projectChildBucket({ status: "idle" }), "idle");
  assert.equal(projectChildBucket({ status: "unknown" }), "idle");
  assert.equal(projectChildBucket({ status: "running", deletedAt: 1 }), "deleted");
  assert.equal(projectChildBucketLabel("needs_attention"), "Needs you");
  assert.equal(projectChildBucketLabel("working"), "Working");
});

test("children sort attention first, then working, then by recent activity", () => {
  const sorted = sortProjectChildren([
    { name: "old-idle", bucket: "idle", updatedAt: 10, createdAt: 1 },
    { name: "worker", bucket: "working", updatedAt: 5, createdAt: 1 },
    { name: "new-idle", bucket: "idle", updatedAt: 20, createdAt: 1 },
    { name: "asker", bucket: "needs_attention", updatedAt: 1, createdAt: 1 },
    { name: "gone", bucket: "deleted", updatedAt: 99, createdAt: 1 },
    { name: "never-seen", bucket: "idle", updatedAt: null, createdAt: 15 },
  ]);
  assert.deepEqual(
    sorted.map((child) => child.name),
    ["asker", "worker", "new-idle", "never-seen", "old-idle", "gone"]
  );
});

test("notice display labels round-trip names and drop duplicates", () => {
  const display = formatProjectNoticeDisplay(["api", " web ", "api", ""]);
  assert.equal(display, `${PROJECT_NOTICE_DISPLAY_PREFIX}api, web`);
  assert.deepEqual(parseProjectNoticeNames(display), ["api", "web"]);
  assert.deepEqual(parseProjectNoticeNames("Steer: do it"), []);
  assert.deepEqual(parseProjectNoticeNames(null), []);
});

test("agent handles normalize to lowercase dash-separated names", () => {
  assert.equal(normalizeProjectAgentName("  API Refactor!! "), "api-refactor");
  assert.equal(normalizeProjectAgentName("docs_writer.v2"), "docs-writer-v2");
  assert.equal(normalizeProjectAgentName("***"), "");
  assert.equal(normalizeProjectAgentName("x".repeat(80)).length, 48);
});

test("the Project status line counts agents, work in progress and attention", () => {
  assert.equal(projectSummaryStatusLine({ agentCount: 0, workingCount: 0, attentionCount: 0 }), "No agents yet");
  assert.equal(projectSummaryStatusLine({ agentCount: 1, workingCount: 0, attentionCount: 0 }), "1 agent");
  assert.equal(
    projectSummaryStatusLine({ agentCount: 3, workingCount: 1, attentionCount: 1 }),
    "3 agents · 1 working · 1 needs you"
  );
  assert.equal(
    projectSummaryStatusLine({ agentCount: 4, workingCount: 0, attentionCount: 2 }),
    "4 agents · 2 need you"
  );
});

test("the first look at a Project is silent and later looks report finished turns and new attention", () => {
  const first = diffProjectChildren(undefined, [
    child({ id: "api", turnsCompleted: 2 }),
    child({ id: "web", status: "running", bucket: "working" }),
  ]);
  assert.deepEqual(first.changes, []);
  assert.deepEqual(first.marks.get("api"), { turnsCompleted: 2, bucket: "idle" });

  const second = diffProjectChildren(first.marks, [
    child({ id: "api", turnsCompleted: 4, lastReplyPreview: "Done" }),
    child({
      id: "web",
      status: "awaiting_question",
      bucket: "needs_attention",
      attention: { kind: "question", title: "Which port?" },
    }),
    child({ id: "fresh", turnsCompleted: 1 }),
    child({ id: "gone", turnsCompleted: 5, bucket: "deleted", deletedAt: 9 }),
  ]);
  assert.deepEqual(
    second.changes.map((change) => [change.kind, change.child.id, change.kind === "finished" ? change.turns : null]),
    [
      ["finished", "api", 2],
      ["attention", "web", null],
      ["finished", "fresh", 1],
    ]
  );

  const third = diffProjectChildren(second.marks, [
    child({ id: "web", status: "awaiting_question", bucket: "needs_attention" }),
  ]);
  assert.deepEqual(third.changes, [], "attention that is still pending does not re-announce");
});

test("change notices summarize replies, failures and requests for attention", () => {
  const finished = projectChildChangeNotice({
    kind: "finished",
    child: child({ id: "api", lastReplyPreview: "Tests   pass\nnow" }),
    turns: 1,
  });
  assert.deepEqual(finished, { title: "api finished", message: "Tests pass now", severity: "info" });

  const several = projectChildChangeNotice({ kind: "finished", child: child({ id: "api" }), turns: 3 });
  assert.equal(several.title, "api finished 3 turns");
  assert.equal(several.message, "Finished without a reply.");

  const failed = projectChildChangeNotice({
    kind: "finished",
    child: child({ id: "api", status: "failed", bucket: "failed", lastError: "Rate limited" }),
    turns: 1,
  });
  assert.deepEqual(failed, { title: "api failed", message: "Rate limited", severity: "error" });

  const asking = projectChildChangeNotice({
    kind: "attention",
    child: child({ id: "web", attention: { kind: "permission", title: "Run npm install?" } }),
  });
  assert.deepEqual(asking, { title: "web needs you", message: "Run npm install?", severity: "warning" });

  const long = projectChildChangeNotice({
    kind: "finished",
    child: child({ id: "api", lastReplyPreview: "x".repeat(400) }),
    turns: 1,
  });
  assert.equal(long.message.length, 220);
  assert.ok(long.message.endsWith("…"));
});

test("remote children, delivery labels and engine URL matching", () => {
  assert.equal(isProjectChildRemote({ engineId: PROJECT_HOME_ENGINE_ID }), false);
  assert.equal(isProjectChildRemote({ engineId: "eng_peer" }), true);

  assert.equal(projectDeliveryLabel("mid_turn"), "Steered into the running turn");
  assert.equal(projectDeliveryLabel("queued_steer"), "Runs right after the current turn");
  assert.equal(projectDeliveryLabel("queued"), "Queued as the next turn");
  assert.equal(projectDeliveryLabel("started"), "Started a new turn");

  assert.equal(sameProjectEngineUrl("http://LocalHost:9101/", "http://localhost:9101"), true);
  assert.equal(sameProjectEngineUrl("https://box.example:443", "https://box.example"), true);
  assert.equal(sameProjectEngineUrl("http://localhost:9101", "http://localhost:9100"), false);
  assert.equal(sameProjectEngineUrl(null, null), false);
  assert.equal(sameProjectEngineUrl("", ""), false);
});
