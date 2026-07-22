import assert from "node:assert/strict";
import { test } from "node:test";
import {
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

  assert.deepEqual(defaults.features, { vscodeExtensionsBeta: false });
  assert.deepEqual(normalized.features, { vscodeExtensionsBeta: true });
});

test("goal mode is a first-class mode id", () => {
  assert.equal(isGoalMode("goal"), true);
});

test("goal resolves to native goal provider mode ids", () => {
  assert.equal(
    resolveCanonicalModeId("goal", [
      { id: "goal", label: "Goal" },
      { id: "agent", label: "Agent" },
    ]),
    "goal"
  );
  assert.equal(
    resolveCanonicalModeId("goal", [
      { id: "agent", label: "Agent" },
    ]),
    "agent"
  );
});
