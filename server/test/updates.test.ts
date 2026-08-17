import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { after, afterEach, describe, test } from "node:test";

const TEST_DATA_DIR = path.join(
  os.tmpdir(),
  `cesium-updates-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`
);

delete process.env.REDIS_URL;
delete process.env.DATABASE_URL;
delete process.env.OPENCURSOR_STORAGE_DRIVER;
delete process.env.CESIUM_HOME;
delete process.env.OPENCURSOR_DESKTOP_BACKEND;
delete process.env.CESIUM_INSTALL_KIND;
delete process.env.CESIUM_UPDATE_NPM_PACKAGE;
delete process.env.CESIUM_APP_VERSION;
process.env.OPENCURSOR_DATA_DIR = TEST_DATA_DIR;
process.env.NODE_ENV = "test";

const [semver, installKind, appVersion, feeds, manager, apply, updatesRoutesModule, metaModule] =
  await Promise.all([
    import("../src/lib/updates/semver.js"),
    import("../src/lib/updates/install-kind.js"),
    import("../src/lib/updates/app-version.js"),
    import("../src/lib/updates/feeds.js"),
    import("../src/lib/updates/update-manager.js"),
    import("../src/lib/updates/apply.js"),
    import("../src/routes/updates.js"),
    import("../src/routes/meta.js"),
  ]);

const { updateRoutes } = updatesRoutesModule;
const { metaRoutes } = metaModule;

const realFetch = globalThis.fetch;
const tempDirs: string[] = [];

after(async () => {
  globalThis.fetch = realFetch;
  await fs.rm(TEST_DATA_DIR, { recursive: true, force: true }).catch(() => {});
  for (const dir of tempDirs) {
    await fs.rm(dir, { recursive: true, force: true }).catch(() => {});
  }
});

afterEach(() => {
  globalThis.fetch = realFetch;
  delete process.env.CESIUM_INSTALL_KIND;
  delete process.env.CESIUM_UPDATE_NPM_PACKAGE;
  delete process.env.CESIUM_APP_VERSION;
  delete process.env.CESIUM_REPO_BRANCH;
  appVersion.resetCurrentVersionCacheForTests();
});

function mockFetch(handler: (url: string) => Response | Promise<Response>): void {
  globalThis.fetch = ((input: RequestInfo | URL, _init?: RequestInit) => {
    const url =
      typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    return Promise.resolve(handler(url));
  }) as typeof fetch;
}

function jsonResponse(payload: unknown, status = 200): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { "content-type": "application/json" },
  });
}

// ---------------------------------------------------------------------------
// semver
// ---------------------------------------------------------------------------

describe("semver", () => {
  test("parses plain and v-prefixed versions", () => {
    assert.deepEqual(semver.parseSemver("1.2.3")?.raw, "1.2.3");
    assert.deepEqual(semver.parseSemver("v0.4.0")?.minor, 4);
    assert.equal(semver.parseSemver("not-a-version"), null);
    assert.equal(semver.parseSemver("1.2"), null);
    const prerelease = semver.parseSemver("1.0.0-beta.2");
    assert.deepEqual(prerelease?.prerelease, ["beta", 2]);
  });

  test("orders release versions correctly", () => {
    assert.equal(semver.isNewerVersion("0.2.0", "0.1.0"), true);
    assert.equal(semver.isNewerVersion("0.1.0", "0.2.0"), false);
    assert.equal(semver.isNewerVersion("0.1.0", "0.1.0"), false);
    assert.equal(semver.isNewerVersion("1.0.0", "0.99.99"), true);
    assert.equal(semver.isNewerVersion("0.1.10", "0.1.9"), true);
  });

  test("applies prerelease precedence per the semver spec", () => {
    // Release > its own prerelease.
    assert.equal(semver.isNewerVersion("1.0.0", "1.0.0-rc.1"), true);
    assert.equal(semver.isNewerVersion("1.0.0-rc.1", "1.0.0"), false);
    // Numeric prerelease identifiers order numerically.
    assert.equal(semver.isNewerVersion("1.0.0-beta.11", "1.0.0-beta.2"), true);
    // alpha < beta lexically.
    assert.equal(semver.isNewerVersion("1.0.0-beta", "1.0.0-alpha"), true);
    // Longer prerelease chain wins over its prefix.
    assert.equal(semver.isNewerVersion("1.0.0-alpha.1", "1.0.0-alpha"), true);
    // Numeric identifiers rank below alphanumeric ones.
    assert.equal(semver.isNewerVersion("1.0.0-alpha", "1.0.0-1"), true);
  });

  test("treats unparseable input as not newer", () => {
    assert.equal(semver.isNewerVersion("garbage", "0.1.0"), false);
    assert.equal(semver.isNewerVersion("0.2.0", "garbage"), false);
  });
});

// ---------------------------------------------------------------------------
// install kind detection
// ---------------------------------------------------------------------------

describe("install kind detection", () => {
  test("explicit override wins", () => {
    assert.equal(
      installKind.detectInstallKind({ CESIUM_INSTALL_KIND: "desktop-electron" }),
      "desktop-electron"
    );
    // Invalid override falls through to detection.
    assert.equal(
      installKind.detectInstallKind({ CESIUM_INSTALL_KIND: "flying-toaster" }, os.tmpdir()),
      "unknown"
    );
  });

  test("desktop sidecar marker is detected", () => {
    assert.equal(
      installKind.detectInstallKind({ OPENCURSOR_DESKTOP_BACKEND: "1" }),
      "desktop-electron"
    );
  });

  test("installer-provisioned servers are detected via CESIUM_HOME", () => {
    assert.equal(
      installKind.detectInstallKind({ CESIUM_HOME: "/home/user/.cesium" }),
      "isolated-server"
    );
    assert.equal(
      installKind.detectInstallKind({
        CESIUM_HOME: "/data/data/com.termux/files/home/.cesium",
        TERMUX_VERSION: "0.118.0",
      }),
      "termux-server"
    );
    assert.equal(
      installKind.detectInstallKind({
        CESIUM_HOME: "/data/data/com.termux/files/home/.cesium",
        PREFIX: "/data/data/com.termux/files/usr",
      }),
      "termux-server"
    );
  });

  test("git checkout resolves to source, plain dirs to unknown", () => {
    assert.equal(installKind.detectInstallKind({}, path.resolve(process.cwd(), "..")), "source");
    assert.equal(installKind.detectInstallKind({}, os.tmpdir()), "unknown");
  });
});

// ---------------------------------------------------------------------------
// current version resolution
// ---------------------------------------------------------------------------

describe("current version resolution", () => {
  test("reads the server package.json version", () => {
    appVersion.resetCurrentVersionCacheForTests();
    const version = appVersion.resolveCurrentVersion();
    assert.ok(semver.parseSemver(version), `expected semver, got ${version}`);
  });

  test("CESIUM_APP_VERSION env overrides package.json", () => {
    process.env.CESIUM_APP_VERSION = "9.9.9";
    appVersion.resetCurrentVersionCacheForTests();
    assert.equal(appVersion.resolveCurrentVersion(), "9.9.9");
  });
});

// ---------------------------------------------------------------------------
// release feed parsing
// ---------------------------------------------------------------------------

const RELEASE_FIXTURE = [
  {
    tag_name: "mobile-v0.4.0",
    name: "Cesium Mobile 0.4.0",
    draft: false,
    prerelease: false,
    published_at: "2026-07-01T00:00:00Z",
    html_url: "https://github.com/example/cesium/releases/tag/mobile-v0.4.0",
    assets: [
      {
        name: "cesium-mobile-0.4.0.apk",
        size: 52_428_800,
        browser_download_url: "https://example.test/cesium-mobile-0.4.0.apk",
        content_type: "application/vnd.android.package-archive",
      },
    ],
  },
  {
    tag_name: "mobile-v0.3.0",
    draft: false,
    prerelease: false,
    published_at: "2026-05-01T00:00:00Z",
    assets: [],
  },
  {
    tag_name: "v0.2.0",
    name: "Cesium 0.2.0",
    draft: false,
    prerelease: false,
    published_at: "2026-08-01T00:00:00Z",
    body: "Unified release notes",
    assets: [],
  },
  {
    tag_name: "v0.3.0-rc.1",
    draft: false,
    prerelease: true,
    published_at: "2026-08-10T00:00:00Z",
    assets: [],
  },
  { tag_name: "v9.9.9", draft: true, prerelease: false, assets: [] },
  { tag_name: "weird-tag", draft: false, prerelease: false, assets: [] },
];

describe("GitHub release feed", () => {
  test("maps tags to channels with longest-prefix matching", () => {
    assert.deepEqual(feeds.channelForTag("v1.2.3"), { channel: "app", version: "1.2.3" });
    assert.deepEqual(feeds.channelForTag("mobile-v0.4.0"), {
      channel: "mobile",
      version: "0.4.0",
    });
    assert.deepEqual(feeds.channelForTag("desktop-v2.0.0"), {
      channel: "desktop",
      version: "2.0.0",
    });
    assert.deepEqual(feeds.channelForTag("server-v1.0.0"), {
      channel: "server",
      version: "1.0.0",
    });
    assert.equal(feeds.channelForTag("release-1.0"), null);
    assert.equal(feeds.channelForTag("v1.0"), null);
  });

  test("buckets releases per channel, skipping drafts and gating prereleases", () => {
    const stable = feeds.bucketGithubReleases(RELEASE_FIXTURE, {
      includePrereleases: false,
    });
    assert.equal(stable.mobile?.version, "0.4.0");
    assert.equal(stable.mobile?.assets[0]?.name, "cesium-mobile-0.4.0.apk");
    assert.equal(stable.app?.version, "0.2.0");
    assert.equal(stable.desktop, undefined);

    const withPre = feeds.bucketGithubReleases(RELEASE_FIXTURE, {
      includePrereleases: true,
    });
    assert.equal(withPre.app?.version, "0.3.0-rc.1");
    assert.equal(withPre.app?.prerelease, true);
  });

  test("fetch surfaces useful errors for missing repos and rate limits", async () => {
    mockFetch(() => jsonResponse({ message: "Not Found" }, 404));
    const notFound = await feeds.fetchGithubReleases({
      repo: "example/missing",
      token: null,
      includePrereleases: false,
    });
    assert.match(notFound.error ?? "", /not found|lacks access/i);

    mockFetch(() => jsonResponse({ message: "rate limited" }, 403));
    const limited = await feeds.fetchGithubReleases({
      repo: "example/limited",
      token: null,
      includePrereleases: false,
    });
    assert.match(limited.error ?? "", /rate limited/i);
  });

  test("fetch parses release payloads end to end", async () => {
    let sawAuth: string | null = null;
    globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
      const headers = new Headers(init?.headers);
      sawAuth = headers.get("authorization");
      void input;
      return Promise.resolve(jsonResponse(RELEASE_FIXTURE));
    }) as typeof fetch;
    const result = await feeds.fetchGithubReleases({
      repo: "example/cesium",
      token: "gh-test-token",
      includePrereleases: false,
    });
    assert.equal(result.error, null);
    assert.equal(result.channels.mobile?.tag, "mobile-v0.4.0");
    assert.equal(sawAuth, "Bearer gh-test-token");
  });
});

describe("npm feed", () => {
  test("reads dist-tags from the abbreviated packument", async () => {
    mockFetch((url) => {
      assert.match(url, /registry\.npmjs\.org\/@cesium%2Fserver/);
      return jsonResponse({ "dist-tags": { latest: "0.5.0" } });
    });
    const result = await feeds.fetchNpmLatestVersion({ packageName: "@cesium/server" });
    assert.equal(result.latestVersion, "0.5.0");
    assert.equal(result.error, null);
    assert.equal(feeds.isNpmUpdateAvailable(result.latestVersion, "0.1.0"), true);
    assert.equal(feeds.isNpmUpdateAvailable(result.latestVersion, "0.5.0"), false);
  });

  test("reports missing packages", async () => {
    mockFetch(() => jsonResponse({ error: "Not found" }, 404));
    const result = await feeds.fetchNpmLatestVersion({ packageName: "@cesium/nope" });
    assert.equal(result.latestVersion, null);
    assert.match(result.error ?? "", /not found/i);
  });
});

// ---------------------------------------------------------------------------
// update manager policy
// ---------------------------------------------------------------------------

describe("update manager policy", () => {
  test("primary channel per install kind", () => {
    assert.equal(manager.primaryChannelForInstallKind("desktop-electron"), "desktop");
    assert.equal(manager.primaryChannelForInstallKind("isolated-server"), "server");
    assert.equal(manager.primaryChannelForInstallKind("termux-server"), "server");
    assert.equal(manager.primaryChannelForInstallKind("source"), "server");
    assert.equal(manager.primaryChannelForInstallKind("unknown"), "server");
  });

  test("unified app releases cover channels without dedicated tags", () => {
    const appRelease = feeds.bucketGithubReleases(
      [{ tag_name: "v0.9.0", draft: false, prerelease: false, assets: [] }],
      { includePrereleases: false }
    );
    assert.equal(manager.resolveLatestForChannel(appRelease, "server")?.version, "0.9.0");

    const both = feeds.bucketGithubReleases(
      [
        { tag_name: "v0.9.0", draft: false, prerelease: false, assets: [] },
        { tag_name: "server-v1.0.0", draft: false, prerelease: false, assets: [] },
      ],
      { includePrereleases: false }
    );
    // Dedicated server tag is newer → it wins.
    assert.equal(manager.resolveLatestForChannel(both, "server")?.version, "1.0.0");
    // Mobile never falls back to unified app releases.
    assert.equal(manager.resolveLatestForChannel(appRelease, "mobile"), null);
  });

  test("self-update support matrix", () => {
    assert.deepEqual(manager.resolveSelfUpdateSupport("isolated-server").method, "cesium-server-cli");
    assert.deepEqual(manager.resolveSelfUpdateSupport("termux-server").method, "cesium-server-cli");
    assert.deepEqual(manager.resolveSelfUpdateSupport("source").method, "git-pull");
    assert.equal(manager.resolveSelfUpdateSupport("desktop-electron").supported, false);
    assert.equal(manager.resolveSelfUpdateSupport("unknown").supported, false);
  });
});

// ---------------------------------------------------------------------------
// routes + persistence
// ---------------------------------------------------------------------------

describe("update routes", () => {
  test("GET /api/updates/status returns the full payload shape", async () => {
    process.env.CESIUM_INSTALL_KIND = "unknown";
    const response = await updateRoutes.request("/api/updates/status");
    assert.equal(response.status, 200);
    const payload = (await response.json()) as Record<string, unknown>;
    assert.equal(payload.installKind, "unknown");
    assert.equal(typeof payload.currentVersion, "string");
    assert.equal(payload.primaryChannel, "server");
    assert.equal(typeof payload.settings, "object");
    assert.equal(payload.applying, false);
    assert.equal(
      (payload.selfUpdate as { supported: boolean }).supported,
      false
    );
  });

  test("POST /api/updates/check fetches feeds and persists results", async () => {
    process.env.CESIUM_INSTALL_KIND = "unknown";
    process.env.CESIUM_UPDATE_NPM_PACKAGE = "@cesium/server";
    process.env.CESIUM_APP_VERSION = "0.1.0";
    appVersion.resetCurrentVersionCacheForTests();
    mockFetch((url) => {
      if (url.includes("api.github.com")) return jsonResponse(RELEASE_FIXTURE);
      if (url.includes("registry.npmjs.org")) {
        return jsonResponse({ "dist-tags": { latest: "0.2.0" } });
      }
      throw new Error(`Unexpected fetch: ${url}`);
    });

    const response = await updateRoutes.request("/api/updates/check", { method: "POST" });
    assert.equal(response.status, 200);
    const payload = (await response.json()) as {
      lastCheckedAt: number | null;
      latest: { version: string } | null;
      updateAvailable: boolean;
      npm: { updateAvailable: boolean; latestVersion: string | null } | null;
      channels: Record<string, { version: string }>;
    };
    assert.ok(payload.lastCheckedAt);
    // Server channel falls back to the unified v0.2.0 release (> 0.1.0).
    assert.equal(payload.latest?.version, "0.2.0");
    assert.equal(payload.updateAvailable, true);
    assert.equal(payload.npm?.latestVersion, "0.2.0");
    assert.equal(payload.npm?.updateAvailable, true);
    assert.equal(payload.channels.mobile?.version, "0.4.0");

    // The check result must survive into the cached status endpoint.
    const statusResponse = await updateRoutes.request("/api/updates/status");
    const cached = (await statusResponse.json()) as { latest: { version: string } | null };
    assert.equal(cached.latest?.version, "0.2.0");

    // ...and onto disk for the next process.
    const raw = JSON.parse(
      await fs.readFile(path.join(TEST_DATA_DIR, "profile", "update-state.json"), "utf8")
    ) as { channels: Record<string, unknown> };
    assert.ok(raw.channels.mobile);
  });

  test("dismissing a version suppresses the update flag", async () => {
    process.env.CESIUM_INSTALL_KIND = "unknown";
    process.env.CESIUM_APP_VERSION = "0.1.0";
    appVersion.resetCurrentVersionCacheForTests();
    const response = await updateRoutes.request("/api/updates/settings", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ dismissedVersion: "0.2.0" }),
    });
    assert.equal(response.status, 200);
    const payload = (await response.json()) as {
      updateAvailable: boolean;
      settings: { dismissedVersion: string | null };
    };
    assert.equal(payload.settings.dismissedVersion, "0.2.0");
    assert.equal(payload.updateAvailable, false);

    // Clear the dismissal → the update surfaces again.
    const cleared = await updateRoutes.request("/api/updates/settings", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ dismissedVersion: null }),
    });
    const clearedPayload = (await cleared.json()) as { updateAvailable: boolean };
    assert.equal(clearedPayload.updateAvailable, true);
  });

  test("PUT /api/updates/settings rejects malformed bodies", async () => {
    const response = await updateRoutes.request("/api/updates/settings", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: "not-json",
    });
    assert.equal(response.status, 400);
  });

  test("POST /api/updates/apply refuses unsupported install kinds", async () => {
    process.env.CESIUM_INSTALL_KIND = "unknown";
    const response = await updateRoutes.request("/api/updates/apply", { method: "POST" });
    assert.equal(response.status, 400);
    const payload = (await response.json()) as { error: string };
    assert.match(payload.error, /no automated update path/i);

    process.env.CESIUM_INSTALL_KIND = "desktop-electron";
    const desktop = await updateRoutes.request("/api/updates/apply", { method: "POST" });
    assert.equal(desktop.status, 400);
  });

  test("GET /api/meta exposes the server version", async () => {
    const response = await metaRoutes.request("/api/meta");
    assert.equal(response.status, 200);
    const payload = (await response.json()) as {
      serverVersion?: string;
      capabilities: string[];
    };
    assert.ok(
      payload.serverVersion && semver.parseSemver(payload.serverVersion),
      `expected semver serverVersion, got ${payload.serverVersion}`
    );
    assert.ok(payload.capabilities.includes("updates"));
  });
});

// ---------------------------------------------------------------------------
// persisted state sanitization (schema drift across self-updates)
// ---------------------------------------------------------------------------

describe("persisted update state sanitization", () => {
  test("sanitizePersistedRelease coerces schema drift and drops junk", () => {
    // Release written by a build without the `assets` field.
    const legacy = manager.sanitizePersistedRelease(
      { channel: "server", tag: "server-v0.4.0", version: "0.4.0" },
      "server"
    );
    assert.ok(legacy);
    assert.deepEqual(legacy.assets, []);
    assert.equal(legacy.name, null);

    // Junk asset entries are dropped, valid ones normalized.
    const mixed = manager.sanitizePersistedRelease(
      {
        channel: "mobile",
        tag: "mobile-v0.5.0",
        version: "0.5.0",
        assets: [
          null,
          "garbage",
          { name: "app.apk", downloadUrl: "https://example.test/app.apk", size: "big" },
        ],
      },
      "mobile"
    );
    assert.equal(mixed?.assets.length, 1);
    assert.equal(mixed?.assets[0]?.name, "app.apk");
    assert.equal(mixed?.assets[0]?.size, 0);

    // Unusable releases are dropped instead of crashing clients later.
    assert.equal(manager.sanitizePersistedRelease(null, "app"), null);
    assert.equal(manager.sanitizePersistedRelease("v1.0.0", "app"), null);
    assert.equal(manager.sanitizePersistedRelease({ tag: "v1.0.0" }, "app"), null);
    // Unknown channel id falls back to the bucket it was stored under.
    assert.equal(
      manager.sanitizePersistedRelease(
        { channel: "flying-toaster", tag: "v1.0.0", version: "1.0.0" },
        "app"
      )?.channel,
      "app"
    );
  });

  test("a poisoned update-state.json no longer reaches the status payload", async () => {
    process.env.CESIUM_INSTALL_KIND = "termux-server";
    // Simulate state written by a divergent server build: one release missing
    // `assets` entirely, one that is not even an object.
    await fs.mkdir(path.join(TEST_DATA_DIR, "profile"), { recursive: true });
    await fs.writeFile(
      path.join(TEST_DATA_DIR, "profile", "update-state.json"),
      JSON.stringify({
        schemaVersion: 1,
        settings: { autoCheck: true, includePrereleases: false, dismissedVersion: null },
        lastCheckedAt: Date.now(),
        channels: {
          server: { channel: "server", tag: "server-v0.4.0", version: "0.4.0" },
          app: "corrupted-entry",
        },
        githubError: null,
        npm: null,
        git: null,
      })
    );
    manager.resetUpdateStateCacheForTests();

    const response = await updateRoutes.request("/api/updates/status");
    assert.equal(response.status, 200);
    const payload = (await response.json()) as {
      latest: { assets: unknown[] } | null;
      channels: Record<string, { assets: unknown[] } | undefined>;
    };
    // The assets-less release is served with a real (empty) assets array...
    assert.ok(Array.isArray(payload.channels.server?.assets));
    assert.deepEqual(payload.channels.server?.assets, []);
    assert.ok(Array.isArray(payload.latest?.assets));
    // ...and the corrupted channel entry is gone entirely.
    assert.equal(payload.channels.app, undefined);

    manager.resetUpdateStateCacheForTests();
  });
});

// ---------------------------------------------------------------------------
// git feed + git-pull self-update against a real local fixture repo
// ---------------------------------------------------------------------------

function git(args: string[], cwd: string): string {
  return execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
}

async function createGitFixture(): Promise<{ origin: string; clone: string; writer: string }> {
  const base = await fs.mkdtemp(path.join(os.tmpdir(), "cesium-update-git-"));
  tempDirs.push(base);
  const origin = path.join(base, "origin.git");
  const writer = path.join(base, "writer");
  const clone = path.join(base, "clone");
  await fs.mkdir(origin, { recursive: true });
  git(["init", "--bare", "--initial-branch=main", origin], base);
  git(["clone", origin, writer], base);
  git(["config", "user.email", "test@example.com"], writer);
  git(["config", "user.name", "Test"], writer);
  await fs.writeFile(path.join(writer, "README.md"), "hello\n");
  git(["add", "."], writer);
  git(["commit", "-m", "initial"], writer);
  git(["push", "origin", "main"], writer);
  git(["clone", origin, clone], base);
  git(["config", "user.email", "test@example.com"], clone);
  git(["config", "user.name", "Test"], clone);
  return { origin, clone, writer };
}

async function pushOriginCommit(writer: string, filename: string): Promise<void> {
  await fs.writeFile(path.join(writer, filename), `${Date.now()}\n`);
  git(["add", "."], writer);
  git(["commit", "-m", `update ${filename}`], writer);
  git(["push", "origin", "main"], writer);
}

describe("git-backed updates (local fixture)", () => {
  test("fetchGitUpdateStatus reports commits behind the remote", async () => {
    const { clone, writer } = await createGitFixture();
    const clean = await feeds.fetchGitUpdateStatus(clone);
    assert.equal(clean.error, null);
    assert.equal(clean.branch, "main");
    assert.equal(clean.behind, 0);
    assert.equal(clean.updateAvailable, false);

    await pushOriginCommit(writer, "one.txt");
    await pushOriginCommit(writer, "two.txt");
    const behind = await feeds.fetchGitUpdateStatus(clone);
    assert.equal(behind.error, null);
    assert.equal(behind.behind, 2);
    assert.equal(behind.updateAvailable, true);
    assert.notEqual(behind.commit, behind.remoteCommit);
  });

  test("applySelfUpdate fast-forwards a source checkout and reports restartRequired", async () => {
    const { clone, writer } = await createGitFixture();
    await pushOriginCommit(writer, "feature.txt");

    const events: Array<{ type: string; [key: string]: unknown }> = [];
    await apply.applySelfUpdate({
      installKind: "source",
      repoRoot: clone,
      emit: (event) => events.push(event as { type: string }),
    });

    const done = events.find((event) => event.type === "done") as
      | { ok: boolean; restartRequired: boolean }
      | undefined;
    assert.ok(done, `expected a done event, got ${JSON.stringify(events)}`);
    assert.equal(done.ok, true);
    assert.equal(done.restartRequired, true);
    assert.equal(events[0]?.type, "start");
    assert.ok(events.some((event) => event.type === "log"));
    // The working tree actually moved to the remote head.
    const localHead = git(["rev-parse", "HEAD"], clone);
    const remoteHead = git(["rev-parse", "HEAD"], writer);
    assert.equal(localHead, remoteHead);
  });

  test("applySelfUpdate is a no-op when already current", async () => {
    const { clone } = await createGitFixture();
    const events: Array<{ type: string; [key: string]: unknown }> = [];
    await apply.applySelfUpdate({
      installKind: "source",
      repoRoot: clone,
      emit: (event) => events.push(event as { type: string }),
    });
    const done = events.find((event) => event.type === "done") as
      | { ok: boolean; restartRequired: boolean }
      | undefined;
    assert.equal(done?.ok, true);
    assert.equal(done?.restartRequired, false);
  });

  test("applySelfUpdate refuses to clobber diverged checkouts", async () => {
    const { clone, writer } = await createGitFixture();
    // Local commit that the remote does not have + a newer remote commit.
    await fs.writeFile(path.join(clone, "local.txt"), "local change\n");
    git(["add", "."], clone);
    git(["commit", "-m", "local divergence"], clone);
    await pushOriginCommit(writer, "remote.txt");

    const events: Array<{ type: string; [key: string]: unknown }> = [];
    await apply.applySelfUpdate({
      installKind: "source",
      repoRoot: clone,
      emit: (event) => events.push(event as { type: string }),
    });
    const done = events.find((event) => event.type === "done") as
      | { ok: boolean; error?: string }
      | undefined;
    assert.equal(done?.ok, false);
    assert.match(done?.error ?? "", /fast-forward/i);
  });

  test("applySelfUpdate reports unsupported kinds through the event stream", async () => {
    const events: Array<{ type: string; [key: string]: unknown }> = [];
    await apply.applySelfUpdate({
      installKind: "unknown",
      emit: (event) => events.push(event as { type: string }),
    });
    const done = events[0] as { type: string; ok: boolean; error?: string };
    assert.equal(done.type, "done");
    assert.equal(done.ok, false);
    assert.match(done.error ?? "", /not supported|no automated/i);
  });
});
