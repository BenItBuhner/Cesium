import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const manifestPath = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../android/app/src/main/AndroidManifest.xml"
);

function declaredPermissions(): string[] {
  const xml = readFileSync(manifestPath, "utf8");
  return [...xml.matchAll(/<uses-permission\s+android:name="([^"]+)"\s*\/>/g)].map(
    (match) => match[1]
  );
}

// WebView getUserMedia needs BOTH permissions: RECORD_AUDIO is the runtime
// grant the user sees, and MODIFY_AUDIO_SETTINGS is an install-time permission
// Chromium requires to open the audio source. Dropping either regresses voice
// input to "Could not start audio source" with no user-visible remedy.
test("manifest declares cesium://oauth deep links so OAuth can return to the app", () => {
  const xml = readFileSync(manifestPath, "utf8");
  assert.match(xml, /android:scheme="cesium" android:host="oauth"/);
});

test("manifest declares VIEW queries for http and https so OAuth can leave the app", () => {
  const xml = readFileSync(manifestPath, "utf8");
  assert.match(
    xml,
    /android.intent.action.VIEW[\s\S]*android.intent.category.BROWSABLE[\s\S]*android:scheme="https"/
  );
  assert.match(
    xml,
    /android.intent.action.VIEW[\s\S]*android.intent.category.BROWSABLE[\s\S]*android:scheme="http"/
  );
});

test("manifest declares the WebView microphone capture prerequisites", () => {
  const permissions = declaredPermissions();
  assert.ok(
    permissions.includes("android.permission.RECORD_AUDIO"),
    "android.permission.RECORD_AUDIO must be declared for voice input"
  );
  assert.ok(
    permissions.includes("android.permission.MODIFY_AUDIO_SETTINGS"),
    "android.permission.MODIFY_AUDIO_SETTINGS must be declared — WebView " +
      "audio capture fails with NotReadableError (Could not start audio " +
      "source) without it, even when RECORD_AUDIO is granted"
  );
});
