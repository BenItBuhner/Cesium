import assert from "node:assert/strict";
import { afterEach, describe, test } from "node:test";
import {
  DEFAULT_USER_PREFERENCES,
  parseUserPreferences,
} from "../src/lib/preferences.ts";
import {
  getCesiumRendererFeatureFlags,
  isBrowserMachineOffered,
  isCesiumMobileApp,
  isNativeCesiumShell,
  resolveEffectiveUserPreferences,
} from "../src/lib/platform-feature-flags.ts";

const originalWindow = (globalThis as typeof globalThis & { window?: unknown })
  .window;

afterEach(() => {
  if (originalWindow === undefined) {
    delete (globalThis as typeof globalThis & { window?: unknown }).window;
    return;
  }
  (globalThis as typeof globalThis & { window?: unknown }).window =
    originalWindow;
});

describe("platform feature flags", () => {
  test("enables iPad beta surfaces on web", () => {
    delete (globalThis as typeof globalThis & { window?: unknown }).window;

    assert.deepEqual(getCesiumRendererFeatureFlags(), {
      ipadBetaSettings: true,
      ipadExperimentalUi: true,
      ipadResumeCache: true,
      vscodeExtensionsBetaSettings: false,
    });
  });

  test("disables iPad beta surfaces inside Electron", () => {
    (globalThis as typeof globalThis & { window?: unknown }).window = {
      cesiumDesktop: { isElectron: true },
    };

    assert.deepEqual(getCesiumRendererFeatureFlags(), {
      ipadBetaSettings: false,
      ipadExperimentalUi: false,
      ipadResumeCache: false,
      vscodeExtensionsBetaSettings: true,
    });
  });

  test("forces iPad preference toggles off on desktop even when stored enabled", () => {
    (globalThis as typeof globalThis & { window?: unknown }).window = {
      cesiumDesktop: { isElectron: true },
    };

    const stored = parseUserPreferences(
      JSON.stringify({
        experimentalIpadMode: true,
        experimentalIpadCustomButtons: true,
        experimentalIpadWindowedTabInset: true,
        experimentalIpadResumeCache: true,
      })
    );

    assert.deepEqual(resolveEffectiveUserPreferences(stored), {
      ...DEFAULT_USER_PREFERENCES,
      vscodeExtensionsBeta: false,
    });
  });

  test("offers the browser machine on hosted web, not native shells", () => {
    delete (globalThis as typeof globalThis & { window?: unknown }).window;
    assert.equal(isBrowserMachineOffered(), false);
    assert.equal(isNativeCesiumShell(), false);

    (globalThis as typeof globalThis & { window?: unknown }).window = {};
    assert.equal(isBrowserMachineOffered(), true);
    assert.equal(isNativeCesiumShell(), false);
    assert.equal(isCesiumMobileApp(), false);

    (globalThis as typeof globalThis & { window?: unknown }).window = {
      cesiumDesktop: { isElectron: true },
    };
    assert.equal(isBrowserMachineOffered(), false);
    assert.equal(isNativeCesiumShell(), true);

    (globalThis as typeof globalThis & { window?: unknown }).window = {
      cesiumMobile: { isReactNative: true },
    };
    assert.equal(isCesiumMobileApp(), true);
    assert.equal(isNativeCesiumShell(), true);
    assert.equal(isBrowserMachineOffered(), false);

    (globalThis as typeof globalThis & { window?: unknown }).window = {
      __CESIUM_MOBILE_SERVER__: { baseUrl: "http://10.0.2.2:9100" },
    };
    assert.equal(isCesiumMobileApp(), true);
    assert.equal(isBrowserMachineOffered(), false);
  });

  test("allows VS Code extensions beta only on desktop", () => {
    const stored = parseUserPreferences(
      JSON.stringify({
        vscodeExtensionsBeta: true,
      })
    );

    delete (globalThis as typeof globalThis & { window?: unknown }).window;
    assert.equal(resolveEffectiveUserPreferences(stored).vscodeExtensionsBeta, false);

    (globalThis as typeof globalThis & { window?: unknown }).window = {
      cesiumDesktop: { isElectron: true },
    };
    assert.equal(resolveEffectiveUserPreferences(stored).vscodeExtensionsBeta, true);
  });
});
