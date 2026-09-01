import assert from "node:assert/strict";
import { describe, test } from "node:test";
import {
  installerButtonLabel,
  isUserFacingInstaller,
  pickRecommendedAsset,
  platformHeroLabel,
  userFacingAssets,
} from "../src/lib/download-assets.ts";
import { classifyReleaseAsset, parseGitHubRelease } from "../src/lib/releases.ts";

const MB = 1024 * 1024;

function asset(name: string) {
  const classified = classifyReleaseAsset({
    name,
    url: `https://example.com/${name}`,
    sizeBytes: 10 * MB,
  });
  assert.ok(classified);
  return classified;
}

const CATALOG = parseGitHubRelease({
  tag_name: "v0.9.0",
  html_url: "https://github.com/BenItBuhner/Cesium/releases/tag/v0.9.0",
  assets: [
    "cesium-desktop-0.9.0-mac-arm64.dmg",
    "cesium-desktop-0.9.0-mac-arm64.zip",
    "cesium-desktop-0.9.0-mac-x64.dmg",
    "cesium-desktop-0.9.0-mac-x64.zip",
    "cesium-desktop-0.9.0-win-x64-setup.exe",
    "cesium-desktop-0.9.0-linux-x64.AppImage",
    "cesium-desktop-0.9.0-linux-x64.deb",
    "cesium-mobile-0.9.0.apk",
    "cesium-wear-0.9.0.apk",
  ].map((name) => ({
    name,
    browser_download_url: `https://example.com/${name}`,
    size: 34 * MB,
  })),
});

describe("user-facing installers", () => {
  test("hides ZIP archives published for auto-update", () => {
    const zip = asset("cesium-desktop-0.9.0-mac-arm64.zip");
    const dmg = asset("cesium-desktop-0.9.0-mac-arm64.dmg");
    const deb = asset("cesium-desktop-0.9.0-linux-x64.deb");
    assert.equal(isUserFacingInstaller(zip), false);
    assert.equal(isUserFacingInstaller(deb), false);
    assert.equal(isUserFacingInstaller(dmg), true);
  });

  test("keeps the real installers: DMG, exe, AppImage, APK", () => {
    assert.ok(CATALOG);
    const visible = userFacingAssets(CATALOG.assets).map((entry) => entry.kind);
    assert.deepEqual(visible, ["dmg", "dmg", "exe", "appimage", "apk", "apk"]);
  });

  test("labels only what the visitor needs to choose", () => {
    assert.ok(CATALOG);
    const mac = userFacingAssets(CATALOG.assets, "mac");
    const linux = userFacingAssets(CATALOG.assets, "linux");
    const android = userFacingAssets(CATALOG.assets, "android");
    assert.equal(installerButtonLabel(mac[0]!, mac), "Apple silicon");
    assert.equal(installerButtonLabel(mac[1]!, mac), "Intel");
    assert.equal(installerButtonLabel(linux[0]!, linux), "Download");
    assert.equal(installerButtonLabel(android[0]!, android), "Download");
  });

  test("names Linux arch when both x64 and ARM AppImages ship", () => {
    const mixed = [
      asset("cesium-desktop-0.9.0-linux-x64.AppImage"),
      asset("cesium-desktop-0.9.0-linux-arm64.AppImage"),
    ];
    assert.equal(installerButtonLabel(mixed[0]!, mixed), "x64");
    assert.equal(installerButtonLabel(mixed[1]!, mixed), "ARM");
  });
});

describe("pickRecommendedAsset", () => {
  test("prefers the DMG over the ZIP on Mac", () => {
    assert.ok(CATALOG);
    const rec = pickRecommendedAsset(CATALOG, {
      os: "mac",
      arch: "arm64",
      archConfident: true,
    });
    assert.equal(rec?.label, "Mac");
    assert.equal(rec?.asset.kind, "dmg");
    assert.equal(rec?.asset.arch, "arm64");
  });

  test("prefers AppImage on Linux", () => {
    assert.ok(CATALOG);
    const rec = pickRecommendedAsset(CATALOG, {
      os: "linux",
      arch: "x64",
      archConfident: true,
    });
    assert.equal(rec?.label, "Linux");
    assert.equal(rec?.asset.kind, "appimage");
  });

  test("returns nothing for iOS — there is no signed build", () => {
    assert.ok(CATALOG);
    assert.equal(
      pickRecommendedAsset(CATALOG, { os: "ios", arch: null, archConfident: false }),
      null
    );
    assert.equal(platformHeroLabel("ios"), null);
  });
});
