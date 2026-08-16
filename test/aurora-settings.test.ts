import assert from "node:assert/strict";
import { describe, test } from "node:test";
import {
  AURORA_PRESET_CATALOG,
  createDefaultGlobalSettings,
  normalizeAuroraSettings,
  normalizeLoadedGlobalSettings,
  resolveAuroraColors,
} from "../src/lib/global-settings.ts";

describe("aurora backdrop settings", () => {
  test("enabled by default with the aurora-borealis preset", () => {
    const settings = createDefaultGlobalSettings();
    assert.equal(settings.aurora.enabled, true);
    assert.equal(settings.aurora.preset, "aurora-borealis");
    assert.equal(settings.aurora.placement, "dynamic");
    assert.equal(settings.aurora.reactToActivity, true);
  });

  test("preserves an explicit placement and rejects unknown values", () => {
    assert.equal(normalizeAuroraSettings({ placement: "bottom" }).placement, "bottom");
    assert.equal(normalizeAuroraSettings({ placement: "full" }).placement, "full");
    assert.equal(normalizeAuroraSettings({ placement: "sideways" }).placement, "dynamic");
  });

  test("settings persisted before the aurora feature normalize to defaults", () => {
    const base = createDefaultGlobalSettings();
    const { aurora: _ignored, ...withoutAurora } = base;
    const settings = normalizeLoadedGlobalSettings(withoutAurora);
    assert.deepEqual(settings.aurora, base.aurora);
  });

  test("preserves an explicit disabled backdrop", () => {
    const base = createDefaultGlobalSettings();
    const settings = normalizeLoadedGlobalSettings({
      ...base,
      aurora: { ...base.aurora, enabled: false },
    });
    assert.equal(settings.aurora.enabled, false);
  });

  test("clamps intensity and speed to 0..100 integers", () => {
    const normalized = normalizeAuroraSettings({
      intensity: 240.7,
      speed: -3,
    });
    assert.equal(normalized.intensity, 100);
    assert.equal(normalized.speed, 0);
  });

  test("rejects unknown presets and malformed values", () => {
    const defaults = createDefaultGlobalSettings().aurora;
    const normalized = normalizeAuroraSettings({
      preset: "solar-flare",
      intensity: "loud",
      reactToActivity: "yes",
    });
    assert.equal(normalized.preset, defaults.preset);
    assert.equal(normalized.intensity, defaults.intensity);
    assert.equal(normalized.reactToActivity, defaults.reactToActivity);
  });

  test("filters invalid custom colors and falls back below the minimum", () => {
    const kept = normalizeAuroraSettings({
      preset: "custom",
      customColors: ["#22E0A6", "not-a-color", "#38bdf8", "#123"],
    });
    assert.deepEqual(kept.customColors, ["#22e0a6", "#38bdf8"]);

    const fallback = normalizeAuroraSettings({
      preset: "custom",
      customColors: ["#22e0a6"],
    });
    assert.deepEqual(
      fallback.customColors,
      createDefaultGlobalSettings().aurora.customColors
    );
  });

  test("caps custom colors at the maximum", () => {
    const normalized = normalizeAuroraSettings({
      customColors: ["#111111", "#222222", "#333333", "#444444", "#555555", "#666666"],
    });
    assert.equal(normalized.customColors.length, 5);
  });

  test("resolves preset colors from the catalog and custom colors from settings", () => {
    const base = createDefaultGlobalSettings().aurora;
    assert.deepEqual(
      resolveAuroraColors({ ...base, preset: "midnight-neon" }),
      AURORA_PRESET_CATALOG["midnight-neon"].colors
    );
    assert.deepEqual(
      resolveAuroraColors({
        ...base,
        preset: "custom",
        customColors: ["#101010", "#202020"],
      }),
      ["#101010", "#202020"]
    );
  });
});
