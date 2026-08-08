import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, describe, test } from "node:test";

process.env.OPENCURSOR_DATA_DIR = path.join(
  os.tmpdir(),
  `cesium-quick-actions-test-${Date.now()}-${randomUUID().slice(0, 8)}`
);

// Static imports would hoist above the env assignment and resolve DATA_DIR to
// the real profile directory; import after the env is set instead.
const {
  findEffectiveQuickAction,
  normalizeQuickActionDefinition,
  normalizeQuickActionsConfig,
  QUICK_ACTION_PRESETS,
  resolveEffectiveQuickActions,
} = await import("@cesium/core/quick-actions");
const {
  getQuickActionsConfig,
  removeCustomQuickAction,
  setQuickActionPresetStates,
  upsertCustomQuickAction,
} = await import("../src/lib/quick-actions-store.js");

after(async () => {
  await fs.rm(process.env.OPENCURSOR_DATA_DIR!, { recursive: true, force: true });
});

describe("quick action normalization", () => {
  test("rejects definitions missing the payload for their kind", () => {
    assert.equal(
      normalizeQuickActionDefinition({ id: "a", label: "A", kind: "command" }),
      null
    );
    assert.equal(
      normalizeQuickActionDefinition({ id: "a", label: "A", kind: "prompt", prompt: " " }),
      null
    );
    assert.equal(
      normalizeQuickActionDefinition({ id: "a", label: "A", kind: "ui", uiCommand: "nope" }),
      null
    );
  });

  test("normalizes valid definitions with defaults", () => {
    const action = normalizeQuickActionDefinition({
      id: "deploy",
      label: "Deploy",
      kind: "command",
      command: "npm run deploy",
      visibility: "bogus",
    });
    assert.ok(action);
    assert.equal(action.visibility, "always");
    assert.equal(action.enabled, true);
    assert.equal(action.showPill, true);
    assert.equal(action.confirm, false);
  });

  test("config normalization drops unknown presets and duplicate ids", () => {
    const config = normalizeQuickActionsConfig({
      schemaVersion: 1,
      presetStates: { "push-branch": false, "not-a-preset": true },
      customActions: [
        { id: "x", label: "X", kind: "command", command: "echo 1" },
        { id: "x", label: "X duplicate", kind: "command", command: "echo 2" },
        { id: "", label: "invalid", kind: "command", command: "echo" },
      ],
    });
    assert.deepEqual(config.presetStates, { "push-branch": false });
    assert.equal(config.customActions.length, 1);
    assert.equal(config.customActions[0]?.label, "X");
  });

  test("effective actions honor preset defaults and overrides", () => {
    const defaults = normalizeQuickActionsConfig({});
    const effective = resolveEffectiveQuickActions(defaults);
    const defaultOnCount = QUICK_ACTION_PRESETS.filter((preset) => preset.defaultEnabled).length;
    assert.equal(effective.length, defaultOnCount);
    assert.ok(effective.some((action) => action.presetId === "fix-merge-conflicts"));

    const withOverride = normalizeQuickActionsConfig({
      schemaVersion: 1,
      presetStates: { "fix-merge-conflicts": false, "run-tests": true },
      customActions: [],
    });
    const overridden = resolveEffectiveQuickActions(withOverride);
    assert.ok(!overridden.some((action) => action.presetId === "fix-merge-conflicts"));
    assert.ok(overridden.some((action) => action.presetId === "run-tests"));
  });

  test("findEffectiveQuickAction resolves presets and disabled actions", () => {
    const config = normalizeQuickActionsConfig({
      schemaVersion: 1,
      presetStates: { "run-tests": true },
      customActions: [
        {
          id: "off",
          label: "Off",
          kind: "command",
          command: "echo off",
          enabled: false,
        },
      ],
    });
    assert.ok(findEffectiveQuickAction(config, "preset:run-tests"));
    assert.equal(findEffectiveQuickAction(config, "preset:unknown"), null);
    assert.equal(findEffectiveQuickAction(config, "off"), null);
  });
});

describe("quick actions store", () => {
  test("round-trips custom actions and preset states through the profile file", async () => {
    const initial = await getQuickActionsConfig();
    assert.deepEqual(initial.customActions, []);

    const saved = await upsertCustomQuickAction({
      id: "deploy-preview",
      label: "Deploy preview",
      kind: "command",
      command: "npm run deploy:preview",
      visibility: "dirty",
      confirm: true,
      keybinding: "Mod+Alt+D",
    });
    assert.equal(saved.id, "deploy-preview");
    assert.equal(saved.confirm, true);

    await setQuickActionPresetStates({ "push-branch": false, unknown: true });

    const loaded = await getQuickActionsConfig();
    assert.equal(loaded.customActions.length, 1);
    assert.equal(loaded.customActions[0]?.keybinding, "Mod+Alt+D");
    assert.deepEqual(loaded.presetStates, { "push-branch": false });

    // Updating keeps createdAt but refreshes updatedAt.
    const updated = await upsertCustomQuickAction({
      id: "deploy-preview",
      label: "Deploy preview v2",
      kind: "command",
      command: "npm run deploy:preview -- --fresh",
    });
    assert.equal(updated.createdAt, saved.createdAt);
    assert.ok(updated.updatedAt >= saved.updatedAt);

    assert.equal(await removeCustomQuickAction("deploy-preview"), true);
    assert.equal(await removeCustomQuickAction("deploy-preview"), false);
    const emptied = await getQuickActionsConfig();
    assert.deepEqual(emptied.customActions, []);
  });

  test("rejects reserved preset ids and invalid payloads", async () => {
    await assert.rejects(
      upsertCustomQuickAction({
        id: "preset:sneaky",
        label: "Sneaky",
        kind: "command",
        command: "echo hi",
      }),
      /reserved/
    );
    await assert.rejects(
      upsertCustomQuickAction({ id: "no-payload", label: "Nope", kind: "prompt" }),
      /Invalid quick action/
    );
  });
});
