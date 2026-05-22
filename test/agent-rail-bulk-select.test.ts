import assert from "node:assert/strict";
import { describe, test } from "node:test";
import type { AgentRailConversationSummary } from "../src/lib/agent-types.ts";
import {
  applyRailBulkClick,
  buildRailBulkSectionId,
  getRailConversationKey,
  orderedRailConversationKeys,
  railBulkClickModifierInBulkMode,
} from "../src/lib/agent-rail-bulk-select.ts";

function summary(
  id: string,
  conversationKey?: string
): AgentRailConversationSummary {
  return {
    id,
    conversationKey,
    workspaceId: "ws-1",
    title: id,
    createdAt: 1,
    updatedAt: 1,
    lastEventSeq: 1,
    status: "idle",
    archivedAt: null,
    backendId: "cursor-sdk",
    mode: "agent",
    experimental: false,
    hasPendingPermission: false,
  };
}

describe("agent rail bulk select", () => {
  test("getRailConversationKey prefers conversationKey", () => {
    assert.equal(getRailConversationKey(summary("a", "server:a")), "server:a");
    assert.equal(getRailConversationKey(summary("a")), "a");
  });

  test("buildRailBulkSectionId encodes pinned, root, and folder", () => {
    assert.equal(
      buildRailBulkSectionId({ inPinnedSection: true, workspaceId: "ws-1" }),
      "pinned"
    );
    assert.equal(buildRailBulkSectionId({ workspaceId: "ws-1" }), "ws:ws-1:root");
    assert.equal(
      buildRailBulkSectionId({ workspaceId: "ws-1", folderId: "f-1" }),
      "ws:ws-1:folder:f-1"
    );
  });

  test("plain click replaces selection", () => {
    const keys = ["a", "b", "c"];
    const result = applyRailBulkClick({
      orderedKeys: keys,
      selectedKeys: new Set(["a", "b"]),
      anchorIndex: 0,
      targetIndex: 2,
      modifier: "none",
    });
    assert.deepEqual([...result.selectedKeys], ["c"]);
    assert.equal(result.anchorIndex, 2);
  });

  test("shift click extends range from anchor", () => {
    const keys = ["a", "b", "c", "d", "e"];
    const result = applyRailBulkClick({
      orderedKeys: keys,
      selectedKeys: new Set(["b"]),
      anchorIndex: 1,
      targetIndex: 3,
      modifier: "shift",
    });
    assert.deepEqual([...result.selectedKeys].sort(), ["b", "c", "d"]);
    assert.equal(result.anchorIndex, 3);
  });

  test("shift click works when target is above anchor", () => {
    const keys = ["a", "b", "c", "d"];
    const result = applyRailBulkClick({
      orderedKeys: keys,
      selectedKeys: new Set(["d"]),
      anchorIndex: 3,
      targetIndex: 1,
      modifier: "shift",
    });
    assert.deepEqual([...result.selectedKeys].sort(), ["b", "c", "d"]);
  });

  test("toggle adds and removes a single key", () => {
    const keys = ["a", "b", "c"];
    const added = applyRailBulkClick({
      orderedKeys: keys,
      selectedKeys: new Set(["a"]),
      anchorIndex: 0,
      targetIndex: 2,
      modifier: "toggle",
    });
    assert.deepEqual([...added.selectedKeys].sort(), ["a", "c"]);

    const removed = applyRailBulkClick({
      orderedKeys: keys,
      selectedKeys: new Set(["a", "c"]),
      anchorIndex: 2,
      targetIndex: 0,
      modifier: "toggle",
    });
    assert.deepEqual([...removed.selectedKeys], ["c"]);
  });

  test("orderedRailConversationKeys preserves list order", () => {
    assert.deepEqual(
      orderedRailConversationKeys([
        summary("one", "srv:one"),
        summary("two", "srv:two"),
      ]),
      ["srv:one", "srv:two"]
    );
  });

  test("bulk mode maps plain click to toggle", () => {
    assert.equal(
      railBulkClickModifierInBulkMode({ shiftKey: false, metaKey: false, ctrlKey: false }),
      "toggle"
    );
    assert.equal(
      railBulkClickModifierInBulkMode({ shiftKey: true, metaKey: false, ctrlKey: false }),
      "shift"
    );
    assert.equal(
      railBulkClickModifierInBulkMode({ shiftKey: false, metaKey: true, ctrlKey: false }),
      "toggle"
    );
  });
});
