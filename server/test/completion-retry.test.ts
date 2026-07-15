import assert from "node:assert/strict";
import { describe, test } from "node:test";
import {
  COMPLETION_AUTO_RETRY_MAX_ATTEMPTS,
  COMPLETION_RETRY_DELAYS_MS,
  formatTakingLongerStatusDetail,
  formatCompressingContextStatusDetail,
  isTransientProviderCompletionError,
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
      "Taking longer — retrying provider request (1/3)…"
    );
  });

  test("formats compressing context status detail", () => {
    assert.equal(formatCompressingContextStatusDetail(), "Compressing context…");
  });

  test("exposes retry schedule", () => {
    assert.deepEqual(COMPLETION_RETRY_DELAYS_MS, [5_000, 15_000, 30_000]);
    assert.equal(COMPLETION_AUTO_RETRY_MAX_ATTEMPTS, 3);
  });
});
