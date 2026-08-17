import assert from "node:assert/strict";
import test from "node:test";
import {
  backgroundAgentConversationIds,
  shouldForwardProjectionCatchUp,
} from "./nativeServiceConfig";

test("idle focused conversations do not keep the background socket alive", () => {
  assert.deepEqual(
    backgroundAgentConversationIds({
      conversationId: "focused-but-idle",
      activeConversationIds: [],
    }),
    []
  );
});

test("active conversations are validated and deduplicated", () => {
  assert.deepEqual(
    backgroundAgentConversationIds({
      conversationId: "idle-focused",
      activeConversationIds: ["running-a", "", "running-b", "running-a"],
    }),
    ["running-a", "running-b"]
  );
});

test("an active focused conversation remains subscribed", () => {
  assert.deepEqual(
    backgroundAgentConversationIds({
      conversationId: "running",
      activeConversationIds: ["running"],
    }),
    ["running"]
  );
});

test("projection catch-up never wakes a background WebView", () => {
  assert.equal(shouldForwardProjectionCatchUp("background"), false);
  assert.equal(shouldForwardProjectionCatchUp("inactive"), false);
  assert.equal(shouldForwardProjectionCatchUp("unknown"), false);
  assert.equal(shouldForwardProjectionCatchUp("active"), true);
});
