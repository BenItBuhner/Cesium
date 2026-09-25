import assert from "node:assert/strict";
import { describe, test } from "node:test";
import {
  COMPLETION_AUTO_RETRY_MAX_ATTEMPTS,
  COMPLETION_RETRY_DELAYS_MS,
  completionRetryDelayMs,
  detectUpstreamErrorPayload,
  findUpstreamErrorPayload,
  formatTakingLongerStatusDetail,
  formatCompressingContextStatusDetail,
  isTransientProviderCompletionError,
  setCompletionRetryDelaysForTests,
} from "../src/lib/agents/completion-retry.js";

describe("completion retry helpers", () => {
  test("detects transient HTTP provider failures", () => {
    assert.equal(isTransientProviderCompletionError("502 Bad Gateway upstream"), true);
    assert.equal(isTransientProviderCompletionError("503 Service Unavailable"), true);
    assert.equal(isTransientProviderCompletionError("504 Gateway Timeout"), true);
    assert.equal(isTransientProviderCompletionError("429 Too Many Requests"), true);
    assert.equal(isTransientProviderCompletionError("500 Internal Server Error"), true);
  });

  test("detects transient network and timeout failures", () => {
    assert.equal(isTransientProviderCompletionError("fetch failed: ECONNRESET"), true);
    assert.equal(isTransientProviderCompletionError("Request timed out after 120000ms"), true);
    assert.equal(isTransientProviderCompletionError('{"code":"queueexceeded","message":"busy"}'), true);
  });

  test("rejects non-retryable auth and client errors", () => {
    assert.equal(isTransientProviderCompletionError("401 Unauthorized"), false);
    assert.equal(isTransientProviderCompletionError("403 Forbidden"), false);
    assert.equal(isTransientProviderCompletionError("400 Bad Request"), false);
    assert.equal(isTransientProviderCompletionError("404 Not Found"), false);
    assert.equal(isTransientProviderCompletionError("Unknown tool: foo"), false);
  });

  test("formats taking longer status detail", () => {
    assert.equal(
      formatTakingLongerStatusDetail(1, COMPLETION_AUTO_RETRY_MAX_ATTEMPTS),
      "Taking longer - retrying provider request (1/3)…"
    );
  });

  test("formats compressing context status detail", () => {
    assert.equal(formatCompressingContextStatusDetail(), "Compressing context…");
  });

  test("exposes retry schedule", () => {
    assert.deepEqual(COMPLETION_RETRY_DELAYS_MS, [5_000, 15_000, 30_000]);
    assert.equal(COMPLETION_AUTO_RETRY_MAX_ATTEMPTS, 3);
    assert.deepEqual([0, 1, 2, 3].map(completionRetryDelayMs), [5_000, 15_000, 30_000, 30_000]);
  });

  test("the test hook shortens the backoff and null restores it", () => {
    setCompletionRetryDelaysForTests([1, 2]);
    try {
      assert.deepEqual([0, 1, 2].map(completionRetryDelayMs), [1, 2, 2]);
    } finally {
      setCompletionRetryDelaysForTests(null);
    }
    assert.equal(completionRetryDelayMs(0), 5_000);
  });
});

describe("upstream error payloads inside HTTP 200", () => {
  test("ignores successful chunks and responses", () => {
    assert.equal(detectUpstreamErrorPayload({ choices: [{ delta: { content: "hi" } }] }), null);
    assert.equal(detectUpstreamErrorPayload({ object: "response", status: "completed", error: null }), null);
    assert.equal(
      detectUpstreamErrorPayload({ type: "response.created", response: { error: null } }),
      null
    );
    assert.equal(detectUpstreamErrorPayload("data"), null);
    assert.equal(detectUpstreamErrorPayload(undefined), null);
  });

  test("reads chat-completions error chunks", () => {
    assert.deepEqual(
      detectUpstreamErrorPayload({
        error: { message: "Service temporarily unavailable", type: "service_unavailable", code: 503 },
      }),
      { message: "service_unavailable: Service temporarily unavailable", retryable: true }
    );
    assert.deepEqual(
      detectUpstreamErrorPayload({ error: { message: "Rate limit exceeded: free-models-per-day", code: 429 } }),
      { message: "429: Rate limit exceeded: free-models-per-day", retryable: true }
    );
    assert.deepEqual(detectUpstreamErrorPayload({ error: "upstream connect error" }), {
      message: "upstream connect error",
      retryable: true,
    });
  });

  test("reads Responses API error and response.failed events", () => {
    assert.deepEqual(
      detectUpstreamErrorPayload({ type: "error", code: "server_error", message: "The server had an error" }),
      { message: "server_error: The server had an error", retryable: true }
    );
    assert.deepEqual(
      detectUpstreamErrorPayload({
        type: "response.failed",
        response: { status: "failed", error: { code: "rate_limit_exceeded", message: "Slow down" } },
      }),
      { message: "rate_limit_exceeded: Slow down", retryable: true }
    );
    assert.deepEqual(
      detectUpstreamErrorPayload({
        type: "response.failed",
        response: { status: "failed", error: { code: "context_length_exceeded", message: "Too long" } },
      }),
      { message: "context_length_exceeded: Too long", retryable: false }
    );
  });

  test("reads Anthropic and Google error bodies", () => {
    assert.deepEqual(
      detectUpstreamErrorPayload({ type: "error", error: { type: "overloaded_error", message: "Overloaded" } }),
      { message: "overloaded_error: Overloaded", retryable: true }
    );
    assert.equal(
      detectUpstreamErrorPayload({ type: "error", error: { type: "authentication_error", message: "bad key" } })
        ?.retryable,
      false
    );
    assert.deepEqual(
      detectUpstreamErrorPayload({ error: { code: 503, message: "The model is overloaded.", status: "UNAVAILABLE" } }),
      { message: "UNAVAILABLE: The model is overloaded.", retryable: true }
    );
    assert.equal(
      detectUpstreamErrorPayload({ error: { code: 400, message: "Bad schema", status: "INVALID_ARGUMENT" } })
        ?.retryable,
      false
    );
  });

  test("client-side causes are not retried", () => {
    for (const error of [
      { code: "invalid_api_key", message: "Incorrect API key provided" },
      { code: 404, message: "No endpoints found for model x" },
      { code: "insufficient_quota", message: "You exceeded your current quota" },
      { code: 403, message: "Forbidden" },
      { type: "invalid_request_error", message: "messages: field required" },
    ]) {
      assert.equal(detectUpstreamErrorPayload({ error })?.retryable, false, JSON.stringify(error));
    }
  });

  test("findUpstreamErrorPayload scans every raw event", () => {
    assert.equal(findUpstreamErrorPayload([{ choices: [] }, { choices: [] }]), null);
    assert.deepEqual(
      findUpstreamErrorPayload([{ choices: [] }, { error: { message: "boom", code: 500 } }]),
      { message: "500: boom", retryable: true }
    );
    assert.deepEqual(findUpstreamErrorPayload({ error: { message: "boom" } }), {
      message: "boom",
      retryable: true,
    });
  });
});
