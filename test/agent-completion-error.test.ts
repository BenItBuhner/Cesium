import assert from "node:assert/strict";
import { describe, test } from "node:test";
import {
  COMPLETION_AUTO_RETRY_MAX_ATTEMPTS,
  COMPLETION_RETRY_DELAYS_MS,
  completionErrorDismissKey,
  conversationHasCompletionFailure,
  deriveConversationCompletionError,
  isCesiumFailureAssistantChunk,
  isCompletionFailureThreadContent,
  isRetryableError,
  shouldHideCompletionFailureInThread,
  normalizeCompletionFailureText,
  parseAgentCompletionError,
} from "../src/lib/agent-completion-error.ts";
import type { AgentConversationRecord, AgentStoredEvent } from "../src/lib/agent-types.ts";

describe("agent completion error parsing", () => {
  test("parses HTTP status and nested JSON message", () => {
    const view = parseAgentCompletionError(
      'Cesium Agent failed: 401 Unauthorized {"error":{"message":"Invalid API key"}}'
    );
    assert.equal(view.httpStatus, 401);
    assert.equal(view.title, "Authentication failed");
    assert.equal(view.summary, "Invalid API key");
    assert.equal(view.retryable, false);
  });

  test("marks transient provider failures as retryable", () => {
    const view = parseAgentCompletionError("504 Gateway Timeout upstream");
    assert.equal(view.httpStatus, 504);
    assert.equal(view.retryable, true);
    assert.equal(isRetryableError(view), true);
  });

  test("normalizes duplicate failure text", () => {
    const raw = "Cesium Agent failed: 429 Too Many Requests";
    assert.equal(normalizeCompletionFailureText(raw), "429 Too Many Requests");
    assert.equal(isCesiumFailureAssistantChunk(raw), true);
    assert.equal(isCesiumFailureAssistantChunk("Hello"), false);
  });

  test("uses stable dismiss keys", () => {
    assert.equal(
      completionErrorDismissKey("conv-1", "boom"),
      "conv-1\0boom"
    );
  });

  test("exposes retry backoff schedule", () => {
    assert.deepEqual(COMPLETION_RETRY_DELAYS_MS, [5_000, 15_000, 30_000]);
    assert.equal(COMPLETION_AUTO_RETRY_MAX_ATTEMPTS, 3);
  });

  test("detects provider errors that should not render in the thread", () => {
    const toolCallError =
      "An assistant message with 'tool_calls' must be followed by tool messages responding to each 'tool_call_id'. The following tool_call_ids did not have response messages: abc123.";
    assert.equal(isCompletionFailureThreadContent(toolCallError), true);
    assert.equal(
      shouldHideCompletionFailureInThread("Completion failed", toolCallError),
      true
    );
  });

  test("derives completion errors from stored events when lastError is empty", () => {
    const events: AgentStoredEvent[] = [
      {
        seq: 1,
        eventId: "st1",
        conversationId: "c1",
        createdAt: 1,
        kind: "status",
        status: "failed",
        detail: "429 Too Many Requests",
      },
    ];
    const conversation = {
      status: "running",
      lastError: null,
    } as AgentConversationRecord;
    assert.equal(
      deriveConversationCompletionError(conversation, events),
      "429 Too Many Requests"
    );
    assert.equal(conversationHasCompletionFailure(conversation, events), true);
  });
});
