import assert from "node:assert/strict";
import { describe, test } from "node:test";
import {
  agentRailConversationNeedsAttention,
  compareAgentRailByStatusPriority,
  formatAgentRailRelativeTime,
  getAgentRailPriorityBucket,
  getAgentRailStatusInfo,
  getAgentRailStatusKind,
  isAgentRailRowDetailMode,
} from "../src/lib/agent-rail-status";
import {
  defaultAgentRailFilterToggles,
  matchesAgentRailMultiFilter,
} from "../src/lib/agent-rail";
import type { AgentRailConversationSummary } from "../src/lib/agent-types";

function summary(
  overrides: Partial<AgentRailConversationSummary> = {}
): AgentRailConversationSummary {
  return {
    id: "c1",
    workspaceId: "ws1",
    title: "Fix login bug",
    createdAt: 1_000,
    updatedAt: 2_000,
    lastEventSeq: 5,
    status: "idle",
    archivedAt: null,
    backendId: "cesium-agent",
    mode: "agent",
    experimental: false,
    hasPendingPermission: false,
    ...overrides,
  };
}

describe("agent rail status", () => {
  test("pending permission outranks everything and carries its title", () => {
    const info = getAgentRailStatusInfo(
      summary({
        status: "awaiting_permission",
        hasPendingPermission: true,
        pendingPermissionTitle: "Run terminal command",
      })
    );
    assert.equal(info.kind, "permission");
    assert.equal(info.needsAttention, true);
    assert.equal(info.tone, "attention");
    assert.equal(info.description, "Needs approval · Run terminal command");
  });

  test("pending question is attention even when only the flag is set", () => {
    const info = getAgentRailStatusInfo(
      summary({ status: "running", hasPendingQuestion: true })
    );
    assert.equal(info.kind, "question");
    assert.equal(info.needsAttention, true);
    assert.equal(info.description, "Waiting for your answer");
  });

  test("failed conversations surface the error summary until they are read", () => {
    const info = getAgentRailStatusInfo(
      summary({ status: "failed", lastErrorSummary: "Provider timed out" })
    );
    assert.equal(info.kind, "failed");
    assert.equal(info.tone, "error");
    assert.equal(info.needsAttention, true);
    assert.equal(info.description, "Failed · Provider timed out");
    const read = getAgentRailStatusInfo(
      summary({ status: "failed", lastErrorSummary: "Provider timed out" }),
      { acknowledgedFailure: true }
    );
    assert.equal(read.kind, "idle");
    assert.equal(read.needsAttention, false);
    assert.equal(read.tone, "muted");
    assert.equal(read.description, null);
  });

  test("running / pausing / paused map to active or muted states", () => {
    assert.equal(getAgentRailStatusKind(summary({ status: "running" })), "running");
    assert.equal(getAgentRailStatusKind(summary({ status: "pause_requested" })), "pausing");
    assert.equal(getAgentRailStatusKind(summary({ status: "pausing" })), "pausing");
    assert.equal(getAgentRailStatusKind(summary({ status: "paused" })), "paused");
    assert.equal(getAgentRailStatusInfo(summary({ status: "running" })).description, "Working…");
    assert.equal(getAgentRailStatusInfo(summary({ status: "paused" })).tone, "muted");
  });

  test("unread completion becomes done_unread; read idle stays quiet", () => {
    const unread = getAgentRailStatusInfo(summary(), { unreadCompletion: true });
    assert.equal(unread.kind, "done_unread");
    assert.equal(unread.description, "Finished");
    const read = getAgentRailStatusInfo(summary());
    assert.equal(read.kind, "idle");
    assert.equal(read.description, null);
  });

  test("cancelled and interrupted settle without a callout", () => {
    for (const status of ["cancelled", "interrupted"] as const) {
      const info = getAgentRailStatusInfo(summary({ status }));
      assert.equal(info.kind, "stopped");
      assert.equal(info.description, null);
      assert.equal(info.needsAttention, false);
    }
  });

  test("priority ordering: permission > question > failed > running > recency", () => {
    const permission = summary({ id: "p", hasPendingPermission: true, updatedAt: 1 });
    const question = summary({ id: "q", status: "awaiting_question", updatedAt: 100 });
    const failed = summary({ id: "f", status: "failed", updatedAt: 100 });
    const runningOld = summary({ id: "r1", status: "running", updatedAt: 10 });
    const runningNew = summary({ id: "r2", status: "running", updatedAt: 90 });
    const ordered = [runningOld, failed, runningNew, question, permission].sort((a, b) =>
      compareAgentRailByStatusPriority(a, b)
    );
    assert.deepEqual(
      ordered.map((c) => c.id),
      ["p", "q", "f", "r2", "r1"]
    );
  });

  test("needs-attention predicate covers permissions, questions, and failures", () => {
    assert.equal(
      agentRailConversationNeedsAttention(summary({ hasPendingPermission: true })),
      true
    );
    assert.equal(
      agentRailConversationNeedsAttention(summary({ hasPendingQuestion: true })),
      true
    );
    assert.equal(
      agentRailConversationNeedsAttention(summary({ status: "awaiting_question" })),
      true
    );
    assert.equal(agentRailConversationNeedsAttention(summary({ status: "failed" })), true);
    assert.equal(
      agentRailConversationNeedsAttention(summary({ status: "failed" }), {
        acknowledgedFailure: true,
      }),
      false
    );
    assert.equal(agentRailConversationNeedsAttention(summary({ status: "running" })), false);
    assert.equal(agentRailConversationNeedsAttention(summary()), false);
  });

  test("needs_attention rail filter now matches questions and failures", () => {
    const toggles = { ...defaultAgentRailFilterToggles(), needs_attention: true };
    const ctx = {
      pinnedConversationIds: new Set<string>(),
      unreadCompletionByConversationId: undefined,
    };
    assert.equal(
      matchesAgentRailMultiFilter(summary({ status: "awaiting_question" }), toggles, ctx),
      true
    );
    assert.equal(
      matchesAgentRailMultiFilter(summary({ status: "failed" }), toggles, ctx),
      true
    );
    assert.equal(matchesAgentRailMultiFilter(summary(), toggles, ctx), false);
  });

  test("relative time formatting is compact", () => {
    const now = 1_000_000_000;
    assert.equal(formatAgentRailRelativeTime(now - 5_000, now), "just now");
    assert.equal(formatAgentRailRelativeTime(now - 5 * 60_000, now), "5m ago");
    assert.equal(formatAgentRailRelativeTime(now - 3 * 3_600_000, now), "3h ago");
    assert.equal(formatAgentRailRelativeTime(now - 2 * 86_400_000, now), "2d ago");
  });

  test("row detail mode guard", () => {
    assert.equal(isAgentRailRowDetailMode("balanced"), true);
    assert.equal(isAgentRailRowDetailMode("compact"), true);
    assert.equal(isAgentRailRowDetailMode("expanded"), true);
    assert.equal(isAgentRailRowDetailMode("auto"), false);
    assert.equal(isAgentRailRowDetailMode("cozy"), false);
    assert.equal(isAgentRailRowDetailMode(undefined), false);
  });

  test("priority buckets: attention, active, review, recent", () => {
    assert.equal(
      getAgentRailPriorityBucket(summary({ hasPendingPermission: true })),
      "attention"
    );
    assert.equal(
      getAgentRailPriorityBucket(summary({ status: "awaiting_question" })),
      "attention"
    );
    assert.equal(getAgentRailPriorityBucket(summary({ status: "failed" })), "attention");
    assert.equal(
      getAgentRailPriorityBucket(summary({ status: "failed" }), { acknowledgedFailure: true }),
      "recent"
    );
    assert.equal(getAgentRailPriorityBucket(summary({ status: "running" })), "active");
    assert.equal(getAgentRailPriorityBucket(summary({ status: "pausing" })), "active");
    assert.equal(
      getAgentRailPriorityBucket(summary(), { unreadCompletion: true }),
      "review"
    );
    assert.equal(getAgentRailPriorityBucket(summary({ status: "paused" })), "recent");
    assert.equal(getAgentRailPriorityBucket(summary({ status: "cancelled" })), "recent");
    assert.equal(getAgentRailPriorityBucket(summary()), "recent");
  });
});
