/** Backoff delays (ms) before automatic provider retries 1–3. */
export const COMPLETION_RETRY_DELAYS_MS = [5_000, 15_000, 30_000] as const;

export const COMPLETION_AUTO_RETRY_MAX_ATTEMPTS = COMPLETION_RETRY_DELAYS_MS.length;

let retryDelaysOverrideForTests: readonly number[] | null = null;

/** Shortens the provider retry backoff so tests don't sleep for real; `null` restores it. */
export function setCompletionRetryDelaysForTests(delays: readonly number[] | null): void {
  retryDelaysOverrideForTests = delays;
}

/** Backoff before automatic retry `retryIndex + 1`. */
export function completionRetryDelayMs(retryIndex: number): number {
  const delays = retryDelaysOverrideForTests ?? COMPLETION_RETRY_DELAYS_MS;
  return delays[Math.min(retryIndex, delays.length - 1)] ?? COMPLETION_RETRY_DELAYS_MS[0];
}

export const TAKING_LONGER_STATUS_PREFIX = "Taking longer";

export const COMPRESSING_CONTEXT_STATUS_PREFIX = "Compressing context";

export function formatTakingLongerStatusDetail(attempt: number, maxAttempts: number): string {
  return `${TAKING_LONGER_STATUS_PREFIX} - retrying provider request (${attempt}/${maxAttempts})…`;
}

export function formatCompressingContextStatusDetail(): string {
  return `${COMPRESSING_CONTEXT_STATUS_PREFIX}…`;
}

export function isCompressingContextStatusDetail(detail: string | undefined): boolean {
  return detail?.trim().startsWith(COMPRESSING_CONTEXT_STATUS_PREFIX) ?? false;
}

function parseHttpStatus(message: string): number | undefined {
  const match = message.match(/\b([1-5]\d{2})\s+[A-Za-z][\w-]*/);
  if (!match) {
    return undefined;
  }
  const status = Number.parseInt(match[1]!, 10);
  return Number.isFinite(status) ? status : undefined;
}

function tryParseJsonObject(text: string): Record<string, unknown> | null {
  const trimmed = text.trim();
  if (!trimmed.startsWith("{")) {
    return null;
  }
  try {
    const parsed = JSON.parse(trimmed) as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

function extractEmbeddedJson(message: string): Record<string, unknown> | null {
  const direct = tryParseJsonObject(message);
  if (direct) {
    return direct;
  }
  const brace = message.indexOf("{");
  if (brace < 0) {
    return null;
  }
  return tryParseJsonObject(message.slice(brace));
}

function readNestedMessage(record: Record<string, unknown>): string | undefined {
  const error = record.error;
  if (typeof error === "string" && error.trim()) {
    return error.trim();
  }
  if (error && typeof error === "object" && !Array.isArray(error)) {
    const nested = error as Record<string, unknown>;
    const message = nested.message;
    if (typeof message === "string" && message.trim()) {
      return message.trim();
    }
  }
  const message = record.message;
  return typeof message === "string" && message.trim() ? message.trim() : undefined;
}

function summarizeProviderError(message: string): { httpStatus?: number; code?: string; summary: string } {
  const working = message.replace(/^Cesium Agent failed:\s*/i, "").trim();
  const httpStatus = parseHttpStatus(working);
  const json = extractEmbeddedJson(working);
  let code: string | undefined;
  let summary = working;

  if (json) {
    const nested = readNestedMessage(json);
    if (nested) {
      summary = nested;
    }
    const codeValue = json.code;
    if (typeof codeValue === "string") {
      code = codeValue;
    }
    const errorObj = json.error;
    if (!code && errorObj && typeof errorObj === "object" && !Array.isArray(errorObj)) {
      const errCode = (errorObj as Record<string, unknown>).code;
      if (typeof errCode === "string") {
        code = errCode;
      }
    }
  }

  return { httpStatus, code, summary };
}

/** True for 429/5xx, queue exceeded, gateway timeout, and similar provider/network flakes. */
export function isTransientProviderCompletionError(message: string): boolean {
  const trimmed = message.trim();
  if (!trimmed) {
    return false;
  }

  const { httpStatus, code, summary } = summarizeProviderError(trimmed);
  if (httpStatus === 401 || httpStatus === 403 || httpStatus === 400 || httpStatus === 404) {
    return false;
  }
  if (
    httpStatus === 429 ||
    (httpStatus !== undefined && httpStatus >= 500) ||
    code === "queueexceeded" ||
    /timeout|timed out|econnreset|network|gateway timeout|provider unavailable|service unavailable|bad gateway/i.test(
      summary
    ) ||
    /timeout|timed out|econnreset|network|gateway timeout|provider unavailable|service unavailable|bad gateway/i.test(
      trimmed
    )
  ) {
    return true;
  }
  return false;
}

export type UpstreamErrorPayload = {
  /** `code: message` as the upstream reported it. */
  message: string;
  retryable: boolean;
};

const NON_RETRYABLE_UPSTREAM_ERROR =
  /invalid[_\s-]?(request|api[_\s-]?key|argument)|unauthori[sz]ed|unauthenticated|authentication|permission|forbidden|not[_\s-]?found|does not exist|context[_\s-]?(length|window)|maximum context|too many tokens|insufficient[_\s-]?quota|billing|content[_\s-]?(filter|policy)|unsupported|failed[_\s-]?precondition/i;

function objectRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function nonEmptyString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function numericStatus(value: unknown): number | undefined {
  const parsed =
    typeof value === "number"
      ? value
      : typeof value === "string" && /^\d{3}$/.test(value.trim())
        ? Number.parseInt(value, 10)
        : Number.NaN;
  return Number.isInteger(parsed) && parsed >= 100 && parsed <= 599 ? parsed : undefined;
}

/**
 * Reads an error that arrived inside a successful (HTTP 200) response: an
 * `{"error":...}` chunk in a chat stream, a Responses API `error` or
 * `response.failed` event, or an Anthropic / Google error body. Anything
 * without a client-side cause (bad request, auth, unknown model, context or
 * quota) counts as a retryable upstream blip.
 */
export function detectUpstreamErrorPayload(raw: unknown): UpstreamErrorPayload | null {
  const record = objectRecord(raw);
  if (!record) {
    return null;
  }
  let error: unknown;
  if (record.type === "response.failed") {
    error = objectRecord(record.response)?.error ?? "The provider reported response.failed.";
  } else if (record.type === "error") {
    error = record.error ?? record;
  } else if (record.error !== undefined && record.error !== null && record.error !== "") {
    error = record.error;
  } else {
    return null;
  }
  const detail = objectRecord(error) ?? {};
  const message =
    nonEmptyString(error) ??
    nonEmptyString(detail.message) ??
    nonEmptyString(objectRecord(detail.metadata)?.raw) ??
    "The provider returned an error with no message.";
  const code = nonEmptyString(detail.code) ?? nonEmptyString(detail.type) ?? nonEmptyString(detail.status);
  const status = numericStatus(detail.code) ?? numericStatus(detail.status);
  const clientError =
    status !== undefined && status >= 400 && status < 500 && ![408, 409, 425, 429].includes(status);
  const signals = [detail.type, detail.code, detail.status, message]
    .filter((value): value is string => typeof value === "string")
    .join(" ");
  return {
    message: code && code !== message ? `${code}: ${message}` : status ? `${status}: ${message}` : message,
    retryable: !clientError && !NON_RETRYABLE_UPSTREAM_ERROR.test(signals),
  };
}

/** First upstream error payload among an adapter result's raw events. */
export function findUpstreamErrorPayload(raw: unknown): UpstreamErrorPayload | null {
  for (const event of Array.isArray(raw) ? raw : [raw]) {
    const found = detectUpstreamErrorPayload(event);
    if (found) {
      return found;
    }
  }
  return null;
}

export function sleepMs(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
