import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, test } from "node:test";
import { fileURLToPath } from "node:url";
import {
  classifyReleaseAsset,
  formatAssetSize,
  parseGitHubRelease,
} from "../src/lib/releases.ts";
import { detectOs } from "../src/lib/platform-detect.ts";

const latestRoute = readFileSync(
  fileURLToPath(new URL("../src/app/api/releases/latest/route.ts", import.meta.url)),
  "utf8"
);
const downloadPage = readFileSync(
  fileURLToPath(new URL("../src/components/download/DownloadPage.tsx", import.meta.url)),
  "utf8"
);

const MB = 1024 * 1024;

function asset(name: string) {
  return classifyReleaseAsset({ name, url: `https://example.com/${name}`, sizeBytes: 10 * MB });
}

describe("classifyReleaseAsset", () => {
  test("classifies every artifact name the release workflow publishes", () => {
    assert.deepEqual(
      [
        asset("cesium-desktop-0.8.0-mac-arm64.dmg"),
        asset("cesium-desktop-0.8.0-mac-x64.zip"),
        asset("cesium-desktop-0.8.0-win-x64-setup.exe"),
        asset("cesium-desktop-0.8.0-win-arm64-setup.exe"),
        asset("cesium-desktop-0.8.0-linux-x64.AppImage"),
        asset("cesium-desktop-0.8.0-linux-arm64.deb"),
        asset("cesium-mobile-0.8.0.apk"),
        asset("cesium-wear-0.8.0.apk"),
      ].map((entry) => entry && { platform: entry.platform, arch: entry.arch, kind: entry.kind }),
      [
        { platform: "mac", arch: "arm64", kind: "dmg" },
        { platform: "mac", arch: "x64", kind: "zip" },
        { platform: "win", arch: "x64", kind: "exe" },
        { platform: "win", arch: "arm64", kind: "exe" },
        { platform: "linux", arch: "x64", kind: "appimage" },
        { platform: "linux", arch: "arm64", kind: "deb" },
        { platform: "android", arch: "universal", kind: "apk" },
        { platform: "wear", arch: "universal", kind: "apk" },
      ]
    );
  });

  test("handles prerelease version segments", () => {
    assert.equal(asset("cesium-desktop-0.9.0-rc.1-mac-arm64.dmg")?.platform, "mac");
  });

  test("rejects unknown artifacts", () => {
    assert.equal(asset("cesium-desktop-0.8.0-mac-arm64.blockmap"), null);
    assert.equal(asset("SHA256SUMS.txt"), null);
    assert.equal(asset("some-other-app-1.0.0-mac-arm64.dmg"), null);
  });
});

describe("parseGitHubRelease", () => {
  test("normalizes the GitHub releases/latest payload", () => {
    const catalog = parseGitHubRelease({
      tag_name: "v0.8.0",
      html_url: "https://github.com/BenItBuhner/Cesium/releases/tag/v0.8.0",
      published_at: "2026-08-01T00:00:00Z",
      assets: [
        {
          name: "cesium-desktop-0.8.0-mac-arm64.dmg",
          browser_download_url: "https://example.com/dmg",
          size: 120 * MB,
        },
        { name: "ignored.txt", browser_download_url: "https://example.com/txt", size: 1 },
        { name: 42, browser_download_url: "https://example.com/bad" },
      ],
    });
    assert.ok(catalog);
    assert.equal(catalog.version, "0.8.0");
    assert.equal(catalog.tag, "v0.8.0");
    assert.equal(catalog.assets.length, 1);
    assert.equal(catalog.assets[0].platform, "mac");
  });

  test("strips the mobile- tag prefix", () => {
    const catalog = parseGitHubRelease({ tag_name: "mobile-v0.8.1", assets: [] });
    assert.equal(catalog?.version, "0.8.1");
  });

  test("returns null for malformed payloads", () => {
    assert.equal(parseGitHubRelease(null), null);
    assert.equal(parseGitHubRelease("nope"), null);
    assert.equal(parseGitHubRelease({}), null);
  });
});

describe("latest-release catalog freshness", () => {
  test("API route never caches GitHub latest in the Next data cache", () => {
    const handler = latestRoute.slice(latestRoute.indexOf("export async function GET"));
    assert.match(latestRoute, /export const dynamic = "force-dynamic"/);
    assert.match(latestRoute, /export const revalidate = 0/);
    assert.match(handler, /cache: "no-store"/);
    assert.doesNotMatch(handler, /revalidate:\s*\d+/);
    assert.doesNotMatch(handler, /stale-while-revalidate/);
    assert.match(handler, /cache-control": "private, no-store, must-revalidate"/);
  });

  test("download page bypasses the browser HTTP cache for the catalog", () => {
    assert.match(downloadPage, /fetch\("\/api\/releases\/latest", \{ cache: "no-store" \}\)/);
  });
});

describe("formatAssetSize", () => {
  test("renders MB and GB", () => {
    assert.equal(formatAssetSize(120 * MB), "120 MB");
    assert.equal(formatAssetSize(1.5 * 1024 * MB), "1.5 GB");
    assert.equal(formatAssetSize(0), "");
  });
});

describe("detectOs", () => {
  const CHROME_MAC =
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36";
  const EDGE_WIN =
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36 Edg/126.0.0.0";
  const FIREFOX_LINUX = "Mozilla/5.0 (X11; Linux x86_64; rv:127.0) Gecko/20100101 Firefox/127.0";
  const CHROME_ANDROID =
    "Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Mobile Safari/537.36";
  const SAFARI_IPHONE =
    "Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1";

  test("classifies desktop browsers", () => {
    assert.equal(detectOs(CHROME_MAC, "macOS", 0), "mac");
    assert.equal(detectOs(EDGE_WIN, "Windows", 0), "win");
    assert.equal(detectOs(FIREFOX_LINUX, undefined, 0), "linux");
  });

  test("classifies mobile browsers", () => {
    assert.equal(detectOs(CHROME_ANDROID, "Android", 5), "android");
    assert.equal(detectOs(SAFARI_IPHONE, undefined, 5), "ios");
  });

  test("treats iPadOS-masquerading-as-Mac as iOS", () => {
    const SAFARI_IPAD =
      "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Safari/605.1.15";
    assert.equal(detectOs(SAFARI_IPAD, undefined, 5), "ios");
    assert.equal(detectOs(SAFARI_IPAD, undefined, 0), "mac");
  });
});
