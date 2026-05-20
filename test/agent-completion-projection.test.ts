import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { projectAgentEventsToChatMessages } from "../src/lib/agent-chat.ts";
import {
  conversationHasCompletionFailure,
  deriveConversationCompletionError,
} from "../src/lib/agent-completion-error.ts";
import type { AgentConversationRecord, AgentStoredEvent } from "../src/lib/agent-types.ts";

describe("completion failure projection", () => {
  test("does not render completion failures inline in the thread", () => {
    const message = "429 Too Many Requests: Requests per minute limit exceeded";
    const events: AgentStoredEvent[] = [
      {
        seq: 1,
        eventId: "u1",
        conversationId: "c1",
        createdAt: 1,
        kind: "user_message",
        messageId: "m1",
        content: "Run",
      },
      {
        seq: 2,
        eventId: "sys1",
        conversationId: "c1",
        createdAt: 2,
        kind: "system",
        level: "error",
        text: message,
      },
      {
        seq: 3,
        eventId: "st1",
        conversationId: "c1",
        createdAt: 3,
        kind: "status",
        status: "failed",
        detail: message,
      },
    ];

    const messages = projectAgentEventsToChatMessages(events, {
      backendId: "cesium-agent",
    });
    assert.equal(
      messages.filter(
        (entry) =>
          entry.type === "activity-label" && entry.activityLabel === "Failed"
      ).length,
      0
    );
    assert.equal(
      messages.filter((entry) => entry.type === "assistant").length,
      0
    );
  });

  test("drops legacy Cesium failure assistant chunks", () => {
    const events: AgentStoredEvent[] = [
      {
        seq: 1,
        eventId: "u1",
        conversationId: "c1",
        createdAt: 1,
        kind: "user_message",
        messageId: "m1",
        content: "Run",
      },
      {
        seq: 2,
        eventId: "a1",
        conversationId: "c1",
        createdAt: 2,
        kind: "assistant_message_chunk",
        messageId: "am1",
        text: "Cesium Agent failed: 500 Internal Server Error",
      },
      {
        seq: 3,
        eventId: "st1",
        conversationId: "c1",
        createdAt: 3,
        kind: "status",
        status: "failed",
        detail: "500 Internal Server Error",
      },
    ];

    const messages = projectAgentEventsToChatMessages(events, {
      backendId: "cesium-agent",
    });
    assert.equal(
      messages.filter((entry) => entry.type === "assistant").length,
      0
    );
  });

  test("hides provider error text leaked into assistant timeline slots", () => {
    const toolCallError =
      "An assistant message with 'tool_calls' must be followed by tool messages responding to each 'tool_call_id'.";
    const events: AgentStoredEvent[] = [
      {
        seq: 1,
        eventId: "u1",
        conversationId: "c1",
        createdAt: 1,
        kind: "user_message",
        messageId: "m1",
        content: "Run",
      },
      {
        seq: 2,
        eventId: "a1",
        conversationId: "c1",
        createdAt: 2,
        kind: "assistant_message_chunk",
        messageId: "am1",
        text: toolCallError,
      },
      {
        seq: 3,
        eventId: "end1",
        conversationId: "c1",
        createdAt: 3,
        kind: "assistant_message_end",
        messageId: "am1",
        stopReason: "failed",
      },
    ];

    const messages = projectAgentEventsToChatMessages(events, {
      backendId: "cesium-agent",
    });
    assert.equal(
      messages.filter((entry) => entry.type === "assistant").length,
      0
    );
  });

  test("derives completion errors from failed status events", () => {
    const message = "429 Too Many Requests";
    const events: AgentStoredEvent[] = [
      {
        seq: 1,
        eventId: "st1",
        conversationId: "c1",
        createdAt: 1,
        kind: "status",
        status: "failed",
        detail: message,
      },
    ];
    const conversation = {
      status: "running",
      lastError: null,
    } as AgentConversationRecord;

    assert.equal(deriveConversationCompletionError(conversation, events), message);
    assert.equal(conversationHasCompletionFailure(conversation, events), true);
  });
});
