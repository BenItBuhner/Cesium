import assert from "node:assert/strict";
import { test } from "node:test";

const { BufferedRuntimeSocket } = await import("../src/ws/runtime-socket.js");

test("BufferedRuntimeSocket stops delivering messages after close", () => {
  const sent: unknown[] = [];
  const received: unknown[] = [];
  let closed = 0;
  const socket = new BufferedRuntimeSocket(
    (data) => sent.push(data),
    () => undefined
  );
  socket.onMessage((data) => received.push(data));
  socket.onClose(() => {
    closed += 1;
  });
  socket.send("a");
  socket.dispatchMessage("m1", false);
  socket.dispatchClose();
  socket.dispatchMessage("m2", false);
  socket.send("b");
  socket.dispatchClose();

  assert.deepEqual(sent, ["a"]);
  assert.deepEqual(received, ["m1"]);
  assert.equal(closed, 1);
  assert.equal(socket.isOpen, false);
});
