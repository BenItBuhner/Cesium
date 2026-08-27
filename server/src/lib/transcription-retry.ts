import { sleepMs } from "./agents/completion-retry.js";

/**
 * Retry policy for upstream speech-transcription requests. Transient failures
 * (network errors, 408/429/5xx) are retried with exponential backoff before
 * the error surfaces to the client. Every knob is env-tunable:
 *
 * - `OPENCURSOR_TRANSCRIPTION_MAX_RETRIES` - automatic retries after the
 *   initial attempt (default 5, `0` disables retries).
 * - `OPENCURSOR_TRANSCRIPTION_RETRY_BASE_DELAY_MS` - first backoff delay,
 *   doubled on every subsequent retry (default 500).
 * - `OPENCURSOR_TRANSCRIPTION_RETRY_MAX_DELAY_MS` - cap for a single backoff
 *   delay (default 8000).
 */
export type TranscriptionRetryConfig = {
  maxRetries: number;
  baseDelayMs: number;
  maxDelayMs: number;
};

export const TRANSCRIPTION_RETRY_DEFAULTS: TranscriptionRetryConfig = {
  maxRetries: 5,
  baseDelayMs: 500,
  maxDelayMs: 8_000,
};

function readIntEnv(
  raw: string | undefined,
  fallback: number,
  min: number,
  max: number
): number {
  const trimmed = raw?.trim();
  if (!trimmed) {
    return fallback;
  }
  const parsed = Number.parseInt(trimmed, 10);
  if (!Number.isFinite(parsed)) {
    return fallback;
  }
  return Math.min(max, Math.max(min, parsed));
}

export function resolveTranscriptionRetryConfig(
  env: NodeJS.ProcessEnv = process.env
): TranscriptionRetryConfig {
  const maxRetries = readIntEnv(
    env.OPENCURSOR_TRANSCRIPTION_MAX_RETRIES,
    TRANSCRIPTION_RETRY_DEFAULTS.maxRetries,
    0,
    20
  );
  const baseDelayMs = readIntEnv(
    env.OPENCURSOR_TRANSCRIPTION_RETRY_BASE_DELAY_MS,
    TRANSCRIPTION_RETRY_DEFAULTS.baseDelayMs,
    50,
    60_000
  );
  const maxDelayMs = readIntEnv(
    env.OPENCURSOR_TRANSCRIPTION_RETRY_MAX_DELAY_MS,
    TRANSCRIPTION_RETRY_DEFAULTS.maxDelayMs,
    baseDelayMs,
    300_000
  );
  return { maxRetries, baseDelayMs, maxDelayMs };
}

/** Backoff before retry N (1-based): base * 2^(N-1), capped at maxDelayMs. */
export function transcriptionRetryDelayMs(
  retry: number,
  config: TranscriptionRetryConfig
): number {
  const exponent = Math.max(0, retry - 1);
  const uncapped = config.baseDelayMs * 2 ** exponent;
  return Math.min(config.maxDelayMs, uncapped);
}

/** Timeouts, rate limits, and provider-side (5xx) errors are worth retrying. */
export function isRetryableTranscriptionStatus(status: number): boolean {
  return status === 408 || status === 429 || status >= 500;
}

export type TranscriptionFetchResult = {
  response: Response;
  /** Total attempts made, including the successful/final one. */
  attempts: number;
};

/**
 * Runs `doFetch` up to `1 + maxRetries` times. Network-level throws and
 * retryable HTTP statuses trigger backoff; any other response returns
 * immediately. When every attempt throws, the last error is rethrown with
 * attempt context so the route can surface a useful message.
 */
export async function fetchTranscriptionWithRetry(
  doFetch: () => Promise<Response>,
  config: TranscriptionRetryConfig,
  sleep: (ms: number) => Promise<void> = sleepMs
): Promise<TranscriptionFetchResult> {
  const totalAttempts = 1 + config.maxRetries;
  let lastError: unknown = null;
  let lastResponse: Response | null = null;

  for (let attempt = 1; attempt <= totalAttempts; attempt += 1) {
    if (attempt > 1) {
      await sleep(transcriptionRetryDelayMs(attempt - 1, config));
    }
    try {
      const response = await doFetch();
      if (response.ok || !isRetryableTranscriptionStatus(response.status)) {
        return { response, attempts: attempt };
      }
      lastResponse = response;
      lastError = null;
      if (attempt < totalAttempts) {
        // Drop the retryable body; only the final response is read by callers.
        await response.body?.cancel().catch(() => undefined);
      }
    } catch (error) {
      lastError = error;
      lastResponse = null;
    }
  }

  if (lastResponse) {
    return { response: lastResponse, attempts: totalAttempts };
  }
  const message = lastError instanceof Error ? lastError.message : String(lastError);
  throw new Error(
    `Transcription provider unreachable after ${totalAttempts} attempt${totalAttempts === 1 ? "" : "s"}: ${message}`
  );
}
