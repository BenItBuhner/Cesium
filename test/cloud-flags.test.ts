import assert from "node:assert/strict";
import { afterEach, describe, test } from "node:test";
import { CESIUM_CLOUD_DEFAULTS } from "../src/lib/cloud/cloud-defaults.ts";
import {
  getClerkPublishableKey,
  getCloudMode,
  getConvexUrl,
  getRendezvousHttpUrl,
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
  "NEXT_PUBLIC_CESIUM_RENDEZVOUS_URL",
  "NEXT_PUBLIC_CESIUM_PRODUCTION_BUILD",
  "VERCEL_ENV",
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

  test("unconfigured dev and agent builds stay local-only", () => {
    setEnv({});
    assert.equal(getCloudMode(), "disabled");
    assert.equal(getConvexUrl(), null);
    assert.equal(getRendezvousHttpUrl(), null);
    assert.equal(getClerkPublishableKey(), null);
    assert.equal(isSignInRequired(), false);
    assert.equal(isCloudExplicitlyDisabled(), false);
  });

  test("convex url alone selects isolated device mode", () => {
    setEnv({ NEXT_PUBLIC_CONVEX_URL: "http://127.0.0.1:3210" });
    assert.equal(getCloudMode(), "device");
    assert.equal(isSignInRequired(), false);
  });

  test("Vercel production uses committed production defaults", () => {
    setEnv({ NEXT_PUBLIC_CESIUM_PRODUCTION_BUILD: "1" });
    assert.equal(getCloudMode(), "clerk");
    assert.equal(getConvexUrl(), CESIUM_CLOUD_DEFAULTS.convexUrl);
    assert.equal(getRendezvousHttpUrl(), CESIUM_CLOUD_DEFAULTS.rendezvousHttpUrl);
    assert.equal(getClerkPublishableKey(), CESIUM_CLOUD_DEFAULTS.clerkPublishableKey);
  });

  test("explicit cloud opt-in uses committed defaults outside Vercel", () => {
    setEnv({ NEXT_PUBLIC_CESIUM_CLOUD: "1" });
    assert.equal(getCloudMode(), "clerk");
    assert.equal(getConvexUrl(), CESIUM_CLOUD_DEFAULTS.convexUrl);
  });

  test("explicit clerk off-value keeps device mode", () => {
    setEnv({
      NEXT_PUBLIC_CONVEX_URL: "http://127.0.0.1:3210",
      NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY: "0",
    });
    assert.equal(getCloudMode(), "device");
    assert.equal(getClerkPublishableKey(), null);
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
      NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY: "0",
    });
    assert.equal(getCloudMode(), "device");
  });

  test("require-sign-in only applies in clerk mode", () => {
    setEnv({
      NEXT_PUBLIC_CONVEX_URL: "http://127.0.0.1:3210",
      NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY: "0",
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
