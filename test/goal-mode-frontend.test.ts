import assert from "node:assert/strict";
import { test } from "node:test";
import {
  coerceUnavailableGoalMode,
  filterGoalModeOptions,
  isGoalMode,
  resolveCanonicalModeId,
} from "../src/lib/chat-modes";
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

test("goal mode is a first-class mode id and accepts legacy burn alias", () => {
  assert.equal(isGoalMode("goal"), true);
  assert.equal(isGoalMode("burn"), true);
});

test("legacy burn options remap to goal", () => {
  assert.deepEqual(
    filterGoalModeOptions([
      { id: "agent" as const, label: "Agent" },
      { id: "burn" as const, label: "Burn" },
    ]).map((option) => option.id),
    ["agent", "goal"]
  );
  assert.deepEqual(
    filterGoalModeOptions([
      { id: "agent" as const, label: "Agent" },
      { id: "goal" as const, label: "Goal" },
      { id: "burn" as const, label: "Burn" },
    ]).map((option) => option.id),
    ["agent", "goal"]
  );
});

test("goal and burn resolve to native goal provider mode ids", () => {
  assert.equal(
    resolveCanonicalModeId("goal", [
      { id: "goal", label: "Goal" },
      { id: "agent", label: "Agent" },
    ]),
    "goal"
  );
  assert.equal(
    resolveCanonicalModeId("burn", [
      { id: "goal", label: "Goal" },
      { id: "agent", label: "Agent" },
    ]),
    "goal"
  );
  assert.equal(
    coerceUnavailableGoalMode("burn", [
      { id: "goal", label: "Goal" },
      { id: "agent", label: "Agent" },
    ]),
    "goal"
  );
});
