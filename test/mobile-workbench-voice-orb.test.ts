import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, test } from "node:test";

/**
 * The Android app ships a prebuilt Vite workbench under
 * apps/mobile/android/app/src/main/assets/workbench. That bundle must include
 * the Settings → General → Voice orb opt-in gate; otherwise the floating mic
 * orb is always mounted (as happened when 0.3.0 shipped voice before the gate).
 */
describe("mobile workbench voice orb gate", () => {
  test("bundled workbench defaults showVoiceOrb off and reads the setting", () => {
    const assetsDir = join(
      process.cwd(),
      "apps/mobile/android/app/src/main/assets/workbench/assets"
    );
    const chunks = readdirSync(assetsDir).filter((name) => name.endsWith(".js"));
    assert.ok(
      chunks.some((name) => name.startsWith("index-")),
      "expected a Vite index-*.js workbench bundle"
    );

    // The workbench is code-split (the settings surface, editor and terminal
    // load on demand), so the gate's pieces can live in different chunks.
    const source = chunks.map((name) => readFileSync(join(assetsDir, name), "utf8")).join("\n");
    assert.match(
      source,
      /showVoiceOrb:!1/,
      "bundle must default showVoiceOrb to false"
    );
    assert.match(
      source,
      /general\.showVoiceOrb/,
      "bundle must gate the orb on settings.general.showVoiceOrb"
    );
    assert.match(
      source,
      /searchId:"show-voice-orb"/,
      "bundle must expose the Settings → General → Voice orb toggle"
    );
  });
});
