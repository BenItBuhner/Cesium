import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { isStandaloneChatWorkspace, type WorkspaceRecord } from "../src/lib/types.ts";

function workspace(
  overrides: Partial<WorkspaceRecord> & Pick<WorkspaceRecord, "id" | "root">
): WorkspaceRecord {
  return {
    name: overrides.name ?? overrides.id,
    createdAt: 1,
    updatedAt: 1,
    lastOpenedAt: 1,
    ...overrides,
  };
}

describe("standalone chat workspace detection", () => {
  test("honors explicit kind", () => {
    assert.equal(
      isStandaloneChatWorkspace(
        workspace({
          id: "a",
          root: "/home/me/projects/app",
          kind: "standalone-chat",
        })
      ),
      true
    );
    assert.equal(
      isStandaloneChatWorkspace(
        workspace({
          id: "b",
          root: "/tmp/data/standalone-chats/chat-1",
          kind: "workspace",
        })
      ),
      false
    );
  });

  test("detects standalone-chats path convention", () => {
    assert.equal(
      isStandaloneChatWorkspace(
        workspace({
          id: "c",
          root: "/home/me/.local/state/cesium/standalone-chats/chat-abc",
        })
      ),
      true
    );
    assert.equal(
      isStandaloneChatWorkspace(
        workspace({
          id: "d",
          root: "/workspace",
        })
      ),
      false
    );
  });
});
