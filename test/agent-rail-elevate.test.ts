import assert from "node:assert/strict";
import { describe, test } from "node:test";
import type { AgentConversationGroup, AgentRailConversationSummary } from "../src/lib/agent-types.ts";
import {
  collectAttentionConversations,
  collectRunningConversations,
  conversationHasAttentionHome,
  conversationHasRunningHome,
  sinkSettledInGroups,
  stripAttentionFromPinned,
  stripElevatedFromGroups,
} from "../src/lib/agent-rail-elevate.ts";
import type { WorkspaceRecord } from "../src/lib/types.ts";

function workspace(id: string, name = id): WorkspaceRecord {
  return {
    id,
    name,
    root: `/tmp/${name}`,
    createdAt: 1,
    updatedAt: 1,
    lastOpenedAt: 1,
  };
}

function conversation(
  id: string,
  workspaceId: string,
  overrides: Partial<AgentRailConversationSummary> = {}
): AgentRailConversationSummary {
  return {
    id,
    workspaceId,
    title: id,
    createdAt: 1,
    updatedAt: 2,
    lastEventSeq: 1,
    status: "idle",
    archivedAt: null,
    backendId: "cursor-sdk",
    mode: "agent",
    experimental: false,
    hasPendingPermission: false,
    ...overrides,
  };
}

describe("agent rail elevate", () => {
  test("unread failures need attention; acknowledged failures do not", () => {
    const failed = conversation("f", "ws", { status: "failed" });
    assert.equal(conversationHasAttentionHome(failed), true);
    assert.equal(
      conversationHasAttentionHome(failed, {
        acknowledgedFailureByConversationId: { f: true },
      }),
      false
    );
    assert.equal(
      conversationHasAttentionHome(conversation("p", "ws", { hasPendingPermission: true })),
      true
    );
  });

  test("attention rows are removed from home groups and from pinned", () => {
    const perm = conversation("perm", "ws", { hasPendingPermission: true });
    const pinnedIdle = conversation("pin", "ws");
    const idle = conversation("idle", "ws");
    const groups: AgentConversationGroup[] = [
      {
        workspace: workspace("ws"),
        conversations: [perm, pinnedIdle, idle],
      },
    ];
    const attention = collectAttentionConversations(groups, [pinnedIdle], {});
    assert.deepEqual(
      attention.map((item) => item.id),
      ["perm"]
    );
    const attentionIds = new Set(attention.map((item) => item.id));
    const pinned = stripAttentionFromPinned([perm, pinnedIdle], attentionIds);
    assert.deepEqual(
      pinned.map((item) => item.id),
      ["pin"]
    );
    const home = stripElevatedFromGroups(groups, attentionIds, new Set(["pin"]));
    assert.deepEqual(
      home[0]?.conversations.map((item) => item.id),
      ["idle"]
    );
  });

  test("running conversations get their own elevated home; attention wins", () => {
    const running = conversation("run", "ws", { status: "running" });
    const pausing = conversation("pause", "ws", { status: "pausing" });
    const blockedRunner = conversation("blocked", "ws", {
      status: "running",
      hasPendingQuestion: true,
    });
    const idle = conversation("idle", "ws");
    assert.equal(conversationHasRunningHome(running), true);
    assert.equal(conversationHasRunningHome(pausing), true);
    // Blocked on the user: homed in Needs attention, not Running.
    assert.equal(conversationHasRunningHome(blockedRunner), false);
    assert.equal(conversationHasAttentionHome(blockedRunner), true);
    assert.equal(conversationHasRunningHome(idle), false);

    const groups: AgentConversationGroup[] = [
      { workspace: workspace("ws"), conversations: [running, pausing, blockedRunner, idle] },
    ];
    const collected = collectRunningConversations(groups, [], {});
    assert.deepEqual(
      collected.map((item) => item.id).sort(),
      ["pause", "run"]
    );
    const elevatedIds = new Set([
      ...collected.map((item) => item.id),
      ...collectAttentionConversations(groups, [], {}).map((item) => item.id),
    ]);
    const home = stripElevatedFromGroups(groups, elevatedIds, new Set());
    assert.deepEqual(
      home[0]?.conversations.map((item) => item.id),
      ["idle"]
    );
  });

  test("settled runners are not promoted into the Running section", () => {
    const settledRunner = conversation("sr", "ws", { status: "running", settledAt: 10 });
    assert.equal(conversationHasRunningHome(settledRunner), false);
    const groups: AgentConversationGroup[] = [
      { workspace: workspace("ws"), conversations: [settledRunner] },
    ];
    assert.deepEqual(collectRunningConversations(groups, [], {}), []);
  });

  test("settled failures leave the attention inbox", () => {
    const settledFailed = conversation("sf", "ws", { status: "failed", settledAt: 10 });
    assert.equal(conversationHasAttentionHome(settledFailed), false);
    // Blocked-on-user states still surface even when settled.
    const settledBlocked = conversation("sb", "ws", {
      hasPendingPermission: true,
      settledAt: 10,
    });
    assert.equal(conversationHasAttentionHome(settledBlocked), true);
  });

  test("sinkSettledInGroups keeps relative order but sends settled rows to the bottom", () => {
    const a = conversation("a", "ws", { updatedAt: 50, settledAt: 5 });
    const b = conversation("b", "ws", { updatedAt: 40 });
    const c = conversation("c", "ws", { updatedAt: 30, settledAt: 6 });
    const d = conversation("d", "ws", { updatedAt: 20 });
    const groups: AgentConversationGroup[] = [
      { workspace: workspace("ws"), conversations: [a, b, c, d] },
    ];
    const sunk = sinkSettledInGroups(groups);
    assert.deepEqual(
      sunk[0]?.conversations.map((item) => item.id),
      ["b", "d", "a", "c"]
    );
    // No settled rows: groups pass through untouched (same reference).
    const untouched: AgentConversationGroup[] = [
      { workspace: workspace("ws2"), conversations: [b, d] },
    ];
    assert.equal(sinkSettledInGroups(untouched)[0], untouched[0]);
  });
});
