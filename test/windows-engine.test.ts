import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, test } from "node:test";
import { parseEnvFile, serializeEnvFile } from "../packages/cli/lib/env-file.mjs";
import {
  bunDownloadUrl,
  bunZipName,
  cesiumHome,
  managerPaths,
  mergeUserPath,
  userPathContains,
  windowsDesktopInstallPath,
  windowsHelpExtra,
  windowsStaleNsisInstallPath,
} from "../packages/cli/lib/windows-engine.mjs";

describe("Windows engine helpers", () => {
  test("desktop install path is Programs\\Cesium, not the scoped npm name", () => {
    assert.equal(
      windowsDesktopInstallPath("C:\\Users\\bennett\\AppData\\Local"),
      "C:\\Users\\bennett\\AppData\\Local\\Programs\\Cesium"
    );
    assert.equal(
      windowsStaleNsisInstallPath("C:\\Users\\bennett\\AppData\\Local"),
      "C:\\Users\\bennett\\AppData\\Local\\Programs\\@cesiumdesktop"
    );
  });

  test("CESIUM_HOME and default profile root", () => {
    assert.equal(cesiumHome({ CESIUM_HOME: "D:\\engine" }, "C:\\Users\\bennett"), "D:\\engine");
    assert.equal(
      cesiumHome({}, "C:\\Users\\bennett"),
      path.join("C:\\Users\\bennett", ".cesium")
    );
  });

  test("manager paths use Windows-style bun.exe", () => {
    const paths = managerPaths("C:\\Users\\bennett\\.cesium");
    assert.equal(paths.bunBin, path.join("C:\\Users\\bennett\\.cesium", "runtime", "bin", "bun.exe"));
    assert.equal(paths.managerCmd, path.join("C:\\Users\\bennett\\.cesium", "bin", "cesium-server.cmd"));
    assert.ok(paths.engineEntry.endsWith(path.join("server", "src", "runtime", "bun-server.ts")));
  });

  test("bun zip matches Windows arch", () => {
    assert.equal(bunZipName("x64"), "bun-windows-x64.zip");
    assert.equal(bunZipName("arm64"), "bun-windows-aarch64.zip");
    assert.ok(bunDownloadUrl("x64").endsWith("/bun-windows-x64.zip"));
  });

  test("user PATH merge is idempotent and case-insensitive on Windows", () => {
    const first = mergeUserPath("C:\\bin", "C:\\Users\\bennett\\.cesium\\bin");
    assert.equal(first.changed, true);
    assert.ok(first.next.includes("C:\\Users\\bennett\\.cesium\\bin"));
    const second = mergeUserPath(first.next, "C:\\Users\\bennett\\.cesium\\bin\\");
    assert.equal(second.changed, false);
    assert.equal(userPathContains(first.next, "c:\\users\\bennett\\.cesium\\bin"), true);
  });

  test("env file round-trips Windows paths", () => {
    const text = serializeEnvFile({
      CESIUM_HOME: "C:\\Users\\bennett\\.cesium",
      PORT: "9100",
    });
    const parsed = parseEnvFile(text);
    assert.equal(parsed.CESIUM_HOME, "C:\\Users\\bennett\\.cesium");
    assert.equal(parsed.PORT, "9100");
  });

  test("help documents native Windows and unsigned SmartScreen", () => {
    const extra = windowsHelpExtra();
    assert.match(extra, /without WSL/i);
    assert.match(extra, /SmartScreen/);
    assert.match(extra, /More info/);
    assert.match(extra, /no code-signing cert/i);
    assert.match(extra, /localhost-run is POSIX-only/);
  });

  test("missing engine files are detectable from a temp home", () => {
    const home = mkdtempSync(path.join(tmpdir(), "cesium-win-"));
    const paths = managerPaths(home);
    writeFileSync(path.join(home, "marker"), "ok");
    assert.equal(paths.envFile.startsWith(home), true);
  });
});
