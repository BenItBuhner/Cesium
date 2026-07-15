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
    JSON.stringify({ themeConfig: { uiDesignMode: "new" } })
  );

  const previousLocalAppData = process.env.LOCALAPPDATA;
  process.env.LOCALAPPDATA = localAppData;
  try {
    const resolved = resolvePackagedDesktopDataDir(userDataPath);
    assert.equal(resolved, canonicalDir);
    assert.equal(
      readFileSync(join(canonicalDir, "profile", "global-settings.json"), "utf8"),
      JSON.stringify({ themeConfig: { uiDesignMode: "new" } })
    );
  } finally {
    process.env.LOCALAPPDATA = previousLocalAppData;
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
    JSON.stringify({ themeConfig: { uiDesignMode: "new" }, desktop: true, extra: "x".repeat(4096) })
  );

  const previousLocalAppData = process.env.LOCALAPPDATA;
  process.env.LOCALAPPDATA = localAppData;
  try {
    const resolved = resolvePackagedDesktopDataDir(userDataPath);
    assert.equal(resolved, canonicalDir);
    const merged = JSON.parse(
      readFileSync(join(canonicalDir, "profile", "global-settings.json"), "utf8")
    );
    assert.equal(merged.desktop, true);
    assert.equal(merged.themeConfig.uiDesignMode, "new");
  } finally {
    process.env.LOCALAPPDATA = previousLocalAppData;
    rmSync(root, { recursive: true, force: true });
  }
});
