import assert from "node:assert/strict";
import { test } from "node:test";
import {
  PROJECT_NOTICE_DISPLAY_PREFIX,
  formatProjectNoticeDisplay,
  isProjectChildBusy,
  normalizeProjectAgentName,
  parseProjectNoticeNames,
  projectChildBucket,
  projectChildBucketLabel,
  sortProjectChildren,
} from "../packages/core/src/projects.ts";

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
