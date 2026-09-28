import assert from "node:assert/strict";
import { test } from "node:test";
import { createDefaultGlobalSettings, normalizeLoadedGlobalSettings } from "../src/lib/global-settings";

test("global settings ignore legacy goal feature flags", () => {
  const legacyGoalFeatureKey = ["goal", "Mode", "Beta"].join("");
  const defaults = createDefaultGlobalSettings();
  const normalized = normalizeLoadedGlobalSettings({
    schemaVersion: 1,
    features: {
      vscodeExtensionsBeta: true,
      [legacyGoalFeatureKey]: true,
    },
  });

  assert.equal(defaults.features.vscodeExtensionsBeta, false);
  assert.equal(normalized.features.vscodeExtensionsBeta, true);
  assert.equal(legacyGoalFeatureKey in defaults.features, false);
  assert.equal(legacyGoalFeatureKey in normalized.features, false);
});
