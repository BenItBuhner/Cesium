import assert from "node:assert/strict";
import { test } from "node:test";
import {
  PROJECT_HOME_ENGINE_ID,
  PROJECT_NOTICE_DISPLAY_PREFIX,
  diffProjectChildren,
  formatProjectNoticeDisplay,
  isProjectChildBusy,
  isProjectChildRemote,
  mergeProjectListings,
  projectEngineName,
  projectListingEngineName,
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
  type ProjectSummary,
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

function summary(overrides: Partial<ProjectSummary> & Pick<ProjectSummary, "id">): ProjectSummary {
  return {
    name: overrides.id,
    icon: null,
    createdAt: 1,
    updatedAt: 1,
    archivedAt: null,
    orchestratorStatus: "idle",
    orchestratorConversationId: `conv-${overrides.id}`,
    orchestratorWorkspaceId: "ws",
    repoCount: 1,
    agentCount: 0,
    workingCount: 0,
    attentionCount: 0,
    turnsCompleted: 0,
    ...overrides,
  };
}

test("mergeProjectListings lists every engine's Projects, newest first, tagged with their engine", () => {
  const merged = mergeProjectListings(
    [],
    [
      {
        serverId: "home",
        serverLabel: "Home",
        projects: [summary({ id: "checkout", updatedAt: 30 }), summary({ id: "docs", updatedAt: 10 })],
      },
      { serverId: "box", serverLabel: "Build box", projects: [summary({ id: "infra", updatedAt: 20 })] },
    ]
  );
  assert.equal(merged.error, null);
  assert.deepEqual(
    merged.projects.map((project) => `${project.id}@${project.serverId}:${project.serverLabel}`),
    ["checkout@home:Home", "infra@box:Build box", "docs@home:Home"]
  );
});

test("mergeProjectListings keeps a failed engine's last listing and drops engines it was not asked about", () => {
  const previous = mergeProjectListings(
    [],
    [
      { serverId: "home", serverLabel: "Home", projects: [summary({ id: "checkout", updatedAt: 5 })] },
      { serverId: "box", serverLabel: "Build box", projects: [summary({ id: "infra", updatedAt: 4 })] },
      { serverId: "laptop", serverLabel: "Laptop", projects: [summary({ id: "notes", updatedAt: 3 })] },
    ]
  ).projects;

  const merged = mergeProjectListings(previous, [
    { serverId: "box", serverLabel: "Build box", projects: [] },
    { serverId: "home", serverLabel: "Home (renamed)", projects: null, error: "fetch failed" },
  ]);
  assert.equal(merged.error, null, "one engine answered, so the blip stays quiet");
  assert.deepEqual(
    merged.projects.map((project) => `${project.id}@${project.serverId}:${project.serverLabel}`),
    ["checkout@home:Home (renamed)"]
  );
});

test("mergeProjectListings gives a duplicated id to the first engine and reports errors only when nobody answered", () => {
  const duplicated = mergeProjectListings(
    [],
    [
      { serverId: "active", serverLabel: "Active", projects: [summary({ id: "same", name: "From active" })] },
      { serverId: "alias", serverLabel: "Alias", projects: [summary({ id: "same", name: "From alias" })] },
    ]
  );
  assert.deepEqual(
    duplicated.projects.map((project) => `${project.name}@${project.serverId}`),
    ["From active@active"]
  );

  const failed = mergeProjectListings(
    [],
    [
      { serverId: "home", serverLabel: "Home", projects: null, error: "Projects is turned off." },
      { serverId: "box", serverLabel: "Build box", projects: null },
    ]
  );
  assert.deepEqual(failed, { projects: [], error: "Projects is turned off." });

  assert.deepEqual(
    mergeProjectListings([], [{ serverId: "box", serverLabel: "Build box", projects: null, error: " " }]),
    { projects: [], error: "Could not load Projects from Build box." }
  );
  assert.deepEqual(mergeProjectListings([], []), { projects: [], error: null });
});

test("projectEngineName names engines by label and adds the id only when a label is shared", () => {
  const engines = [
    { id: PROJECT_HOME_ENGINE_ID, label: "Home" },
    { id: "eng_9691e93c", label: " Build box " },
    { id: "eng_aaaa0001", label: "Laptop" },
    { id: "eng_aaaa0002", label: "laptop" },
    { id: "eng_blank000", label: "  " },
  ];
  assert.equal(projectEngineName(PROJECT_HOME_ENGINE_ID, engines), "Home");
  assert.equal(projectEngineName("eng_9691e93c", engines), "Build box");
  assert.equal(projectEngineName("eng_aaaa0001", engines), "Laptop (eng_aaaa0001)");
  assert.equal(projectEngineName("eng_aaaa0002", engines), "laptop (eng_aaaa0002)");
  assert.equal(projectEngineName("eng_blank000", engines), "eng_blank000", "a blank label falls back to the id");
  assert.equal(projectEngineName("eng_removed0", engines), "eng_removed0", "an engine no longer paired keeps its id");
});

test("projectListingEngineName prefers the engine's own name over the connection label", () => {
  const listed = mergeProjectListings(
    [],
    [
      {
        serverId: "srv-local",
        serverLabel: "localhost:9100",
        projects: [summary({ id: "checkout", engineLabel: "Home" }), summary({ id: "legacy" })],
      },
    ]
  ).projects;
  assert.deepEqual(
    listed.map((project) => projectListingEngineName(project)),
    ["Home", "localhost:9100"],
    "engines that predate engineLabel keep the connection label"
  );
  assert.equal(projectListingEngineName({ engineLabel: "  ", serverLabel: "Build box" }), "Build box");
});
