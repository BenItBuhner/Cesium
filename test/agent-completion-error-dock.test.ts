import assert from "node:assert/strict";
import { describe, test } from "node:test";
import {
  COMPLETION_AUTO_RETRY_MAX_ATTEMPTS,
  COMPLETION_RETRY_DELAYS_MS,
  computeCompletionAutoRetryActive,
  computeCompletionRetriesRemaining,
  computeCompletionRetryDelayMs,
  computeRetryCountdownProgress,
} from "../src/lib/agent-completion-error.ts";

describe("agent completion error dock logic", () => {
  test("computes retries remaining from attempt index", () => {
    assert.equal(computeCompletionRetriesRemaining(0), 3);
    assert.equal(computeCompletionRetriesRemaining(1), 2);
    assert.equal(computeCompletionRetriesRemaining(2), 1);
    assert.equal(computeCompletionRetriesRemaining(3), 0);
    assert.equal(computeCompletionRetriesRemaining(9), 0);
  });

  test("uses escalating retry delays per attempt", () => {
    assert.equal(computeCompletionRetryDelayMs(0), COMPLETION_RETRY_DELAYS_MS[0]);
    assert.equal(computeCompletionRetryDelayMs(1), COMPLETION_RETRY_DELAYS_MS[1]);
    assert.equal(computeCompletionRetryDelayMs(2), COMPLETION_RETRY_DELAYS_MS[2]);
    assert.equal(
      computeCompletionRetryDelayMs(5),
      COMPLETION_RETRY_DELAYS_MS[COMPLETION_RETRY_DELAYS_MS.length - 1]
    );
  });

  test("auto retry stops when halted, exhausted, or busy", () => {
    const base = {
      visible: true,
      supportsRetry: true,
      autoRetryEnabled: true,
      halted: false,
      retryable: true,
      attemptIndex: 0,
      retryBusy: false,
    };
    assert.equal(computeCompletionAutoRetryActive(base), true);
    assert.equal(computeCompletionAutoRetryActive({ ...base, halted: true }), false);
    assert.equal(
      computeCompletionAutoRetryActive({
        ...base,
        attemptIndex: COMPLETION_AUTO_RETRY_MAX_ATTEMPTS,
      }),
      false
    );
    assert.equal(computeCompletionAutoRetryActive({ ...base, retryBusy: true }), false);
    assert.equal(computeCompletionAutoRetryActive({ ...base, autoRetryEnabled: false }), false);
    assert.equal(computeCompletionAutoRetryActive({ ...base, visible: false }), false);
    assert.equal(computeCompletionAutoRetryActive({ ...base, retryable: false }), false);
    assert.equal(
      computeCompletionAutoRetryActive({ ...base, serverHandlesAutoRetry: true }),
      true
    );
  });

  test("countdown progress is clamped and linear", () => {
    assert.equal(computeRetryCountdownProgress(0, 10_000), 0);
    assert.equal(computeRetryCountdownProgress(2_500, 10_000), 0.25);
    assert.equal(computeRetryCountdownProgress(10_000, 10_000), 1);
    assert.equal(computeRetryCountdownProgress(20_000, 10_000), 1);
    assert.equal(computeRetryCountdownProgress(1_000, 0), 1);
  });
});
