import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
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
    const workbenchDir = join(process.cwd(), "apps/mobile/android/app/src/main/assets/workbench");
    // Resolve the entry bundle through index.html: Vite also emits lazily
    // loaded chunks named index-<hash>.js for dynamically imported index.ts
    // modules, so picking the first index-*.js in the directory is not enough.
    const indexHtml = readFileSync(join(workbenchDir, "index.html"), "utf8");
    const entryMatch = indexHtml.match(
      /<script[^>]*type="module"[^>]*src="\.\/(assets\/index-[^"]+\.js)"/
    );
    assert.ok(entryMatch, "expected index.html to reference a Vite index-*.js entry bundle");

    const source = readFileSync(join(workbenchDir, entryMatch[1]), "utf8");
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
