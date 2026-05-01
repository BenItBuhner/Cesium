import assert from "node:assert/strict";
import test from "node:test";
import { resolvePersistedChatScroll } from "../src/lib/workspace-session";

test("resolvePersistedChatScroll defaults missing state to bottom", () => {
  const result = resolvePersistedChatScroll({}, {}, "conv-1", "workspace-1", "window-1", "server");

  assert.deepEqual(result, { mode: "bottom" });
});

test("resolvePersistedChatScroll restores anchor with saved scrollTop", () => {
  const result = resolvePersistedChatScroll(
    { "conv-1": 420 },
    { "conv-1": { messageId: "msg-2", delta: -12 } },
    "conv-1",
    "workspace-1",
    "window-1",
    "server"
  );

  assert.deepEqual(result, {
    mode: "restore",
    scrollTop: 420,
    anchor: { messageId: "msg-2", delta: -12 },
  });
});

test("resolvePersistedChatScroll can restore from anchor without y", () => {
  const result = resolvePersistedChatScroll(
    {},
    { "conv-1": { messageId: "msg-2", delta: 16 } },
    "conv-1",
    "workspace-1",
    "window-1",
    "server"
  );

  assert.deepEqual(result, {
    mode: "restore",
    anchor: { messageId: "msg-2", delta: 16 },
  });
});
