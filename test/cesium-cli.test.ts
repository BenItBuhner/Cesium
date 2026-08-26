import assert from "node:assert/strict";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
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

function emptyHome() {
  return mkdtempSync(path.join(tmpdir(), "cesium-cli-test-"));
}

function writeManagedHome(overrides: {
  port?: number;
  extraEnv?: string;
  bunPath?: string;
  sourceDir?: string;
} = {}) {
  const home = emptyHome();
  mkdirSync(path.join(home, "bin"), { recursive: true });
  mkdirSync(path.join(home, "logs"), { recursive: true });
  mkdirSync(path.join(home, "run"), { recursive: true });
  mkdirSync(path.join(home, "runtime/bin"), { recursive: true });
  const sourceDir = overrides.sourceDir ?? path.join(home, "source");
  mkdirSync(path.join(sourceDir, "server/src/runtime"), { recursive: true });
  mkdirSync(path.join(sourceDir, "scripts"), { recursive: true });
  mkdirSync(path.join(sourceDir, "src/lib/cloud"), { recursive: true });
  writeFileSync(path.join(sourceDir, "server/src/runtime/bun-server.ts"), "// fixture\n");
  writeFileSync(path.join(sourceDir, "scripts/cesium-server"), "#!/bin/bash\necho fixture\n");
  writeFileSync(
    path.join(sourceDir, "src/lib/cloud/cloud-defaults.ts"),
    'export const CESIUM_CLOUD_DEFAULTS = { convexUrl: "", clerkPublishableKey: "" } as const;\n'
  );
  const bunPath = overrides.bunPath ?? path.join(home, "runtime/bin/bun");
  writeFileSync(bunPath, "#!/bin/sh\nexit 0\n");
  chmodSync(bunPath, 0o700);
  writeFileSync(
    path.join(home, "bin/cesium-server"),
    "#!/bin/sh\necho \"delegated $*\"\nexit 0\n"
  );
  chmodSync(path.join(home, "bin/cesium-server"), 0o700);
  const port = overrides.port ?? 19100;
  writeFileSync(
    path.join(home, "server.env"),
    [
      `CESIUM_SOURCE_DIR='${sourceDir}'`,
      `CESIUM_BUN_BIN='${bunPath}'`,
      "CESIUM_TUNNEL_ENABLED=0",
      "HOST=127.0.0.1",
      `PORT=${port}`,
      "OPENCURSOR_AUTH_USERNAME=cesium",
      "OPENCURSOR_AUTH_PASSWORD=fixture-password",
      `WORKSPACE_ROOT='${home}'`,
      "CESIUM_SERVICE_MANAGER=detached",
      overrides.extraEnv ?? "",
      "",
    ].join("\n")
  );
  chmodSync(path.join(home, "server.env"), 0o600);
  return home;
}

function startFixtureServer(port: number, body: string) {
  const child = spawn(
    process.execPath,
    [
      "-e",
      `require("http").createServer((q,s)=>{s.writeHead(200,{"content-type":"application/json"});s.end(${JSON.stringify(body)})}).listen(${port},"127.0.0.1",()=>console.log("ready"))`,
    ],
    { stdio: ["ignore", "pipe", "inherit"] }
  );
  return new Promise<ChildProcess>((resolve, reject) => {
    let ready = false;
    const timer = setTimeout(() => reject(new Error(`fixture on ${port} did not start`)), 5000);
    child.stdout?.on("data", (chunk: Buffer) => {
      if (!ready && chunk.toString("utf8").includes("ready")) {
        ready = true;
        clearTimeout(timer);
        resolve(child);
      }
    });
    child.on("error", (error) => {
      if (!ready) {
        clearTimeout(timer);
        reject(error);
      }
    });
    child.on("exit", (code) => {
      if (!ready) {
        clearTimeout(timer);
        reject(new Error(`fixture exited ${code}`));
      }
    });
  });
}

function stopFixture(child: ChildProcess) {
  if (child.pid) {
    try {
      process.kill(child.pid, "SIGTERM");
    } catch {
      // already gone
    }
  }
}

describe("cesium CLI", () => {
  test("help reads as one product and lists the full lifecycle", () => {
    const result = runCli(["help"]);
    assert.equal(result.status, 0);
    assert.ok(result.stdout.includes("The desktop app is optional"));
    assert.ok(result.stdout.includes("Operate (no desktop required)"));
    for (const command of [
      "install",
      "start",
      "stop",
      "status",
      "logs",
      "connect",
      "update",
      "doctor",
    ]) {
      assert.ok(result.stdout.includes(`cesium ${command}`), `help missing ${command}`);
    }
    assert.ok(result.stdout.includes("--from-source"));
    assert.ok(result.stdout.includes("--no-start"));
  });

  test("no arguments prints help and exits 0", () => {
    const result = runCli([]);
    assert.equal(result.status, 0);
    assert.ok(result.stdout.includes("Install"));
  });

  test("version matches the package manifest", () => {
    const manifest = JSON.parse(
      readFileSync(path.join(REPO_ROOT, "packages/cli/package.json"), "utf8")
    ) as { version: string };
    const result = runCli(["version"]);
    assert.equal(result.status, 0);
    assert.equal(result.stdout.trim(), manifest.version);
  });

  test("unknown commands fail with help and point at doctor", () => {
    const result = runCli(["frobnicate"]);
    assert.equal(result.status, 1);
    assert.ok(result.stderr.includes("Unknown command: frobnicate"));
    assert.ok(result.stderr.includes("cesium doctor"));
  });

  test("managed commands demand an installed engine", { skip: process.platform === "win32" }, () => {
    const home = emptyHome();
    const result = runCli(["status"], { CESIUM_HOME: home });
    assert.equal(result.status, 1);
    assert.ok(result.stderr.includes("not installed"));
    assert.ok(result.stderr.includes("cesium install"));
    assert.ok(result.stderr.includes("cesium doctor"));
  });

  test("install rejects a dangling --web-url flag", { skip: process.platform === "win32" }, () => {
    const result = runCli(["install", "--web-url"]);
    assert.equal(result.status, 1);
    assert.ok(result.stderr.includes("--web-url requires a value"));
  });

  test("install rejects a missing --from-source directory", { skip: process.platform === "win32" }, () => {
    const result = runCli(["install", "--from-source", "/no/such/cesium-source"]);
    assert.equal(result.status, 1);
    assert.ok(result.stderr.includes("--from-source directory does not exist"));
  });

  test("doctor on an empty home is a failure path with a CLI-only hint", { skip: process.platform === "win32" }, () => {
    const home = emptyHome();
    const result = runCli(["doctor", "--check", "--json"], { CESIUM_HOME: home });
    assert.equal(result.status, 1);
    const report = JSON.parse(result.stdout) as {
      checks: Array<{ id: string; status: string; hint?: string }>;
    };
    const install = report.checks.find((check) => check.id === "install");
    assert.equal(install?.status, "fail");
    assert.ok(install?.hint?.includes("cesium install"));
    assert.ok(result.stdout.includes("CLI-only"));
  });

  test("doctor reports a healthy-ish managed engine", { skip: process.platform === "win32" }, async () => {
    const server = await startFixtureServer(
      19210,
      JSON.stringify({ ok: true, transcription: { configured: false } })
    );
    try {
      const home = writeManagedHome({ port: 19210 });
      writeFileSync(
        path.join(home, "logs/server.log"),
        "listening on 127.0.0.1:19210\nready\n"
      );
      const result = runCli(["doctor", "--check"], { CESIUM_HOME: home });
      assert.equal(result.status, 0, result.stdout + result.stderr);
      assert.ok(result.stdout.includes("ok    install"));
      assert.ok(result.stdout.includes("ok    engine"));
      assert.ok(result.stdout.includes("ok    port"));
      assert.ok(result.stdout.includes("skip  tunnel"));
      assert.ok(result.stdout.includes("Clerk / Convex"));
    } finally {
      stopFixture(server);
    }
  });

  test("doctor fails when the port is held by a non-Cesium process", { skip: process.platform === "win32" }, async () => {
    const server = await startFixtureServer(19211, "nginx");
    try {
      const home = writeManagedHome({ port: 19211 });
      const result = runCli(["doctor", "--check", "--json"], { CESIUM_HOME: home });
      assert.equal(result.status, 1, result.stdout + result.stderr);
      const report = JSON.parse(result.stdout) as {
        checks: Array<{ id: string; status: string; detail: string }>;
      };
      const engine = report.checks.find((check) => check.id === "engine");
      assert.equal(engine?.status, "fail", JSON.stringify(engine));
      assert.match(engine?.detail ?? "", /not a Cesium \/health/);
    } finally {
      stopFixture(server);
    }
  });

  test("doctor removes a stale engine pid file", { skip: process.platform === "win32" }, () => {
    const home = writeManagedHome({ port: 19212 });
    writeFileSync(path.join(home, "run/server.pid"), "9999999\n");
    const result = runCli(["doctor", "--json"], { CESIUM_HOME: home });
    assert.equal(result.status, 1);
    const report = JSON.parse(result.stdout) as { repairs: string[] };
    assert.ok(report.repairs.some((line) => line.includes("stale engine pid")));
    assert.throws(() => readFileSync(path.join(home, "run/server.pid")));
  });

  test("status delegates to the managed engine", { skip: process.platform === "win32" }, () => {
    const home = writeManagedHome();
    const result = runCli(["status"], { CESIUM_HOME: home });
    assert.equal(result.status, 0, result.stderr);
    assert.ok(result.stdout.includes("delegated status"));
  });
});
