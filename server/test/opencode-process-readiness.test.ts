import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { test } from "node:test";
import {
  RecentOutput,
  describeOpenCodeStartupFailure,
  waitForManagedServerReady,
} from "../src/lib/agents/opencode-process-readiness.js";

test("a managed OpenCode server that exits on startup fails fast with its output and a hint", async () => {
  const recent = new RecentOutput();
  const child = spawn(process.execPath, [
    "-e",
    // Same wording opencode 1.18.29 prints (in color) when the v2 beta created the database first.
    'process.stdout.write("\\u001b[91m\\u001b[1mError: \\u001b[0mUnexpected error\\n\\nDatabase is not empty and has no session table\\n"); process.exit(1);',
  ]);
  child.stdout.on("data", (chunk) => recent.push(chunk));
  child.stderr.on("data", (chunk) => recent.push(chunk));
  const started = Date.now();
  await assert.rejects(
    waitForManagedServerReady({
      child,
      label: "OpenCode Server at http://127.0.0.1:1",
      probe: async () => false,
      timeoutMs: 20_000,
      intervalMs: 50,
      recentOutput: () => recent.snapshot(),
    }),
    (error: Error) => {
      assert.match(error.message, /exited before becoming healthy \(code 1/);
      assert.match(error.message, /initialized by the OpenCode v2 beta/);
      assert.match(error.message, /OPENCURSOR_OPENCODE_DB/);
      assert.match(error.message, /Database is not empty and has no session table/);
      assert.ok(!error.message.includes("\u001b["), "ANSI escapes stripped");
      return true;
    }
  );
  assert.ok(Date.now() - started < 5_000, "did not wait for the health timeout");
});

test("a binary that cannot be spawned fails immediately", async () => {
  const child = spawn("/nonexistent/opencode-binary-for-tests", ["serve"]);
  await assert.rejects(
    waitForManagedServerReady({
      child,
      label: "OpenCode v2 Beta at http://127.0.0.1:1",
      probe: async () => false,
      timeoutMs: 20_000,
      intervalMs: 50,
      recentOutput: () => [],
    }),
    /failed to start: .*ENOENT/
  );
});

test("readiness resolves as soon as the probe succeeds and stops watching the child", async () => {
  const child = spawn(process.execPath, ["-e", "setTimeout(() => {}, 5000)"]);
  try {
    let calls = 0;
    await waitForManagedServerReady({
      child,
      label: "server",
      probe: async () => {
        calls += 1;
        return calls >= 3;
      },
      timeoutMs: 5_000,
      intervalMs: 10,
      recentOutput: () => [],
    });
    assert.equal(calls, 3);
    assert.equal(child.listenerCount("exit"), 0);
  } finally {
    child.kill();
  }
});

test("a healthy-never server times out with the last output attached", async () => {
  const child = spawn(process.execPath, ["-e", "console.log('booting'); setTimeout(() => {}, 5000)"]);
  const recent = new RecentOutput();
  child.stdout.on("data", (chunk) => recent.push(chunk));
  try {
    await new Promise((resolve) => setTimeout(resolve, 100));
    await assert.rejects(
      waitForManagedServerReady({
        child,
        label: "server",
        probe: async () => {
          throw new Error("ECONNREFUSED");
        },
        timeoutMs: 150,
        intervalMs: 20,
        recentOutput: () => recent.snapshot(),
      }),
      (error: Error) => {
        assert.match(error.message, /did not become healthy within/);
        assert.match(error.message, /ECONNREFUSED/);
        assert.match(error.message, /booting/);
        return true;
      }
    );
  } finally {
    child.kill();
  }
});

test("known startup failures map to actionable hints", () => {
  assert.match(describeOpenCodeStartupFailure(["EADDRINUSE: address already in use"]) ?? "", /already in use/);
  assert.match(describeOpenCodeStartupFailure(["Missing server password"]) ?? "", /OPENCODE_PASSWORD/);
  assert.equal(describeOpenCodeStartupFailure(["something else"]), undefined);
});
