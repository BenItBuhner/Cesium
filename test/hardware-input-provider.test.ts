import assert from "node:assert/strict";
import { afterEach, describe, test } from "node:test";
import { shouldEnableHardwareInputSurfaces } from "../src/components/input/HardwareInputProvider.tsx";

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

describe("hardware input surface gating", () => {
  test("keeps hardware input surfaces disabled when the preference is off", () => {
    assert.equal(shouldEnableHardwareInputSurfaces(false), false);
  });

  test("allows iPad hardware input surfaces outside Electron", () => {
    delete (globalThis as typeof globalThis & { window?: unknown }).window;

    assert.equal(shouldEnableHardwareInputSurfaces(true), true);
  });

  test("disables iPad hardware input surfaces inside the Electron shell", () => {
    (globalThis as typeof globalThis & { window?: unknown }).window = {
      cesiumDesktop: { isElectron: true },
    };

    assert.equal(shouldEnableHardwareInputSurfaces(true), false);
  });
});
