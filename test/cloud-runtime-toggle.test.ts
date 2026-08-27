import assert from "node:assert/strict";
import { afterEach, describe, test } from "node:test";
import { clientKeyValueStore } from "../packages/client/src/index.ts";
import {
  CLOUD_LOCAL_ONLY_STORAGE_KEY,
  getEffectiveCloudMode,
  isCloudLocallyDisabled,
  setCloudLocallyDisabled,
} from "../src/lib/cloud/cloud-env.ts";

/**
 * Runtime local-only override: build config (env / committed defaults)
 * decides whether cloud is available, and a persisted per-device switch can
 * flip any cloud-capable client back to pure local-only behavior — the same
 * mechanism on web, Electron, Android, and iOS.
 */

function resetEnv() {
  delete process.env.NEXT_PUBLIC_CESIUM_CLOUD;
  delete process.env.NEXT_PUBLIC_CONVEX_URL;
  delete process.env.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY;
}

describe("cloud runtime local-only toggle", () => {
  afterEach(() => {
    resetEnv();
    setCloudLocallyDisabled(false);
  });

  test("defaults to cloud-on (no opt-out persisted)", () => {
    assert.equal(isCloudLocallyDisabled(), false);
    process.env.NEXT_PUBLIC_CONVEX_URL = "http://127.0.0.1:3210";
    process.env.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY = "0";
    assert.equal(getEffectiveCloudMode(), "device");
  });

  test("opt-out forces local-only even with full cloud config", () => {
    process.env.NEXT_PUBLIC_CONVEX_URL = "https://something.convex.cloud";
    process.env.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY = "pk_test_abc";
    setCloudLocallyDisabled(true);
    assert.equal(isCloudLocallyDisabled(), true);
    assert.equal(getEffectiveCloudMode(), "disabled");
  });

  test("re-enabling restores the configured mode", () => {
    process.env.NEXT_PUBLIC_CONVEX_URL = "https://something.convex.cloud";
    process.env.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY = "pk_test_abc";
    setCloudLocallyDisabled(true);
    assert.equal(getEffectiveCloudMode(), "disabled");
    setCloudLocallyDisabled(false);
    assert.equal(getEffectiveCloudMode(), "clerk");
  });

  test("persists through the platform key-value store", () => {
    setCloudLocallyDisabled(true);
    assert.equal(clientKeyValueStore().getItem(CLOUD_LOCAL_ONLY_STORAGE_KEY), "1");
    setCloudLocallyDisabled(false);
    assert.equal(clientKeyValueStore().getItem(CLOUD_LOCAL_ONLY_STORAGE_KEY), null);
  });

  test("opt-out has no effect on builds without cloud config", () => {
    process.env.NEXT_PUBLIC_CESIUM_CLOUD = "0";
    setCloudLocallyDisabled(true);
    assert.equal(getEffectiveCloudMode(), "disabled");
    setCloudLocallyDisabled(false);
    assert.equal(getEffectiveCloudMode(), "disabled");
  });
});
