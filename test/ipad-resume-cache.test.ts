import assert from "node:assert/strict";
import { describe, test } from "node:test";
import {
  IPAD_RESUME_CACHE_SCHEMA_VERSION,
  buildIpadResumeSnapshotKey,
  isValidIpadResumeSnapshot,
} from "../src/lib/ipad-resume-cache.ts";
import { createDefaultWorkspaceSession } from "../src/lib/workspace-session.ts";

describe("iPad resume cache helpers", () => {
  test("builds a server-scoped snapshot key", () => {
    assert.equal(
      buildIpadResumeSnapshotKey({
        serverKey: "local-3001",
        sessionScopeId: "workspace-a:window:window-b",
      }),
      "local-3001::workspace-a:window:window-b"
    );
  });

  test("validates versioned snapshot shape", () => {
    const workspaceSession = createDefaultWorkspaceSession([], {
      id: "fixture",
      name: "Fixture",
      provider: "fixture",
    });
    const snapshot = {
      schemaVersion: IPAD_RESUME_CACHE_SCHEMA_VERSION,
      key: "server::workspace",
      savedAt: Date.now(),
      serverKey: "server",
      workspaceId: "workspace",
      windowId: null,
      sessionScopeId: "workspace",
      route: { pathname: "/workspace", search: "?workspaceId=workspace", hash: "" },
      workspaceSession,
    };

    assert.equal(isValidIpadResumeSnapshot(snapshot), true);
    assert.equal(isValidIpadResumeSnapshot({ ...snapshot, schemaVersion: 2 }), false);
  });
});
