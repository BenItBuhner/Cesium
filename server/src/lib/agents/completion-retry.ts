/** Backoff delays (ms) before automatic provider retries 1–3. */
export const COMPLETION_RETRY_DELAYS_MS = [5_000, 15_000, 30_000] as const;

export const COMPLETION_AUTO_RETRY_MAX_ATTEMPTS = COMPLETION_RETRY_DELAYS_MS.length;

export const TAKING_LONGER_STATUS_PREFIX = "Taking longer";

export const COMPRESSING_CONTEXT_STATUS_PREFIX = "Compressing context";

export function formatTakingLongerStatusDetail(attempt: number, maxAttempts: number): string {
  return `${TAKING_LONGER_STATUS_PREFIX} — retrying provider request (${attempt}/${maxAttempts})…`;
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

export function sleepMs(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
