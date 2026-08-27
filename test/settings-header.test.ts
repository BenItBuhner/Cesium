import assert from "node:assert/strict";
import test from "node:test";
import { resolveSettingsHeaderModel } from "../src/lib/settings-header";

test("top-level settings pages skip the crumb trail and label back as Agents", () => {
  const desktop = resolveSettingsHeaderModel([{ label: "Advanced" }], {
    isMobile: false,
    canCloseShell: true,
  });
  assert.ok(desktop);
  assert.equal(desktop.currentLabel, "Advanced");
  assert.equal(desktop.showTrail, false);
  assert.equal(desktop.backLabel, "Agents");
  assert.equal(desktop.backAriaLabel, "Back to Agents");

  const mobile = resolveSettingsHeaderModel([{ label: "Advanced" }], {
    isMobile: true,
    canCloseShell: true,
  });
  assert.ok(mobile);
  assert.equal(mobile.showTrail, false);
  assert.equal(mobile.backLabel, "Agents");
});

test("nested settings pages trail on desktop and back to the parent on mobile", () => {
  const segments = [
    { label: "Advanced", onClick: () => undefined },
    { label: "Storage" },
  ];
  const desktop = resolveSettingsHeaderModel(segments, {
    isMobile: false,
    canCloseShell: true,
  });
  assert.ok(desktop);
  assert.equal(desktop.showTrail, true);
  assert.deepEqual(
    desktop.ancestors.map((segment) => segment.label),
    ["Advanced"]
  );
  assert.equal(desktop.backLabel, "Advanced");

  const mobile = resolveSettingsHeaderModel(segments, {
    isMobile: true,
    canCloseShell: true,
  });
  assert.ok(mobile);
  assert.equal(mobile.showTrail, false);
  assert.equal(mobile.backLabel, "Advanced");
  assert.equal(mobile.currentLabel, "Storage");
});

test("empty segments and a missing close-shell hide the back label", () => {
  assert.equal(
    resolveSettingsHeaderModel([], { isMobile: true, canCloseShell: true }),
    null
  );
  const standalone = resolveSettingsHeaderModel([{ label: "General" }], {
    isMobile: true,
    canCloseShell: false,
  });
  assert.ok(standalone);
  assert.equal(standalone.backLabel, null);
});
