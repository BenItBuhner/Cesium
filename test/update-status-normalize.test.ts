import assert from "node:assert/strict";
import { describe, test } from "node:test";
import {
  normalizeUpdateRelease,
  normalizeUpdateStatusPayload,
} from "../packages/client/src/update-status.ts";

describe("normalizeUpdateRelease", () => {
  test("keeps a fully-formed release intact", () => {
    const release = normalizeUpdateRelease({
      channel: "mobile",
      tag: "mobile-v0.5.0",
      version: "0.5.0",
      name: "Cesium Mobile 0.5.0",
      prerelease: false,
      publishedAt: "2026-08-01T00:00:00Z",
      htmlUrl: "https://example.test/releases/mobile-v0.5.0",
      notes: "notes",
      assets: [
        {
          name: "app.apk",
          size: 1024,
          downloadUrl: "https://example.test/app.apk",
          contentType: "application/vnd.android.package-archive",
        },
      ],
    });
    assert.ok(release);
    assert.equal(release.channel, "mobile");
    assert.equal(release.assets.length, 1);
    assert.equal(release.assets[0]?.size, 1024);
  });

  test("coerces a release missing assets to an empty array", () => {
    const release = normalizeUpdateRelease({
      channel: "server",
      tag: "server-v0.4.0",
      version: "0.4.0",
    });
    assert.ok(release);
    assert.deepEqual(release.assets, []);
    assert.equal(release.name, null);
    assert.equal(release.prerelease, false);
  });

  test("drops releases without a usable tag or version", () => {
    assert.equal(normalizeUpdateRelease(null), null);
    assert.equal(normalizeUpdateRelease("v1.0.0"), null);
    assert.equal(normalizeUpdateRelease({ tag: "v1.0.0" }), null);
    assert.equal(normalizeUpdateRelease({ version: "1.0.0" }), null);
  });

  test("filters malformed asset entries", () => {
    const release = normalizeUpdateRelease({
      channel: "app",
      tag: "v1.0.0",
      version: "1.0.0",
      assets: [
        null,
        42,
        { name: "no-url.zip" },
        { name: "ok.zip", downloadUrl: "https://example.test/ok.zip", size: "NaN" },
      ],
    });
    assert.equal(release?.assets.length, 1);
    assert.equal(release?.assets[0]?.name, "ok.zip");
    assert.equal(release?.assets[0]?.size, 0);
  });
});

describe("normalizeUpdateStatusPayload", () => {
  test("survives a completely garbage payload", () => {
    for (const garbage of [null, undefined, "nope", 42, []]) {
      const payload = normalizeUpdateStatusPayload(garbage);
      assert.equal(payload.installKind, "unknown");
      assert.equal(payload.latest, null);
      assert.deepEqual(payload.channels, {});
      assert.equal(payload.selfUpdate.supported, false);
      assert.equal(payload.settings.autoCheck, true);
      assert.equal(payload.applying, false);
    }
  });

  test("sanitizes a payload with schema drift in every risky field", () => {
    const payload = normalizeUpdateStatusPayload({
      currentVersion: "0.5.0",
      installKind: "termux-server",
      primaryChannel: "server",
      updateAvailable: "yes",
      latest: { channel: "server", tag: "server-v0.6.0", version: "0.6.0" },
      channels: {
        server: { channel: "server", tag: "server-v0.6.0", version: "0.6.0" },
        app: "corrupted",
        desktop: { tag: "desktop-v1.0.0" },
      },
      npm: "not-an-object",
      git: { updateAvailable: 1 },
      selfUpdate: { supported: true, method: "teleport" },
      settings: { autoCheck: "sure" },
      lastCheckedAt: "recently",
      applying: null,
    });
    assert.equal(payload.installKind, "termux-server");
    // Releases missing assets render safely.
    assert.deepEqual(payload.latest?.assets, []);
    assert.deepEqual(payload.channels.server?.assets, []);
    // Broken channel entries are dropped rather than served.
    assert.equal(payload.channels.app, undefined);
    assert.equal(payload.channels.desktop, undefined);
    assert.equal(payload.npm, null);
    assert.equal(payload.git?.updateAvailable, false);
    assert.equal(payload.selfUpdate.supported, true);
    assert.equal(payload.selfUpdate.method, null);
    assert.equal(payload.settings.autoCheck, true);
    assert.equal(payload.lastCheckedAt, null);
    assert.equal(payload.updateAvailable, false);
    assert.equal(payload.applying, false);
  });

  test("passes a healthy payload through unchanged", () => {
    const healthy = {
      currentVersion: "0.5.0",
      protocolVersion: "1",
      installKind: "termux-server",
      githubRepo: "example/cesium",
      githubError: null,
      primaryChannel: "server",
      updateAvailable: true,
      latest: {
        channel: "server",
        tag: "server-v0.6.0",
        version: "0.6.0",
        name: null,
        prerelease: false,
        publishedAt: null,
        htmlUrl: null,
        notes: null,
        assets: [],
      },
      channels: {
        server: {
          channel: "server",
          tag: "server-v0.6.0",
          version: "0.6.0",
          name: null,
          prerelease: false,
          publishedAt: null,
          htmlUrl: null,
          notes: null,
          assets: [],
        },
      },
      npm: null,
      git: null,
      selfUpdate: { supported: true, method: "cesium-server-cli", reason: null },
      settings: { autoCheck: true, includePrereleases: false, dismissedVersion: null },
      lastCheckedAt: 1755400000000,
      applying: false,
    };
    assert.deepEqual(normalizeUpdateStatusPayload(healthy), healthy);
  });
});
