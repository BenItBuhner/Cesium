import assert from "node:assert/strict";
import { describe, test } from "node:test";
import {
  resolveAuthPresentation,
  type AuthPresentationInput,
} from "../src/lib/auth-presentation.ts";

function input(overrides: Partial<AuthPresentationInput>): AuthPresentationInput {
  return {
    ready: true,
    enabled: false,
    authenticated: false,
    connectionError: false,
    activeServerRequiresAuth: false,
    serverConfirmedSignedOut: false,
    workbenchLatched: false,
    ...overrides,
  };
}

describe("resolveAuthPresentation", () => {
  test("shows the splash while the very first auth check runs", () => {
    assert.equal(resolveAuthPresentation(input({ ready: false })), "splash");
  });

  test("shows the workbench for an authenticated session", () => {
    assert.equal(
      resolveAuthPresentation(input({ enabled: true, authenticated: true })),
      "workbench"
    );
  });

  test("shows the workbench for a reachable no-auth server", () => {
    assert.equal(resolveAuthPresentation(input({})), "workbench");
  });

  test("gates a fresh boot that cannot reach the server", () => {
    assert.equal(
      resolveAuthPresentation(input({ connectionError: true })),
      "gate"
    );
  });

  test("gates a fresh boot when the server requires auth", () => {
    assert.equal(
      resolveAuthPresentation(input({ enabled: true })),
      "gate"
    );
    assert.equal(
      resolveAuthPresentation(input({ activeServerRequiresAuth: true })),
      "gate"
    );
  });

  describe("latched workbench (session already on screen)", () => {
    test("survives a transient connection error", () => {
      assert.equal(
        resolveAuthPresentation(
          input({ workbenchLatched: true, connectionError: true })
        ),
        "workbench"
      );
    });

    test("survives ready dipping false during a re-check", () => {
      assert.equal(
        resolveAuthPresentation(input({ workbenchLatched: true, ready: false })),
        "workbench"
      );
    });

    test("survives the health probe flapping to auth_required", () => {
      assert.equal(
        resolveAuthPresentation(
          input({ workbenchLatched: true, activeServerRequiresAuth: true })
        ),
        "workbench"
      );
    });

    test("survives every transient signal firing at once", () => {
      assert.equal(
        resolveAuthPresentation(
          input({
            workbenchLatched: true,
            ready: false,
            connectionError: true,
            activeServerRequiresAuth: true,
          })
        ),
        "workbench"
      );
    });

    test("drops to the gate on a server-confirmed sign-out", () => {
      assert.equal(
        resolveAuthPresentation(
          input({
            workbenchLatched: true,
            enabled: true,
            serverConfirmedSignedOut: true,
          })
        ),
        "gate"
      );
    });

    test("stays up when a stale sign-out flag races a successful re-login", () => {
      // serverConfirmedSignedOut is cleared on login, but even if a render
      // lands between the two state updates the authenticated session wins.
      assert.equal(
        resolveAuthPresentation(
          input({
            workbenchLatched: true,
            enabled: true,
            authenticated: true,
            serverConfirmedSignedOut: true,
          })
        ),
        "workbench"
      );
    });
  });

  test("server switch (latch cleared) re-runs the normal boot flow", () => {
    assert.equal(
      resolveAuthPresentation(input({ workbenchLatched: false, ready: false })),
      "splash"
    );
    assert.equal(
      resolveAuthPresentation(
        input({ workbenchLatched: false, connectionError: true })
      ),
      "gate"
    );
  });
});
