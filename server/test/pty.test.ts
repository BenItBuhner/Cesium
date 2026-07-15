import assert from "node:assert/strict";
import { test } from "node:test";
import { canUseBunTerminal, getPtyBackendName, spawnPty } from "../src/lib/pty.js";

async function waitForOutput(
  read: () => string,
  text: string,
  timeoutMs = 5000
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (read().includes(text)) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`Timed out waiting for PTY output containing ${JSON.stringify(text)}. Got: ${JSON.stringify(read())}`);
}

test("spawnPty selects the expected backend for this runtime", () => {
  const expected = process.versions.bun && process.platform !== "win32"
    ? "bun-terminal"
    : "node-pty";
  assert.equal(getPtyBackendName(), expected);
  assert.equal(canUseBunTerminal(), expected === "bun-terminal");
});

test("spawnPty streams interactive shell output", async () => {
  const chunks: string[] = [];
  const marker = `__PTY_OK_${Date.now()}__`;
  const expected = `OUT:${marker}`;
  const proc = spawnPty({
    file: process.env.SHELL || "/bin/bash",
    args: [],
    cols: 80,
    rows: 24,
    cwd: "/tmp",
    env: process.env,
    name: "xterm-256color",
  });

  proc.onData((data) => {
    chunks.push(data);
  });

  const exitPromise = new Promise<number>((resolve) => {
    proc.onExit(({ exitCode }) => resolve(exitCode));
  });

  // Give the shell a moment to start before writing.
  await new Promise((resolve) => setTimeout(resolve, 100));
  proc.write(`printf 'OUT:%s\\n' '${marker}'\n`);
  await waitForOutput(() => chunks.join(""), expected);

  proc.write("exit\n");
  const exitCode = await Promise.race([
    exitPromise,
    new Promise<number>((_, reject) =>
      setTimeout(() => reject(new Error("Timed out waiting for PTY exit")), 5000)
    ),
  ]);

  assert.equal(typeof exitCode, "number");
  assert.ok(chunks.join("").includes(expected));
  assert.ok(proc.pid > 0);
  assert.equal(
    proc.backend,
    process.versions.bun && process.platform !== "win32" ? "bun-terminal" : "node-pty"
  );
});
