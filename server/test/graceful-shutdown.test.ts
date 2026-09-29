import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, test } from "node:test";

const TEST_DATA_DIR = await fs.mkdtemp(path.join(os.tmpdir(), "graceful-shutdown-"));
delete process.env.REDIS_URL;
delete process.env.DATABASE_URL;
delete process.env.OPENCURSOR_STORAGE_DRIVER;
process.env.OPENCURSOR_DATA_DIR = TEST_DATA_DIR;

const { installGracefulShutdown } = await import("../src/runtime/graceful-shutdown.js");

after(async () => {
  await fs.rm(TEST_DATA_DIR, { recursive: true, force: true });
});

function recordingShutdown(drainTimeoutMs: number) {
  const calls: string[] = [];
  let exited!: () => void;
  const exitedOnce = new Promise<void>((resolve) => {
    exited = resolve;
  });
  const remove = installGracefulShutdown({
    signals: ["SIGUSR2"],
    drainTimeoutMs,
    shutdownAgents: async ({ timeoutMs }) => {
      calls.push(`agents ${timeoutMs}`);
      return { interrupted: ["c1"], drained: true };
    },
    stopServer: () => {
      calls.push("stop");
    },
    exit: (code) => {
      calls.push(`exit ${code}`);
      exited();
    },
  });
  return { calls, exitedOnce, remove };
}

test("a signal interrupts agent turns, then stops the listener, then exits; a second signal exits at once", async () => {
  const listenersBefore = process.listenerCount("SIGUSR2");
  const { calls, exitedOnce, remove } = recordingShutdown(50);
  try {
    process.emit("SIGUSR2", "SIGUSR2");
    await exitedOnce;
    assert.deepEqual(calls, ["agents 50", "stop", "exit 0"]);
    process.emit("SIGUSR2", "SIGUSR2");
    assert.equal(calls.at(-1), "exit 1");
  } finally {
    remove();
  }
  assert.equal(process.listenerCount("SIGUSR2"), listenersBefore, "removing the handlers leaves no listener");
});
test("cleanup such as closing the database pool runs only after the interrupted turns are recorded", async () => {
  const { onShutdown, runShutdownHooks } = await import("../src/runtime/shutdown-hooks.js");
  const calls: string[] = [];
  let exited!: () => void;
  const exitedOnce = new Promise<void>((resolve) => {
    exited = resolve;
  });
  const unregister = onShutdown(async () => {
    calls.push("close pool");
  });
  const remove = installGracefulShutdown({
    signals: ["SIGUSR2"],
    drainTimeoutMs: 50,
    shutdownAgents: async () => {
      await new Promise((resolve) => setTimeout(resolve, 20));
      calls.push("interrupted turns recorded");
      return { interrupted: ["c1"], drained: true };
    },
    stopServer: () => {
      calls.push("stop");
    },
    exit: (code) => {
      calls.push(`exit ${code}`);
      exited();
    },
  });
  try {
    process.emit("SIGUSR2", "SIGUSR2");
    await exitedOnce;
    assert.deepEqual(calls, ["interrupted turns recorded", "stop", "close pool", "exit 0"]);
    await runShutdownHooks();
    assert.equal(calls.filter((call) => call === "close pool").length, 1, "hooks run once");
  } finally {
    unregister();
    remove();
  }
});

test("the database client registers no signal listener of its own", async () => {
  const source = await fs.readFile(new URL("../src/db/client.ts", import.meta.url), "utf8");
  assert.doesNotMatch(source, /process\.once\("SIG/);
  assert.match(source, /onShutdown\(shutdown\)/);
});
