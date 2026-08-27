import assert from "node:assert/strict";
import { describe, test } from "node:test";
import {
  isSetupStepLocked,
  setupStepRequiresEngine,
  visibleSetupSteps,
  type PlatformSetupProfile,
} from "../src/lib/onboarding/platform.ts";

const WEB: PlatformSetupProfile = {
  platform: "web",
  steps: ["connect-server", "agents", "import", "first-chat"],
  serverConnection: "step",
};

const DESKTOP: PlatformSetupProfile = {
  platform: "desktop",
  steps: ["agents", "import", "first-chat"],
  serverConnection: "footnote",
};

describe("setup step gating", () => {
  test("agents, import, and first chat require an engine", () => {
    assert.equal(setupStepRequiresEngine("connect-server"), false);
    assert.equal(setupStepRequiresEngine("agents"), true);
    assert.equal(setupStepRequiresEngine("import"), true);
    assert.equal(setupStepRequiresEngine("first-chat"), true);
  });

  test("web first-run only shows the server step until an engine is attached", () => {
    assert.deepEqual(visibleSetupSteps(WEB, false), ["connect-server"]);
    assert.deepEqual(visibleSetupSteps(WEB, true), WEB.steps);
    assert.equal(
      isSetupStepLocked("agents", { profile: WEB, engineConnected: false }),
      true
    );
    assert.equal(
      isSetupStepLocked("agents", { profile: WEB, engineConnected: true }),
      false
    );
  });

  test("desktop keeps later steps available because the engine is embedded", () => {
    assert.deepEqual(visibleSetupSteps(DESKTOP, false), DESKTOP.steps);
    assert.equal(
      isSetupStepLocked("agents", { profile: DESKTOP, engineConnected: false }),
      false
    );
  });
});
