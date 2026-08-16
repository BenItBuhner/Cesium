import assert from "node:assert/strict";
import { describe, test } from "node:test";
import type { AgentConversationGroup, AgentRailConversationSummary } from "../src/lib/agent-types.ts";
import {
  collectAttentionConversations,
  conversationHasAttentionHome,
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
});
