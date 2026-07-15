import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { createCesiumApp } from "../src/app.js";
import { getPtyBackendName, spawnPty } from "../src/lib/pty.js";
import { BufferedRuntimeSocket } from "../src/ws/runtime-socket.js";

const bunRuntime = (globalThis as typeof globalThis & { Bun?: { version: string } }).Bun;

describe("bun runtime smoke", () => {
  test("runs under Bun and serves the shared Hono app", { skip: !bunRuntime }, async () => {
    assert.ok(bunRuntime?.version.length);
    const app = createCesiumApp();
    const response = await app.request("/health");
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.equal(body.ok, true);
  });

  test("runtime socket adapter dispatches messages and close events", () => {
    const sent: unknown[] = [];
    const socket = new BufferedRuntimeSocket(
      (data) => sent.push(data),
      () => undefined
    );
    const messages: unknown[] = [];
    let closed = false;
    socket.onMessage((data) => messages.push(data));
    socket.onClose(() => {
      closed = true;
    });
    socket.send("hello");
    socket.dispatchMessage("ping", false);
    socket.dispatchClose();
    assert.deepEqual(sent, ["hello"]);
    assert.deepEqual(messages, ["ping"]);
    assert.equal(closed, true);
    assert.equal(socket.isOpen, false);
  });

  test("PTY backend streams output under Bun via Bun.Terminal", { skip: !bunRuntime || process.platform === "win32" }, async () => {
    assert.equal(getPtyBackendName(), "bun-terminal");
    const chunks: string[] = [];
    const marker = `__BUN_PTY_${Date.now()}__`;
    const expected = `OUT:${marker}`;
    const proc = spawnPty({
      file: process.env.SHELL || "/bin/bash",
      args: [],
      cols: 80,
      rows: 24,
      cwd: "/tmp",
      env: process.env,
    });
    proc.onData((data) => chunks.push(data));
    await new Promise((resolve) => setTimeout(resolve, 100));
    proc.write(`printf 'OUT:%s\\n' '${marker}'\n`);
    const deadline = Date.now() + 5000;
    while (Date.now() < deadline && !chunks.join("").includes(expected)) {
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    proc.kill();
    assert.ok(
      chunks.join("").includes(expected),
      `expected Bun.Terminal PTY output to include ${expected}, got ${JSON.stringify(chunks.join(""))}`
    );
  });
});
