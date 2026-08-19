import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, test } from "node:test";
import { fileURLToPath } from "node:url";
import { shouldHardNavigateWorkbench } from "../src/components/landing/WorkbenchLink.tsx";
import { WORKSPACE_ROUTE } from "../src/lib/workbench-view.ts";

const landingPage = readFileSync(
  fileURLToPath(new URL("../src/components/landing/LandingPage.tsx", import.meta.url)),
  "utf8"
);

describe("landing workbench CTAs", () => {
  test("workbench route is the agent shell", () => {
    assert.equal(WORKSPACE_ROUTE, "/agent");
  });

  test("header, hero, closing CTA, and footer use WorkbenchLink", () => {
    const uses = landingPage.match(/<WorkbenchLink\b/g) ?? [];
    assert.equal(uses.length, 4);
    assert.match(landingPage, /Launch workbench/);
    assert.match(landingPage, /Launch the workbench/);
    assert.match(landingPage, /Open the workbench/);
    assert.doesNotMatch(landingPage, /href=\{WORKSPACE_ROUTE\}/);
  });
});

describe("shouldHardNavigateWorkbench", () => {
  const primary = {
    defaultPrevented: false,
    button: 0,
    metaKey: false,
    altKey: false,
    ctrlKey: false,
    shiftKey: false,
  };

  test("primary click hard-navigates to the workbench", () => {
    assert.equal(shouldHardNavigateWorkbench(primary), true);
  });

  test("modified or already-handled clicks keep the native href", () => {
    assert.equal(shouldHardNavigateWorkbench({ ...primary, defaultPrevented: true }), false);
    assert.equal(shouldHardNavigateWorkbench({ ...primary, button: 1 }), false);
    assert.equal(shouldHardNavigateWorkbench({ ...primary, metaKey: true }), false);
    assert.equal(shouldHardNavigateWorkbench({ ...primary, ctrlKey: true }), false);
    assert.equal(shouldHardNavigateWorkbench({ ...primary, shiftKey: true }), false);
    assert.equal(shouldHardNavigateWorkbench({ ...primary, altKey: true }), false);
  });
});
