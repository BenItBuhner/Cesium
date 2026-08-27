import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { WORKBENCH_NOTIFICATION_KIND } from "../src/components/notifications/workbench-notification-types.ts";
import {
  compactWorkspaceErrorMessage,
  describeWorkspaceLoadFailure,
  isMissingEngineError,
  shouldPromptFirstServerConnect,
} from "../src/lib/onboarding/workspace-errors.ts";
import type { PlatformSetupProfile } from "../src/lib/onboarding/platform.ts";

const WEB_PROFILE: PlatformSetupProfile = {
  platform: "web",
  steps: ["connect-server", "agents", "import", "first-chat"],
  serverConnection: "step",
};

const DESKTOP_PROFILE: PlatformSetupProfile = {
  platform: "desktop",
  steps: ["agents", "import", "first-chat"],
  serverConnection: "footnote",
};

const EMPTY = { completedSteps: [] as const, completedAt: null };

describe("workspace load notices", () => {
  test("treats the hosted-HTML 404 as a missing engine", () => {
    const error = new Error(
      "The server did not respond like a Cesium engine (HTTP 404). " +
        "Check that the active server connection points at a running engine."
    );
    assert.equal(isMissingEngineError(error), true);
    assert.equal(isMissingEngineError(new Error("Failed to fetch")), true);
    assert.equal(isMissingEngineError(new Error("Workspace not found")), false);
  });

  test("first-run missing engine becomes Connect your first server", () => {
    const notice = describeWorkspaceLoadFailure(
      new Error("The server did not respond like a Cesium engine (HTTP 404)."),
      { state: EMPTY, profile: WEB_PROFILE }
    );
    assert.equal(notice.kind, WORKBENCH_NOTIFICATION_KIND.connectFirstServer);
    assert.equal(notice.severity, "info");
    assert.equal(notice.title, "Connect your first server!");
    assert.equal(notice.setupActionLabel, "Connect server");
    assert.equal(notice.persistent, true);
  });

  test("returning users get a reconnect prompt, not a workspace error", () => {
    const notice = describeWorkspaceLoadFailure(
      new Error("Failed to fetch"),
      {
        state: { completedSteps: ["connect-server"], completedAt: null },
        profile: WEB_PROFILE,
      }
    );
    assert.equal(notice.title, "Can't reach your server");
    assert.equal(notice.severity, "warning");
    assert.equal(notice.setupActionLabel, "Open setup");
    assert.notEqual(notice.kind, WORKBENCH_NOTIFICATION_KIND.connectFirstServer);
  });

  test("desktop never asks to connect a first server", () => {
    assert.equal(
      shouldPromptFirstServerConnect({ state: EMPTY, profile: DESKTOP_PROFILE }),
      false
    );
    const notice = describeWorkspaceLoadFailure(new Error("Failed to fetch"), {
      state: EMPTY,
      profile: DESKTOP_PROFILE,
    });
    assert.equal(notice.title, "Can't reach your local engine");
  });

  test("real workspace bugs stay as Workspace error", () => {
    const notice = describeWorkspaceLoadFailure(new Error("Workspace not found"), {
      state: EMPTY,
      profile: WEB_PROFILE,
    });
    assert.equal(notice.kind, WORKBENCH_NOTIFICATION_KIND.workspaceLoadError);
    assert.equal(notice.title, "Workspace error");
    assert.equal(notice.message, "Workspace not found");
    assert.equal(notice.setupActionLabel, null);
  });

  test("compactWorkspaceErrorMessage strips markup and caps length", () => {
    assert.equal(
      compactWorkspaceErrorMessage("<html>nope</html>", "fallback"),
      "fallback"
    );
    assert.equal(
      compactWorkspaceErrorMessage("x".repeat(500), "fallback"),
      `${"x".repeat(240)}...`
    );
    assert.equal(
      compactWorkspaceErrorMessage(new Error("x".repeat(500)), "fallback"),
      `${"x".repeat(240)}...`
    );
  });
});
