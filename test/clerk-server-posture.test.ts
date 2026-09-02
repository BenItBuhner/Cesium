import assert from "node:assert/strict";
import { afterEach, describe, test } from "node:test";
import { CESIUM_CLOUD_DEFAULTS } from "../src/lib/cloud/cloud-defaults.ts";
import {
  getClerkSecretKey,
  resolveClerkServerPosture,
  selectClerkProxyBehavior,
} from "../src/lib/cloud/clerk-server-posture.ts";

/**
 * The proxy must only install clerkMiddleware() when the server holds BOTH
 * keys the middleware asserts on every request. A publishable key alone (the
 * committed default every build ships with) means "Clerk in the browser",
 * not "Clerk on the server".
 */

const VARS = [
  "NEXT_PUBLIC_CESIUM_CLOUD",
  "NEXT_PUBLIC_CONVEX_URL",
  "NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY",
  "NEXT_PUBLIC_CESIUM_REQUIRE_SIGN_IN",
  "CLERK_SECRET_KEY",
] as const;

function setEnv(values: Partial<Record<(typeof VARS)[number], string>>) {
  for (const name of VARS) {
    const value = values[name];
    if (value === undefined) {
      delete process.env[name];
    } else {
      process.env[name] = value;
    }
  }
}

describe("clerk server posture", () => {
  afterEach(() => setEnv({}));

  test("bare self-hosted next start (no Clerk env) is client-only, not ready", () => {
    setEnv({});
    const posture = resolveClerkServerPosture();
    assert.deepEqual(posture, {
      kind: "client-only",
      publishableKey: CESIUM_CLOUD_DEFAULTS.clerkPublishableKey,
      signInRequired: false,
    });
    assert.equal(selectClerkProxyBehavior(posture), "passthrough");
  });

  test("secret key alone completes the committed publishable default", () => {
    setEnv({ CLERK_SECRET_KEY: "sk_test_secret" });
    const posture = resolveClerkServerPosture();
    // The secret itself is never surfaced: Clerk reads CLERK_SECRET_KEY from
    // env, and passing it as a middleware option would require
    // CLERK_ENCRYPTION_KEY as well.
    assert.deepEqual(posture, {
      kind: "ready",
      publishableKey: CESIUM_CLOUD_DEFAULTS.clerkPublishableKey,
    });
    assert.equal(selectClerkProxyBehavior(posture), "clerk");
  });

  test("env publishable key overrides the committed default when ready", () => {
    setEnv({
      NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY: "pk_test_override",
      CLERK_SECRET_KEY: "  sk_test_padded  ",
    });
    assert.equal(getClerkSecretKey(), "sk_test_padded");
    assert.deepEqual(resolveClerkServerPosture(), {
      kind: "ready",
      publishableKey: "pk_test_override",
    });
  });

  test("whitespace-only secret counts as missing", () => {
    setEnv({ CLERK_SECRET_KEY: "   " });
    assert.equal(getClerkSecretKey(), null);
    assert.equal(resolveClerkServerPosture().kind, "client-only");
  });

  test("cloud kill switch is off even with a secret present", () => {
    setEnv({ NEXT_PUBLIC_CESIUM_CLOUD: "0", CLERK_SECRET_KEY: "sk_test_secret" });
    const posture = resolveClerkServerPosture();
    assert.deepEqual(posture, { kind: "off" });
    assert.equal(selectClerkProxyBehavior(posture), "passthrough");
  });

  test("device mode (publishable key disabled) is off", () => {
    setEnv({
      NEXT_PUBLIC_CONVEX_URL: "http://127.0.0.1:3210",
      NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY: "off",
      CLERK_SECRET_KEY: "sk_test_secret",
    });
    assert.deepEqual(resolveClerkServerPosture(), { kind: "off" });
  });

  test("gated deployment without a secret fails closed instead of opening up", () => {
    setEnv({ NEXT_PUBLIC_CESIUM_REQUIRE_SIGN_IN: "1" });
    const posture = resolveClerkServerPosture();
    assert.equal(posture.kind, "client-only");
    assert.equal(posture.kind === "client-only" && posture.signInRequired, true);
    assert.equal(selectClerkProxyBehavior(posture), "fail-closed");
  });

  test("gated deployment with a secret runs clerk", () => {
    setEnv({ NEXT_PUBLIC_CESIUM_REQUIRE_SIGN_IN: "1", CLERK_SECRET_KEY: "sk_test_secret" });
    assert.equal(selectClerkProxyBehavior(resolveClerkServerPosture()), "clerk");
  });
});
