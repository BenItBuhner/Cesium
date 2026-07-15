import assert from "node:assert/strict";
import { test } from "node:test";
import {
  filterGoalModeOptions,
  isGoalMode,
  resolveCanonicalModeId,
} from "../src/lib/chat-modes";
import { createDefaultGlobalSettings, normalizeLoadedGlobalSettings } from "../src/lib/global-settings";

test("goal mode beta is disabled by default and normalizes persisted values", () => {
  assert.equal(createDefaultGlobalSettings().features.goalModeBeta, false);
  assert.equal(normalizeLoadedGlobalSettings({}).features.goalModeBeta, false);
  assert.equal(
    normalizeLoadedGlobalSettings({ schemaVersion: 1, features: { goalModeBeta: true } }).features.goalModeBeta,
    true
  );
});

test("synthetic goal mode is always filtered out", () => {
  const options = [
    { id: "agent" as const, label: "Agent" },
    { id: "goal" as const, label: "Goal" },
    { id: "burn" as const, label: "Burn" },
  ];
  assert.deepEqual(
    filterGoalModeOptions(options, false).map((option) => option.id),
    ["agent", "burn"]
  );
  assert.deepEqual(
    filterGoalModeOptions(options, true).map((option) => option.id),
    ["agent", "burn"]
  );
});

test("goal mode is no longer a burn alias", () => {
  assert.equal(isGoalMode("goal"), false);
  assert.equal(isGoalMode("burn"), true);
});

test("burn resolves only to native burn provider mode ids", () => {
  assert.equal(
    resolveCanonicalModeId("burn", [
      { id: "goal", label: "Goal" },
      { id: "burn", label: "Burn" },
      { id: "agent", label: "Agent" },
    ]),
    "burn"
  );
  assert.equal(
    resolveCanonicalModeId("goal", [
      { id: "burn", label: "Goal" },
      { id: "agent", label: "Agent" },
    ]),
    "agent"
  );
});
