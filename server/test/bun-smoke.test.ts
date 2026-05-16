import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { createCesiumApp } from "../src/app.js";
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
});
