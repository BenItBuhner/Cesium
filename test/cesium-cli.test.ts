import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, test } from "node:test";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const CLI_BIN = path.join(REPO_ROOT, "packages/cli/bin/cesium.mjs");

function runCli(args: string[], env: Record<string, string> = {}) {
  return spawnSync(process.execPath, [CLI_BIN, ...args], {
    encoding: "utf8",
    env: { ...process.env, ...env },
  });
}

describe("cesium CLI", () => {
  test("help lists the full lifecycle", () => {
    const result = runCli(["help"]);
    assert.equal(result.status, 0);
    for (const command of ["install", "start", "stop", "status", "logs", "connect", "update"]) {
      assert.ok(result.stdout.includes(`cesium ${command}`), `help missing ${command}`);
    }
    assert.ok(result.stdout.includes("--local"));
    assert.ok(result.stdout.includes("cesium.techlitnow.com"));
  });

  test("no arguments prints help and exits 0", () => {
    const result = runCli([]);
    assert.equal(result.status, 0);
    assert.ok(result.stdout.includes("Usage:"));
  });

  test("version matches the package manifest", () => {
    const manifest = JSON.parse(
      readFileSync(path.join(REPO_ROOT, "packages/cli/package.json"), "utf8")
    ) as { version: string };
    const result = runCli(["version"]);
    assert.equal(result.status, 0);
    assert.equal(result.stdout.trim(), manifest.version);
  });

  test("unknown commands fail with help", () => {
    const result = runCli(["frobnicate"]);
    assert.equal(result.status, 1);
    assert.ok(result.stderr.includes("Unknown command: frobnicate"));
  });

  test("managed commands demand an installed engine", { skip: process.platform === "win32" }, () => {
    const emptyHome = mkdtempSync(path.join(tmpdir(), "cesium-cli-test-"));
    const result = runCli(["status"], { CESIUM_HOME: emptyHome });
    assert.equal(result.status, 1);
    assert.ok(result.stderr.includes("not installed"));
    assert.ok(result.stderr.includes("cesium install"));
  });

  test("install rejects a dangling --web-url flag", { skip: process.platform === "win32" }, () => {
    const result = runCli(["install", "--web-url"]);
    assert.equal(result.status, 1);
    assert.ok(result.stderr.includes("--web-url requires a value"));
  });
});
