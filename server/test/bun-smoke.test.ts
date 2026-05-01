import { describe, expect, test } from "bun:test";
import { createOpenCursorApp } from "../src/app.js";
import { BufferedRuntimeSocket } from "../src/ws/runtime-socket.js";

describe("bun runtime smoke", () => {
  test("runs under Bun and serves the shared Hono app", async () => {
    expect(Bun.version.length).toBeGreaterThan(0);
    const app = createOpenCursorApp();
    const response = await app.request("/health");
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.ok).toBe(true);
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
    expect(sent).toEqual(["hello"]);
    expect(messages).toEqual(["ping"]);
    expect(closed).toBe(true);
    expect(socket.isOpen).toBe(false);
  });
});
