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
    assert.equal(
      messages.filter(
        (entry) => entry.type === "worked-session" && entry.workedLabel === "Working"
      ).length,
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

  test("shows Taking longer while provider auto-retry status is running", () => {
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
        eventId: "st1",
        conversationId: "c1",
        createdAt: 2,
        kind: "status",
        status: "running",
        detail: "Taking longer — retrying provider request (1/3)…",
      },
    ];

    const messages = projectAgentEventsToChatMessages(events, {
      backendId: "cesium-agent",
    });
    assert.equal(
      messages.some(
        (entry) => entry.type === "worked-session" && entry.workedLabel === "Taking longer"
      ),
      true
    );
  });

  test("shows Compressing context while Cesium compression status is running", () => {
    const events: AgentStoredEvent[] = [
      {
        seq: 11,
        eventId: "u-compress",
        conversationId: "c-compress",
        createdAt: 1,
        kind: "user_message",
        messageId: "m-compress",
        content: "Run",
      },
      {
        seq: 12,
        eventId: "st-compress",
        conversationId: "c-compress",
        createdAt: 2,
        kind: "status",
        status: "running",
        detail: "Compressing context…",
      },
    ];

    const messages = projectAgentEventsToChatMessages(events, {
      backendId: "cesium-agent",
    });
    assert.equal(
      messages.some(
        (entry) => entry.type === "worked-session" && entry.workedLabel === "Compressing context"
      ),
      true
    );
  });

  test("does not render standalone Cancelled status labels", () => {
    const events: AgentStoredEvent[] = [
      {
        seq: 1,
        eventId: "u-cancel",
        conversationId: "c-cancel",
        createdAt: 1,
        kind: "user_message",
        messageId: "m-cancel",
        content: "Run",
      },
      {
        seq: 2,
        eventId: "st-cancel",
        conversationId: "c-cancel",
        createdAt: 2,
        kind: "status",
        status: "cancelled",
        detail: "Stopped by user.",
      },
    ];

    const messages = projectAgentEventsToChatMessages(events, {
      backendId: "cesium-agent",
    });
    assert.equal(
      messages.some(
        (entry) => entry.type === "activity-label" && entry.activityLabel === "Cancelled"
      ),
      false
    );
  });

  test("keeps Working visible below active tool dropdowns until idle", () => {
    const baseEvents: AgentStoredEvent[] = [
      {
        seq: 1,
        eventId: "u-tool",
        conversationId: "c-tool",
        createdAt: 1,
        kind: "user_message",
        messageId: "m-tool",
        content: "Read a file",
      },
      {
        seq: 2,
        eventId: "run-tool",
        conversationId: "c-tool",
        createdAt: 2,
        kind: "status",
        status: "running",
        detail: "Cesium is working...",
      },
      {
        seq: 3,
        eventId: "tool-1",
        conversationId: "c-tool",
        createdAt: 3,
        kind: "tool_call",
        toolCallId: "read-1",
        title: "Read file",
        toolKind: "read",
        status: "running",
        raw: {
          request: { name: "read_file", arguments: { path: "src/app.ts" } },
        },
      },
    ];

    const activeMessages = projectAgentEventsToChatMessages(baseEvents, {
      backendId: "cesium-agent",
    });
    assert.equal(
      activeMessages.filter((entry) => entry.type === "worked-session").length,
      2
    );
    assert.equal(
      activeMessages.some(
        (entry) => entry.type === "worked-session" && entry.workedLabel === "Working"
      ),
      true
    );

    const settledMessages = projectAgentEventsToChatMessages(
      [
        ...baseEvents,
        {
          seq: 4,
          eventId: "idle-tool",
          conversationId: "c-tool",
          createdAt: 4,
          kind: "status",
          status: "idle",
        },
      ],
      { backendId: "cesium-agent" }
    );
    assert.equal(
      settledMessages.some(
        (entry) => entry.type === "worked-session" && entry.workedLabel === "Working"
      ),
      false
    );
  });
});
