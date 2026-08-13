import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { deriveWorkbenchAccess } from "../src/lib/workbench-access-state.ts";

const onlineEngine = {
  authReady: true,
  authEnabled: false,
  authAuthenticated: false,
  authConnectionError: null as string | null,
  health: "online",
  engineLabel: "Local",
  engineBaseUrl: "http://localhost:9100",
};

describe("workbench access", () => {
  test("local-only plus a live engine is a guest session", () => {
    const access = deriveWorkbenchAccess({
      cloudMode: "disabled",
      cloudStatus: "disabled",
      userName: null,
      userEmail: null,
      userImageUrl: null,
      ...onlineEngine,
    });
    assert.equal(access.accountKind, "local-only");
    assert.equal(access.displayName, "Guest");
    assert.equal(access.agentsLive, true);
    assert.equal(access.isGuest, true);
    assert.equal(access.engineKind, "online");
  });

  test("signed-out without an engine stays inert and prompts sign-in", () => {
    const access = deriveWorkbenchAccess({
      cloudMode: "clerk",
      cloudStatus: "signed-out",
      userName: null,
      userEmail: null,
      userImageUrl: null,
      authReady: true,
      authEnabled: false,
      authAuthenticated: false,
      authConnectionError: "ECONNREFUSED",
      health: "offline",
      engineLabel: "Local",
      engineBaseUrl: "http://localhost:9100",
    });
    assert.equal(access.accountKind, "signed-out");
    assert.equal(access.displayName, "Sign in");
    assert.equal(access.agentsLive, false);
    assert.equal(access.isGuest, false);
    assert.equal(access.engineKind, "offline");
  });

  test("signed-in plus a live engine is the full workbench", () => {
    const access = deriveWorkbenchAccess({
      cloudMode: "clerk",
      cloudStatus: "ready",
      userName: "Ada Lovelace",
      userEmail: "ada@example.com",
      userImageUrl: "https://example.com/ada.png",
      ...onlineEngine,
    });
    assert.equal(access.accountKind, "signed-in");
    assert.equal(access.displayName, "Ada Lovelace");
    assert.equal(access.agentsLive, true);
    assert.equal(access.isGuest, false);
    assert.equal(access.cloudSyncReady, true);
  });

  test("engine password auth keeps the agents panel inert", () => {
    const access = deriveWorkbenchAccess({
      cloudMode: "disabled",
      cloudStatus: "disabled",
      userName: null,
      userEmail: null,
      userImageUrl: null,
      authReady: true,
      authEnabled: true,
      authAuthenticated: false,
      authConnectionError: null,
      health: "auth_required",
      engineLabel: "Remote",
      engineBaseUrl: "https://engine.example.com",
    });
    assert.equal(access.engineKind, "auth_required");
    assert.equal(access.agentsLive, false);
    assert.equal(access.displayName, "Guest");
  });
});
