import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { projectAgentEventsToChatMessages } from "../src/lib/agent-chat.ts";
import type { AgentStoredEvent } from "../src/lib/agent-types.ts";

describe("turn completion footer projection", () => {
  test("appends duration and fork metadata after a settled assistant turn", () => {
    const events: AgentStoredEvent[] = [
      {
        seq: 1,
        eventId: "u1",
        conversationId: "c1",
        createdAt: 1_000,
        kind: "user_message",
        messageId: "m-user",
        content: "Build it",
      },
      {
        seq: 2,
        eventId: "a1",
        conversationId: "c1",
        createdAt: 2_000,
        kind: "assistant_message_chunk",
        messageId: "m-assistant",
        text: "Done.",
      },
      {
        seq: 3,
        eventId: "a1-end",
        conversationId: "c1",
        createdAt: 3_000,
        kind: "assistant_message_end",
        messageId: "m-assistant",
      },
      {
        seq: 4,
        eventId: "st-idle",
        conversationId: "c1",
        createdAt: 1_000 + 97 * 60_000,
        kind: "status",
        status: "idle",
      },
    ];

    const messages = projectAgentEventsToChatMessages(events, {
      backendId: "cesium-agent",
    });
    const footer = messages.find((message) => message.type === "turn-footer");
    assert.ok(footer);
    assert.equal(footer.turnFooterUserMessageId, "m-user");
    assert.equal(footer.turnDurationMs, 97 * 60_000);
  });

  test("does not append a footer while the turn is still running", () => {
    const events: AgentStoredEvent[] = [
      {
        seq: 1,
        eventId: "u1",
        conversationId: "c1",
        createdAt: 1_000,
        kind: "user_message",
        messageId: "m-user",
        content: "Build it",
      },
      {
        seq: 2,
        eventId: "a1",
        conversationId: "c1",
        createdAt: 2_000,
        kind: "assistant_message_chunk",
        messageId: "m-assistant",
        text: "Still going...",
      },
      {
        seq: 3,
        eventId: "st-running",
        conversationId: "c1",
        createdAt: 3_000,
        kind: "status",
        status: "running",
      },
    ];

    const messages = projectAgentEventsToChatMessages(events, {
      backendId: "cesium-agent",
    });
    assert.equal(messages.some((message) => message.type === "turn-footer"), false);
  });
});
