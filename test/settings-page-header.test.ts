import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { resolveSettingsPageHeaderNav } from "../src/components/editor/settings-ui.tsx";

describe("resolveSettingsPageHeaderNav", () => {
  test("returns null for an empty trail", () => {
    assert.equal(resolveSettingsPageHeaderNav({ segments: [] }), null);
  });

  test("top-level pages back out of the settings shell", () => {
    const closeShell = () => undefined;
    const nav = resolveSettingsPageHeaderNav({
      segments: [{ label: "Advanced" }],
      closeShell,
    });
    assert.ok(nav);
    assert.equal(nav.currentLabel, "Advanced");
    assert.equal(nav.parentLabel, null);
    assert.equal(nav.backLabel, "Agents");
    assert.equal(nav.backTitle, "Back to Agents");
    assert.equal(nav.handleBack, closeShell);
  });

  test("nested pages back to the parent segment", () => {
    const openAdvanced = () => undefined;
    const nav = resolveSettingsPageHeaderNav({
      segments: [{ label: "Advanced", onClick: openAdvanced }, { label: "Updates" }],
    });
    assert.ok(nav);
    assert.equal(nav.currentLabel, "Updates");
    assert.equal(nav.parentLabel, "Advanced");
    assert.equal(nav.backLabel, "Advanced");
    assert.equal(nav.backTitle, "Back to Advanced");
    assert.equal(nav.handleBack, openAdvanced);
  });

  test("onBack overrides parent and close-shell targets", () => {
    const onBack = () => undefined;
    const nav = resolveSettingsPageHeaderNav({
      segments: [{ label: "Agents", onClick: () => undefined }, { label: "Cursor" }],
      onBack,
      closeShell: () => undefined,
    });
    assert.ok(nav);
    assert.equal(nav.handleBack, onBack);
    assert.equal(nav.backLabel, "Agents");
  });
});
