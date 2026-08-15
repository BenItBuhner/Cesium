import assert from "node:assert/strict";
import { describe, test } from "node:test";
import {
  AURORA_INTENSITY_DEFAULT,
  AURORA_PRESETS,
  createDefaultAuroraConfig,
  createDefaultThemeConfig,
  normalizeAuroraConfig,
  normalizeThemeConfig,
  parseAuroraHex,
  resolveAuroraPresetColors,
} from "../src/lib/theme-config.ts";

describe("aurora config", () => {
  test("defaults a subtle enabled borealis wash", () => {
    const config = createDefaultAuroraConfig();
    assert.equal(config.enabled, true);
    assert.equal(config.presetId, "borealis");
    assert.equal(config.intensity, AURORA_INTENSITY_DEFAULT);
    assert.equal(AURORA_INTENSITY_DEFAULT, 52);
    assert.equal(config.reactToState, true);
    assert.equal(config.customColors.length, 3);
  });

  test("theme config includes aurora defaults", () => {
    const theme = createDefaultThemeConfig();
    assert.equal(theme.aurora.presetId, "borealis");
    assert.equal(
      normalizeThemeConfig({
        schemaVersion: 1,
        appearance: "dark",
      }).aurora.enabled,
      true
    );
  });

  test("normalizes invalid aurora values", () => {
    const config = normalizeAuroraConfig({
      enabled: "yes",
      presetId: "northern-lights",
      intensity: 400,
      speed: -12,
      blur: 12.6,
      reactToState: 1,
      customColors: ["#ff00aa", [9, 9], "nope"],
    });
    assert.equal(config.enabled, true);
    assert.equal(config.presetId, "borealis");
    assert.equal(config.intensity, 100);
    assert.equal(config.speed, 0);
    assert.equal(config.blur, 13);
    assert.equal(config.reactToState, true);
    assert.deepEqual(config.customColors[0], [255, 0, 170]);
  });

  test("preserves a custom preset and hex colors", () => {
    const parsed = parseAuroraHex("#1a2b3c");
    assert.deepEqual(parsed, [26, 43, 60]);
    const config = normalizeAuroraConfig({
      enabled: false,
      presetId: "custom",
      intensity: 20,
      speed: 10,
      blur: 80,
      reactToState: false,
      customColors: ["#112233", "#445566", "#778899"],
    });
    assert.equal(config.enabled, false);
    assert.equal(config.presetId, "custom");
    assert.deepEqual(config.customColors, [
      [17, 34, 51],
      [68, 85, 102],
      [119, 136, 153],
    ]);
  });

  test("resolves preset colors for light and dark", () => {
    const config = createDefaultAuroraConfig();
    assert.deepEqual(resolveAuroraPresetColors(config, true), AURORA_PRESETS.borealis.dark);
    assert.deepEqual(resolveAuroraPresetColors(config, false), AURORA_PRESETS.borealis.light);
    const custom = normalizeAuroraConfig({
      presetId: "custom",
      customColors: ["#010203", "#040506", "#070809"],
    });
    assert.deepEqual(resolveAuroraPresetColors(custom, true), [
      [1, 2, 3],
      [4, 5, 6],
      [7, 8, 9],
    ]);
  });
});
