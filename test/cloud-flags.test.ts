import assert from "node:assert/strict";
import { afterEach, describe, test } from "node:test";
import {
  getClerkPublishableKey,
  getCloudMode,
  getConvexUrl,
  isCloudExplicitlyDisabled,
  isSignInRequired,
} from "../src/lib/cloud/cloud-flags.ts";

/**
 * Cloud posture toggles: the master `NEXT_PUBLIC_CESIUM_CLOUD` switch must
 * force pre-cloud local-only behavior regardless of other configuration, and
 * mode/sign-in derivation must follow the documented matrix.
 */

const VARS = [
  "NEXT_PUBLIC_CESIUM_CLOUD",
  "NEXT_PUBLIC_CONVEX_URL",
  "NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY",
  "NEXT_PUBLIC_CESIUM_REQUIRE_SIGN_IN",
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

describe("cloud flags", () => {
  afterEach(() => setEnv({}));

  test("default (no env) is local-only - pre-cloud behavior", () => {
    setEnv({});
    assert.equal(getCloudMode(), "disabled");
    assert.equal(getConvexUrl(), null);
    assert.equal(getClerkPublishableKey(), null);
    assert.equal(isSignInRequired(), false);
    assert.equal(isCloudExplicitlyDisabled(), false);
  });

  test("convex url alone enables device mode", () => {
    setEnv({ NEXT_PUBLIC_CONVEX_URL: "http://127.0.0.1:3210" });
    assert.equal(getCloudMode(), "device");
    assert.equal(isSignInRequired(), false);
  });

  test("convex + clerk enables clerk mode", () => {
    setEnv({
      NEXT_PUBLIC_CONVEX_URL: "https://something.convex.cloud",
      NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY: "pk_test_abc",
    });
    assert.equal(getCloudMode(), "clerk");
    assert.equal(isSignInRequired(), false);
  });

  test("kill switch forces local-only even with full cloud config", () => {
    for (const off of ["0", "off", "false", "disabled", "no", "OFF", " 0 "]) {
      setEnv({
        NEXT_PUBLIC_CESIUM_CLOUD: off,
        NEXT_PUBLIC_CONVEX_URL: "https://something.convex.cloud",
        NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY: "pk_test_abc",
        NEXT_PUBLIC_CESIUM_REQUIRE_SIGN_IN: "1",
      });
      assert.equal(isCloudExplicitlyDisabled(), true, `off value ${off}`);
      assert.equal(getCloudMode(), "disabled", `off value ${off}`);
      assert.equal(getConvexUrl(), null, `off value ${off}`);
      assert.equal(getClerkPublishableKey(), null, `off value ${off}`);
      assert.equal(isSignInRequired(), false, `off value ${off}`);
    }
  });

  test("explicit on values keep normal derivation", () => {
    setEnv({
      NEXT_PUBLIC_CESIUM_CLOUD: "1",
      NEXT_PUBLIC_CONVEX_URL: "http://127.0.0.1:3210",
    });
    assert.equal(getCloudMode(), "device");
  });

  test("require-sign-in only applies in clerk mode", () => {
    setEnv({
      NEXT_PUBLIC_CONVEX_URL: "http://127.0.0.1:3210",
      NEXT_PUBLIC_CESIUM_REQUIRE_SIGN_IN: "1",
    });
    assert.equal(isSignInRequired(), false, "device mode never requires sign-in");

    setEnv({
      NEXT_PUBLIC_CONVEX_URL: "https://something.convex.cloud",
      NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY: "pk_test_abc",
      NEXT_PUBLIC_CESIUM_REQUIRE_SIGN_IN: "1",
    });
    assert.equal(isSignInRequired(), true);

    setEnv({
      NEXT_PUBLIC_CONVEX_URL: "https://something.convex.cloud",
      NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY: "pk_test_abc",
    });
    assert.equal(isSignInRequired(), false, "opt-in only");
  });
});
