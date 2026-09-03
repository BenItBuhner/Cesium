/**
 * Fail a release (or a local check) when user-facing version strings diverge.
 *
 * The GitHub release workflow parses the tag (`v0.11.1` / `mobile-v0.11.1`) and
 * then requires every shipped surface to advertise that same version:
 *   - root + desktop + mobile package.json
 *   - Android phone + Wear OS versionName
 *   - iOS MARKETING_VERSION (Debug and Release)
 */

import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const DEFAULT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

/**
 * @param {string} filePath
 * @returns {string}
 */
export function readPackageVersion(filePath) {
  const parsed = JSON.parse(readFileSync(filePath, "utf8"));
  if (typeof parsed.version !== "string" || !parsed.version.trim()) {
    throw new Error(`${filePath} is missing a version string`);
  }
  return parsed.version.trim();
}

/**
 * @param {string} contents
 * @param {string} filePath
 * @returns {string}
 */
export function parseGradleVersionName(contents, filePath) {
  const match = contents.match(/versionName\s*=\s*"([^"]+)"/);
  if (!match) {
    throw new Error(`${filePath} is missing versionName`);
  }
  return match[1];
}

/**
 * @param {string} contents
 * @param {string} filePath
 * @returns {string[]}
 */
export function parsePbxprojMarketingVersions(contents, filePath) {
  const matches = [...contents.matchAll(/MARKETING_VERSION\s*=\s*([^;]+);/g)].map((m) =>
    m[1].trim()
  );
  if (matches.length === 0) {
    throw new Error(`${filePath} is missing MARKETING_VERSION`);
  }
  return matches;
}

/**
 * @param {string} [rootDir]
 * @returns {Record<string, string | string[]>}
 */
export function collectReleaseVersions(rootDir = DEFAULT_ROOT) {
  const androidAppPath = path.join(rootDir, "apps/mobile/android/app/build.gradle");
  const androidWearPath = path.join(rootDir, "apps/mobile/android/wear/build.gradle");
  const iosPbxprojPath = path.join(
    rootDir,
    "apps/mobile/ios/CesiumMobile.xcodeproj/project.pbxproj"
  );

  return {
    root: readPackageVersion(path.join(rootDir, "package.json")),
    cli: readPackageVersion(path.join(rootDir, "packages/cli/package.json")),
    desktop: readPackageVersion(path.join(rootDir, "apps/desktop/package.json")),
    mobile: readPackageVersion(path.join(rootDir, "apps/mobile/package.json")),
    androidApp: parseGradleVersionName(readFileSync(androidAppPath, "utf8"), androidAppPath),
    androidWear: parseGradleVersionName(readFileSync(androidWearPath, "utf8"), androidWearPath),
    iosMarketing: parsePbxprojMarketingVersions(readFileSync(iosPbxprojPath, "utf8"), iosPbxprojPath),
  };
}

/**
 * @param {string} expected
 * @param {ReturnType<typeof collectReleaseVersions>} versions
 * @returns {string[]}
 */
export function findReleaseVersionMismatches(expected, versions) {
  /** @type {string[]} */
  const mismatches = [];
  const scalarEntries = [
    ["root package.json", versions.root],
    ["packages/cli/package.json", versions.cli],
    ["apps/desktop/package.json", versions.desktop],
    ["apps/mobile/package.json", versions.mobile],
    ["Android phone versionName", versions.androidApp],
    ["Wear OS versionName", versions.androidWear],
  ];

  for (const [label, value] of scalarEntries) {
    if (value !== expected) {
      mismatches.push(`${label}: ${value} (expected ${expected})`);
    }
  }

  const iosVersions = Array.isArray(versions.iosMarketing)
    ? versions.iosMarketing
    : [versions.iosMarketing];
  for (const [index, value] of iosVersions.entries()) {
    if (value !== expected) {
      mismatches.push(`iOS MARKETING_VERSION[${index}]: ${value} (expected ${expected})`);
    }
  }

  return mismatches;
}

/**
 * @param {string} expected
 * @param {string} [rootDir]
 */
export function assertReleaseVersions(expected, rootDir = DEFAULT_ROOT) {
  if (!expected) {
    throw new Error("Expected a release version (e.g. 0.11.1)");
  }
  const mismatches = findReleaseVersionMismatches(expected, collectReleaseVersions(rootDir));
  if (mismatches.length > 0) {
    throw new Error(`Release version ${expected} is not aligned:\n- ${mismatches.join("\n- ")}`);
  }
}

const invokedDirectly = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (invokedDirectly) {
  const expected = process.argv[2]?.trim();
  if (!expected) {
    console.error("Usage: node scripts/assert-release-versions.mjs <version>");
    process.exit(1);
  }
  try {
    assertReleaseVersions(expected);
    console.log(`Release versions aligned at ${expected}`);
  } catch (error) {
    console.error(error instanceof Error ? error.message : error);
    process.exit(1);
  }
}
