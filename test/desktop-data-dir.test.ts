import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { resolvePackagedDesktopDataDir } from "../apps/desktop/src/desktop-data-dir.mjs";

test("resolvePackagedDesktopDataDir migrates legacy server-data profile to canonical data dir", () => {
  const root = mkdtempSync(join(tmpdir(), "cesium-data-dir-"));
  const localAppData = join(root, "Local");
  const userDataPath = join(root, "Roaming", "Cesium Desktop");
  const legacyDir = join(userDataPath, "server-data");
  const canonicalDir = join(localAppData, "Cesium", "data");

  mkdirSync(join(legacyDir, "profile"), { recursive: true });
  writeFileSync(
    join(legacyDir, "profile", "global-settings.json"),
    JSON.stringify({ themeConfig: { appearance: "system" } })
  );

  try {
    const resolved = resolvePackagedDesktopDataDir(userDataPath, {
      platform: "win32",
      env: { LOCALAPPDATA: localAppData },
    });
    assert.equal(resolved, canonicalDir);
    assert.equal(
      readFileSync(join(canonicalDir, "profile", "global-settings.json"), "utf8"),
      JSON.stringify({ themeConfig: { appearance: "system" } })
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("resolvePackagedDesktopDataDir prefers richer legacy desktop profile when both exist", () => {
  const root = mkdtempSync(join(tmpdir(), "cesium-data-dir-"));
  const localAppData = join(root, "Local");
  const userDataPath = join(root, "Roaming", "Cesium Desktop");
  const legacyDir = join(userDataPath, "server-data");
  const canonicalDir = join(localAppData, "Cesium", "data");

  mkdirSync(join(canonicalDir, "profile"), { recursive: true });
  writeFileSync(join(canonicalDir, "profile", "global-settings.json"), '{"small":true}');
  mkdirSync(join(legacyDir, "profile"), { recursive: true });
  writeFileSync(
    join(legacyDir, "profile", "global-settings.json"),
    JSON.stringify({ themeConfig: { appearance: "system" }, desktop: true, extra: "x".repeat(4096) })
  );

  try {
    const resolved = resolvePackagedDesktopDataDir(userDataPath, {
      platform: "win32",
      env: { LOCALAPPDATA: localAppData },
    });
    assert.equal(resolved, canonicalDir);
    const merged = JSON.parse(
      readFileSync(join(canonicalDir, "profile", "global-settings.json"), "utf8")
    );
    assert.equal(merged.desktop, true);
    assert.equal(merged.themeConfig.appearance, "system");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("resolvePackagedDesktopDataDir uses macOS Application Support and migrates legacy data", () => {
  const root = mkdtempSync(join(tmpdir(), "cesium-data-dir-"));
  const home = join(root, "Users", "dev");
  const userDataPath = join(home, "Library", "Application Support", "Cesium Desktop");
  const legacyDir = join(userDataPath, "server-data");
  const canonicalDir = join(home, "Library", "Application Support", "Cesium", "data");

  mkdirSync(join(legacyDir, "profile"), { recursive: true });
  writeFileSync(
    join(legacyDir, "profile", "global-settings.json"),
    JSON.stringify({ themeConfig: { appearance: "dark" } })
  );

  try {
    const resolved = resolvePackagedDesktopDataDir(userDataPath, {
      platform: "darwin",
      env: {},
      homeDir: home,
    });
    assert.equal(resolved, canonicalDir);
    assert.equal(
      readFileSync(join(canonicalDir, "profile", "global-settings.json"), "utf8"),
      JSON.stringify({ themeConfig: { appearance: "dark" } })
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("resolvePackagedDesktopDataDir honors XDG state home on Linux", () => {
  const root = mkdtempSync(join(tmpdir(), "cesium-data-dir-"));
  const home = join(root, "home", "dev");
  const xdgStateHome = join(root, "xdg-state");
  const userDataPath = join(home, ".config", "Cesium Desktop");

  try {
    assert.equal(
      resolvePackagedDesktopDataDir(userDataPath, {
        platform: "linux",
        env: { XDG_STATE_HOME: xdgStateHome },
        homeDir: home,
      }),
      join(xdgStateHome, "cesium")
    );
    assert.equal(
      resolvePackagedDesktopDataDir(userDataPath, {
        platform: "linux",
        env: {},
        homeDir: home,
      }),
      join(home, ".local", "state", "cesium")
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
