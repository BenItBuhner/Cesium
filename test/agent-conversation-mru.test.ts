import assert from "node:assert/strict";
import { describe, test } from "node:test";

import {
  AGENT_CONVERSATION_MRU_MAX,
  bumpAgentConversationMru,
  buildAgentSwitcherList,
  initialAgentSwitcherIndex,
  nextAgentSwitcherIndex,
  normalizeAgentConversationMruByServer,
  seedAgentConversationMruFromCandidates,
} from "../src/lib/agent-conversation-mru.ts";
import { AGENT_NEW_CHAT_SESSION_ID } from "../src/lib/workspace-session.ts";

describe("agent conversation MRU", () => {
  test("bump moves id to front and caps length", () => {
    const stack = ["a", "b", "c"];
    assert.deepEqual(bumpAgentConversationMru("b", stack), ["b", "a", "c"]);
    const long = Array.from({ length: AGENT_CONVERSATION_MRU_MAX }, (_, i) => `id-${i}`);
    const bumped = bumpAgentConversationMru("fresh-id", long);
    assert.equal(bumped[0], "fresh-id");
    assert.equal(bumped.length, AGENT_CONVERSATION_MRU_MAX);
  });

  test("skips draft placeholder ids", () => {
    assert.deepEqual(
      bumpAgentConversationMru(AGENT_NEW_CHAT_SESSION_ID, ["x"]),
      ["x"]
    );
  });

  test("buildAgentSwitcherList orders MRU first then activity tail", () => {
    const candidates = [
      {
        id: "a",
        title: "A",
        updatedAt: 100,
        workspaceId: "ws",
        workspaceName: "WS",
      },
      {
        id: "b",
        title: "B",
        updatedAt: 300,
        workspaceId: "ws",
        workspaceName: "WS",
      },
      {
        id: "c",
        title: "C",
        updatedAt: 200,
        workspaceId: "ws",
        workspaceName: "WS",
      },
    ];
    const ordered = buildAgentSwitcherList({
      mruIds: ["c", "a"],
      candidates,
    });
    assert.deepEqual(
      ordered.map((item) => item.id),
      ["c", "a", "b"]
    );
  });

  test("nextAgentSwitcherIndex wraps around", () => {
    assert.equal(nextAgentSwitcherIndex(2, 3, 1), 0);
    assert.equal(nextAgentSwitcherIndex(0, 3, -1), 2);
  });

  test("initialAgentSwitcherIndex advances from current conversation", () => {
    const items = [
      { id: "a", title: "A", updatedAt: 1, workspaceId: "w", workspaceName: "W" },
      { id: "b", title: "B", updatedAt: 2, workspaceId: "w", workspaceName: "W" },
      { id: "c", title: "C", updatedAt: 3, workspaceId: "w", workspaceName: "W" },
    ];
    assert.equal(initialAgentSwitcherIndex("a", items, 1), 1);
    assert.equal(initialAgentSwitcherIndex("a", items, -1), 2);
  });

  test("seedAgentConversationMruFromCandidates uses updatedAt", () => {
    const seed = seedAgentConversationMruFromCandidates([
      { id: "a", title: "A", updatedAt: 1, workspaceId: "w", workspaceName: "W" },
      { id: "b", title: "B", updatedAt: 5, workspaceId: "w", workspaceName: "W" },
    ]);
    assert.deepEqual(seed, ["b", "a"]);
  });

  test("normalizeAgentConversationMruByServer drops invalid ids", () => {
    assert.deepEqual(
      normalizeAgentConversationMruByServer({
        srv: ["a", AGENT_NEW_CHAT_SESSION_ID, 12, "b"],
      }),
      { srv: ["a", "b"] }
    );
  });
});
