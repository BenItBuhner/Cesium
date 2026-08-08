import assert from "node:assert/strict";
import { chmodSync, mkdirSync, writeFileSync } from "node:fs";
import { test } from "node:test";
import os from "node:os";
import path from "node:path";
import {
  buildHarnessInvocation,
  detectHarnessCli,
  harnessDefaultArgs,
  harnessHomeDirCandidates,
  isExecutableFile,
  probeHarnessCliVersion,
  refreshHarnessCliDetection,
  resetHarnessRuntimeCachesForTest,
  resolveHarnessRuntimeSpec,
} from "../src/lib/agents/harness-runtime.js";

function makeTempDir(label: string): string {
  const dir = path.join(os.tmpdir(), `harness-rt-${label}-${process.pid}-${Date.now()}`);
  mkdirSync(dir, { recursive: true });
  return dir;
}

function writeExecutable(directory: string, name: string, body = "#!/bin/sh\nexit 0\n"): string {
  const file = path.join(directory, name);
  writeFileSync(file, body);
  chmodSync(file, 0o755);
  return file;
}

function writeNonExecutable(directory: string, name: string): string {
  const file = path.join(directory, name);
  writeFileSync(file, "not a binary");
  chmodSync(file, 0o644);
  return file;
}

type EnvSnapshot = Record<string, string | undefined>;

function snapshotEnv(names: string[]): EnvSnapshot {
  return Object.fromEntries(names.map((name) => [name, process.env[name]]));
}

function restoreEnv(snapshot: EnvSnapshot): void {
  for (const [name, value] of Object.entries(snapshot)) {
    if (value === undefined) {
      delete process.env[name];
    } else {
      process.env[name] = value;
    }
  }
  resetHarnessRuntimeCachesForTest();
}

const MANAGED_ENV = [
  "PATH",
  "OPENCURSOR_REAL_HOME",
  "OPENCURSOR_GROK_BUILD_BIN",
  "OPENCURSOR_GROK_BIN",
  "OPENCURSOR_GROK_BUILD_ARGS",
  "OPENCURSOR_GROK_ARGS",
  "OPENCURSOR_DEVIN_CLI_BIN",
  "OPENCURSOR_CODEX_BIN",
];

test("isExecutableFile rejects directories and non-executable files", () => {
  const dir = makeTempDir("exec-check");
  const nonExec = writeNonExecutable(dir, "grok");
  const exec = writeExecutable(dir, "grok-real");
  assert.equal(isExecutableFile(dir), false);
  assert.equal(isExecutableFile(nonExec), false);
  assert.equal(isExecutableFile(path.join(dir, "missing")), false);
  assert.equal(isExecutableFile(exec), true);
});

test("env override with an absolute path wins and is reported as env-sourced", () => {
  const env = snapshotEnv(MANAGED_ENV);
  try {
    const dir = makeTempDir("env-override");
    const grok = writeExecutable(dir, "grok");
    process.env.OPENCURSOR_GROK_BUILD_BIN = grok;
    resetHarnessRuntimeCachesForTest();

    const detection = detectHarnessCli("grok");
    assert.ok(detection);
    assert.equal(detection!.executablePath, grok);
    assert.equal(detection!.source, "env");
    assert.equal(detection!.envVar, "OPENCURSOR_GROK_BUILD_BIN");
  } finally {
    restoreEnv(env);
  }
});

test("a broken env override falls back to PATH discovery instead of failing", () => {
  const env = snapshotEnv(MANAGED_ENV);
  try {
    const pathDir = makeTempDir("broken-env-path");
    const grokOnPath = writeExecutable(pathDir, "grok");
    process.env.OPENCURSOR_GROK_BUILD_BIN = path.join(pathDir, "does-not-exist");
    process.env.PATH = pathDir;
    resetHarnessRuntimeCachesForTest();

    const detection = detectHarnessCli("grok");
    assert.ok(detection);
    assert.equal(detection!.executablePath, grokOnPath);
    assert.equal(detection!.source, "path");
  } finally {
    restoreEnv(env);
  }
});

test("PATH scan skips non-executable files that merely share the binary name", () => {
  const env = snapshotEnv(MANAGED_ENV);
  try {
    const decoyDir = makeTempDir("decoy");
    writeNonExecutable(decoyDir, "grok");
    const realDir = makeTempDir("real");
    const realGrok = writeExecutable(realDir, "grok");
    delete process.env.OPENCURSOR_GROK_BUILD_BIN;
    delete process.env.OPENCURSOR_GROK_BIN;
    process.env.PATH = `${decoyDir}${path.delimiter}${realDir}`;
    resetHarnessRuntimeCachesForTest();

    const detection = detectHarnessCli("grok");
    assert.ok(detection);
    assert.equal(detection!.executablePath, realGrok);
  } finally {
    restoreEnv(env);
  }
});

test("well-known install dirs are discovered through OPENCURSOR_REAL_HOME", () => {
  const env = snapshotEnv(MANAGED_ENV);
  try {
    const home = makeTempDir("well-known-home");
    const grokBinDir = path.join(home, ".grok", "bin");
    mkdirSync(grokBinDir, { recursive: true });
    const grok = writeExecutable(grokBinDir, "grok");
    delete process.env.OPENCURSOR_GROK_BUILD_BIN;
    delete process.env.OPENCURSOR_GROK_BIN;
    process.env.PATH = makeTempDir("empty-path");
    process.env.OPENCURSOR_REAL_HOME = home;
    resetHarnessRuntimeCachesForTest();

    assert.ok(harnessHomeDirCandidates().includes(home));
    const detection = detectHarnessCli("grok");
    assert.ok(detection);
    assert.equal(detection!.executablePath, grok);
    assert.equal(detection!.source, "well-known");
  } finally {
    restoreEnv(env);
  }
});

test("changing an influencing env var invalidates the detection cache immediately", () => {
  const env = snapshotEnv(MANAGED_ENV);
  try {
    const dirA = makeTempDir("finger-a");
    const grokA = writeExecutable(dirA, "grok");
    const dirB = makeTempDir("finger-b");
    const grokB = writeExecutable(dirB, "grok");

    process.env.OPENCURSOR_GROK_BUILD_BIN = grokA;
    resetHarnessRuntimeCachesForTest();
    assert.equal(detectHarnessCli("grok")?.executablePath, grokA);

    // No explicit cache refresh: the fingerprint change must be enough.
    process.env.OPENCURSOR_GROK_BUILD_BIN = grokB;
    assert.equal(detectHarnessCli("grok")?.executablePath, grokB);

    delete process.env.OPENCURSOR_GROK_BUILD_BIN;
    process.env.PATH = makeTempDir("empty-path-2");
    assert.equal(detectHarnessCli("grok"), null);
  } finally {
    restoreEnv(env);
  }
});

test("a CLI installed after the first scan is found once detection refreshes", () => {
  const env = snapshotEnv(MANAGED_ENV);
  try {
    const binDir = makeTempDir("late-install");
    delete process.env.OPENCURSOR_GROK_BUILD_BIN;
    delete process.env.OPENCURSOR_GROK_BIN;
    process.env.PATH = binDir;
    resetHarnessRuntimeCachesForTest();

    assert.equal(detectHarnessCli("grok"), null);
    const grok = writeExecutable(binDir, "grok");
    // Same fingerprint, so the negative result is served from cache...
    assert.equal(detectHarnessCli("grok"), null);
    // ...until a refresh (TTL expiry or the models-refresh endpoint) re-scans.
    refreshHarnessCliDetection();
    assert.equal(detectHarnessCli("grok")?.executablePath, grok);
  } finally {
    restoreEnv(env);
  }
});

test("runtime specs carry harness default args with env JSON overrides", () => {
  const env = snapshotEnv(MANAGED_ENV);
  try {
    const dir = makeTempDir("spec-args");
    const grok = writeExecutable(dir, "grok");
    process.env.OPENCURSOR_GROK_BUILD_BIN = grok;
    delete process.env.OPENCURSOR_GROK_BUILD_ARGS;
    delete process.env.OPENCURSOR_GROK_ARGS;
    resetHarnessRuntimeCachesForTest();

    assert.deepEqual(harnessDefaultArgs("grok"), ["--no-auto-update", "agent", "stdio"]);
    const spec = resolveHarnessRuntimeSpec("grok");
    assert.ok(spec);
    assert.equal(spec!.command, grok);
    assert.deepEqual(spec!.args, ["--no-auto-update", "agent", "stdio"]);
    assert.match(spec!.commandPreview, /--no-auto-update agent stdio/);

    process.env.OPENCURSOR_GROK_BUILD_ARGS = JSON.stringify(["agent", "stdio"]);
    assert.deepEqual(harnessDefaultArgs("grok"), ["agent", "stdio"]);

    process.env.OPENCURSOR_GROK_BUILD_ARGS = "not-json";
    assert.deepEqual(harnessDefaultArgs("grok"), ["--no-auto-update", "agent", "stdio"]);

    delete process.env.OPENCURSOR_GROK_BUILD_ARGS;
    const oneShot = buildHarnessInvocation("grok", ["models"]);
    assert.ok(oneShot);
    assert.equal(oneShot!.command, grok);
    assert.deepEqual(oneShot!.args, ["models"]);
  } finally {
    restoreEnv(env);
  }
});

test("version probing parses semver-ish output and caches per executable", async () => {
  const env = snapshotEnv(MANAGED_ENV);
  try {
    const dir = makeTempDir("version");
    const grok = writeExecutable(dir, "grok", "#!/bin/sh\necho 'grok cli v2.7.1 (build abc)'\n");
    process.env.OPENCURSOR_GROK_BUILD_BIN = grok;
    resetHarnessRuntimeCachesForTest();

    assert.equal(await probeHarnessCliVersion("grok"), "2.7.1");
    // Second call is served from the version cache (same promise result).
    assert.equal(await probeHarnessCliVersion("grok"), "2.7.1");
  } finally {
    restoreEnv(env);
  }
});

test("AGENT_BACKENDS availability follows detection without a module reload", async () => {
  const env = snapshotEnv(MANAGED_ENV);
  try {
    const emptyDir = makeTempDir("dyn-availability-empty");
    delete process.env.OPENCURSOR_GROK_BUILD_BIN;
    delete process.env.OPENCURSOR_GROK_BIN;
    process.env.PATH = emptyDir;
    resetHarnessRuntimeCachesForTest();

    const { AGENT_BACKENDS, listAgentBackends } = await import(
      "../src/lib/agents/providers.js"
    );

    assert.equal(AGENT_BACKENDS["grok-build"].available, false);
    assert.equal(
      listAgentBackends().find((backend) => backend.id === "grok-build")?.available,
      false
    );

    const dir = makeTempDir("dyn-availability-bin");
    const grok = writeExecutable(dir, "grok");
    process.env.OPENCURSOR_GROK_BUILD_BIN = grok;

    // Same imported module object: availability must flip via live detection.
    assert.equal(AGENT_BACKENDS["grok-build"].available, true);
    assert.match(AGENT_BACKENDS["grok-build"].commandPreview ?? "", /agent stdio/);
    assert.equal(
      listAgentBackends().find((backend) => backend.id === "grok-build")?.available,
      true
    );

    // Registry still behaves like a plain record for spreads and `in` checks.
    assert.ok("grok-build" in AGENT_BACKENDS);
    const spread = { ...AGENT_BACKENDS };
    assert.equal(spread["grok-build"].id, "grok-build");
    assert.equal(Object.keys(AGENT_BACKENDS).length, listAgentBackends().length);
  } finally {
    restoreEnv(env);
  }
});
