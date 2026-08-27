import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  assertReleaseVersions,
  collectReleaseVersions,
  findReleaseVersionMismatches,
  parseGradleVersionName,
  parsePbxprojMarketingVersions,
} from "../scripts/assert-release-versions.mjs";

const RELEASE_VERSION = "0.9.0";

test("shipped package, Android, and iOS versions all advertise 0.9.0", () => {
  const versions = collectReleaseVersions();
  assert.deepEqual(findReleaseVersionMismatches(RELEASE_VERSION, versions), []);
  assert.doesNotThrow(() => assertReleaseVersions(RELEASE_VERSION));
});

test("parseGradleVersionName reads the quoted versionName", () => {
  assert.equal(
    parseGradleVersionName('    versionName = "0.8.0"\n', "app/build.gradle"),
    "0.8.0"
  );
  assert.throws(() => parseGradleVersionName("versionCode = 13\n", "app/build.gradle"));
});

test("parsePbxprojMarketingVersions reads every MARKETING_VERSION assignment", () => {
  const contents = `
    MARKETING_VERSION = 0.8.0;
    MARKETING_VERSION = 0.8.0;
  `;
  assert.deepEqual(parsePbxprojMarketingVersions(contents, "project.pbxproj"), ["0.8.0", "0.8.0"]);
});

test("findReleaseVersionMismatches reports each drifted surface", () => {
  const mismatches = findReleaseVersionMismatches("0.8.0", {
    root: "0.8.0",
    cli: "0.6.0",
    desktop: "0.1.0",
    mobile: "0.7.0",
    androidApp: "0.8.0",
    androidWear: "0.8.0",
    iosMarketing: ["0.8.0", "0.7.0"],
  });
  assert.deepEqual(mismatches, [
    "packages/cli/package.json: 0.6.0 (expected 0.8.0)",
    "apps/desktop/package.json: 0.1.0 (expected 0.8.0)",
    "apps/mobile/package.json: 0.7.0 (expected 0.8.0)",
    "iOS MARKETING_VERSION[1]: 0.7.0 (expected 0.8.0)",
  ]);
});

test("assertReleaseVersions reads a fixture tree", () => {
  const root = mkdtempSync(join(tmpdir(), "cesium-release-versions-"));
  try {
    mkdirSync(join(root, "apps/desktop"), { recursive: true });
    mkdirSync(join(root, "apps/mobile/android/app"), { recursive: true });
    mkdirSync(join(root, "apps/mobile/android/wear"), { recursive: true });
    mkdirSync(join(root, "apps/mobile/ios/CesiumMobile.xcodeproj"), { recursive: true });
    mkdirSync(join(root, "packages/cli"), { recursive: true });
    writeFileSync(join(root, "package.json"), JSON.stringify({ version: "1.2.3" }));
    writeFileSync(join(root, "packages/cli/package.json"), JSON.stringify({ version: "1.2.3" }));
    writeFileSync(join(root, "apps/desktop/package.json"), JSON.stringify({ version: "1.2.3" }));
    writeFileSync(join(root, "apps/mobile/package.json"), JSON.stringify({ version: "1.2.3" }));
    writeFileSync(
      join(root, "apps/mobile/android/app/build.gradle"),
      '    versionName = "1.2.3"\n'
    );
    writeFileSync(
      join(root, "apps/mobile/android/wear/build.gradle"),
      '    versionName = "1.2.3"\n'
    );
    writeFileSync(
      join(root, "apps/mobile/ios/CesiumMobile.xcodeproj/project.pbxproj"),
      "MARKETING_VERSION = 1.2.3;\nMARKETING_VERSION = 1.2.3;\n"
    );
    assert.doesNotThrow(() => assertReleaseVersions("1.2.3", root));
    assert.throws(() => assertReleaseVersions("9.9.9", root), /not aligned/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
