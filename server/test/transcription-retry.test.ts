import assert from "node:assert/strict";
import { describe, test } from "node:test";
import {
  TRANSCRIPTION_RETRY_DEFAULTS,
  fetchTranscriptionWithRetry,
  isRetryableTranscriptionStatus,
  resolveTranscriptionRetryConfig,
  transcriptionRetryDelayMs,
} from "../src/lib/transcription-retry.js";

const noSleep = async () => {};

describe("resolveTranscriptionRetryConfig", () => {
  test("uses defaults when env is empty", () => {
    assert.deepEqual(resolveTranscriptionRetryConfig({}), TRANSCRIPTION_RETRY_DEFAULTS);
    assert.equal(TRANSCRIPTION_RETRY_DEFAULTS.maxRetries, 5);
  });

  test("reads overrides from env vars", () => {
    const config = resolveTranscriptionRetryConfig({
      OPENCURSOR_TRANSCRIPTION_MAX_RETRIES: "2",
      OPENCURSOR_TRANSCRIPTION_RETRY_BASE_DELAY_MS: "100",
      OPENCURSOR_TRANSCRIPTION_RETRY_MAX_DELAY_MS: "400",
    });
    assert.deepEqual(config, { maxRetries: 2, baseDelayMs: 100, maxDelayMs: 400 });
  });

  test("clamps out-of-range values and ignores garbage", () => {
    const config = resolveTranscriptionRetryConfig({
      OPENCURSOR_TRANSCRIPTION_MAX_RETRIES: "9999",
      OPENCURSOR_TRANSCRIPTION_RETRY_BASE_DELAY_MS: "-5",
      OPENCURSOR_TRANSCRIPTION_RETRY_MAX_DELAY_MS: "not-a-number",
    });
    assert.equal(config.maxRetries, 20);
    assert.equal(config.baseDelayMs, 50);
    assert.equal(config.maxDelayMs, TRANSCRIPTION_RETRY_DEFAULTS.maxDelayMs);
  });

  test("maxDelayMs is never below baseDelayMs", () => {
    const config = resolveTranscriptionRetryConfig({
      OPENCURSOR_TRANSCRIPTION_RETRY_BASE_DELAY_MS: "10000",
      OPENCURSOR_TRANSCRIPTION_RETRY_MAX_DELAY_MS: "100",
    });
    assert.equal(config.maxDelayMs, config.baseDelayMs);
  });

  test("zero retries disables automatic retrying", () => {
    const config = resolveTranscriptionRetryConfig({
      OPENCURSOR_TRANSCRIPTION_MAX_RETRIES: "0",
    });
    assert.equal(config.maxRetries, 0);
  });
});

describe("transcriptionRetryDelayMs", () => {
  test("doubles each retry and caps at maxDelayMs", () => {
    const config = { maxRetries: 5, baseDelayMs: 500, maxDelayMs: 8000 };
    assert.deepEqual(
      [1, 2, 3, 4, 5, 6].map((n) => transcriptionRetryDelayMs(n, config)),
      [500, 1000, 2000, 4000, 8000, 8000]
    );
  });
});

describe("isRetryableTranscriptionStatus", () => {
  test("retries timeouts, rate limits, and server errors only", () => {
    assert.equal(isRetryableTranscriptionStatus(408), true);
    assert.equal(isRetryableTranscriptionStatus(429), true);
    assert.equal(isRetryableTranscriptionStatus(500), true);
    assert.equal(isRetryableTranscriptionStatus(503), true);
    assert.equal(isRetryableTranscriptionStatus(400), false);
    assert.equal(isRetryableTranscriptionStatus(401), false);
    assert.equal(isRetryableTranscriptionStatus(404), false);
  });
});

describe("fetchTranscriptionWithRetry", () => {
  const config = { maxRetries: 3, baseDelayMs: 10, maxDelayMs: 40 };

  test("returns immediately on first success", async () => {
    let calls = 0;
    const { response, attempts } = await fetchTranscriptionWithRetry(
      async () => {
        calls += 1;
        return new Response("{\"text\":\"hi\"}", { status: 200 });
      },
      config,
      noSleep
    );
    assert.equal(calls, 1);
    assert.equal(attempts, 1);
    assert.equal(response.status, 200);
  });

  test("retries network errors until success", async () => {
    let calls = 0;
    const { response, attempts } = await fetchTranscriptionWithRetry(
      async () => {
        calls += 1;
        if (calls < 3) {
          throw new Error("ECONNREFUSED");
        }
        return new Response("ok", { status: 200 });
      },
      config,
      noSleep
    );
    assert.equal(attempts, 3);
    assert.equal(response.status, 200);
  });

  test("retries retryable statuses until success", async () => {
    let calls = 0;
    const { response, attempts } = await fetchTranscriptionWithRetry(
      async () => {
        calls += 1;
        return calls < 2
          ? new Response("busy", { status: 503 })
          : new Response("ok", { status: 200 });
      },
      config,
      noSleep
    );
    assert.equal(attempts, 2);
    assert.equal(response.status, 200);
  });

  test("does not retry non-retryable statuses", async () => {
    let calls = 0;
    const { response, attempts } = await fetchTranscriptionWithRetry(
      async () => {
        calls += 1;
        return new Response("bad key", { status: 401 });
      },
      config,
      noSleep
    );
    assert.equal(calls, 1);
    assert.equal(attempts, 1);
    assert.equal(response.status, 401);
  });

  test("returns the final retryable response after exhausting retries", async () => {
    let calls = 0;
    const { response, attempts } = await fetchTranscriptionWithRetry(
      async () => {
        calls += 1;
        return new Response("still down", { status: 502 });
      },
      config,
      noSleep
    );
    assert.equal(calls, 1 + config.maxRetries);
    assert.equal(attempts, 1 + config.maxRetries);
    assert.equal(response.status, 502);
    assert.equal(await response.text(), "still down");
  });

  test("throws with attempt context when every attempt is a network error", async () => {
    let calls = 0;
    await assert.rejects(
      fetchTranscriptionWithRetry(
        async () => {
          calls += 1;
          throw new Error("fetch failed");
        },
        config,
        noSleep
      ),
      /unreachable after 4 attempts: fetch failed/
    );
    assert.equal(calls, 4);
  });

  test("sleeps with exponential backoff between attempts", async () => {
    const delays: number[] = [];
    let calls = 0;
    await fetchTranscriptionWithRetry(
      async () => {
        calls += 1;
        return new Response("down", { status: 500 });
      },
      config,
      async (ms) => {
        delays.push(ms);
      }
    );
    assert.deepEqual(delays, [10, 20, 40]);
    assert.equal(calls, 4);
  });

  test("respects maxRetries=0 (single attempt)", async () => {
    let calls = 0;
    const { attempts } = await fetchTranscriptionWithRetry(
      async () => {
        calls += 1;
        return new Response("down", { status: 500 });
      },
      { maxRetries: 0, baseDelayMs: 10, maxDelayMs: 10 },
      noSleep
    );
    assert.equal(calls, 1);
    assert.equal(attempts, 1);
  });
});
