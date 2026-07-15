import type {
  AgentConversationRecord,
  AgentConversationStatus,
  AgentStoredEvent,
} from "./protocol";

export type AgentCompletionErrorViewModel = {
  title: string;
  summary: string;
  detail?: string;
  httpStatus?: number;
  code?: string;
  retryable: boolean;
  rawMessage: string;
};

const CESIUM_FAILED_PREFIX = /^Cesium Agent failed:\s*/i;

export function isCesiumFailureAssistantChunk(text: string): boolean {
  return CESIUM_FAILED_PREFIX.test(text.trim());
}

const TOOL_CALL_PAIRING_ERROR =
  /assistant message with ['"]tool_calls['"] must be followed by tool messages/i;
const RATE_LIMIT_ERROR = /rate limit|too many requests|requests per minute/i;

/** Provider completion errors belong in the composer dock, not the message thread. */
export function isCompletionFailureThreadContent(text: string): boolean {
  const trimmed = text.trim();
  if (!trimmed) {
    return false;
  }
  if (isCesiumFailureAssistantChunk(trimmed)) {
    return true;
  }
  if (TOOL_CALL_PAIRING_ERROR.test(trimmed)) {
    return true;
  }
  if (RATE_LIMIT_ERROR.test(trimmed)) {
    return true;
  }
  if (/\b[45]\d{2}\b/.test(trimmed) && /error|invalid|unauthorized|forbidden|timeout/i.test(trimmed)) {
    return true;
  }
  return false;
}

export function shouldHideCompletionFailureInThread(label?: string, detail?: string): boolean {
  if (label === "Failed" || label === "Completion failed" || label === "Rate limited") {
    return true;
  }
  const combined = [label, detail].filter(Boolean).join("\n").trim();
  return isCompletionFailureThreadContent(combined);
}

/** Canonical summary used to dedupe system + status failure events in the thread. */
export function normalizeCompletionFailureText(message: string): string {
  return parseAgentCompletionError(message).summary.trim();
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

function parseHttpStatus(message: string): number | undefined {
  const match = message.match(/\b([1-5]\d{2})\s+[A-Za-z][\w-]*/);
  if (!match) {
    return undefined;
  }
  const status = Number.parseInt(match[1]!, 10);
  return Number.isFinite(status) ? status : undefined;
}

function defaultTitle(httpStatus?: number, code?: string): string {
  if (httpStatus === 429) {
    return "Rate limited";
  }
  if (httpStatus === 401 || httpStatus === 403) {
    return "Authentication failed";
  }
  if (httpStatus && httpStatus >= 500) {
    return "Provider unavailable";
  }
  if (code === "queueexceeded") {
    return "Provider queue full";
  }
  return "Completion failed";
}

export function isRetryableError(view: AgentCompletionErrorViewModel): boolean {
  if (!view.retryable) {
    return false;
  }
  const status = view.httpStatus;
  if (status === 401 || status === 403 || status === 400 || status === 404) {
    return false;
  }
  return true;
}

export function completionErrorDismissKey(conversationId: string, lastError: string): string {
  return `${conversationId}\0${lastError}`;
}

/** Prefer server `lastError`; fall back to the latest failed status / system error event. */
export function deriveConversationCompletionError(
  conversation: AgentConversationRecord | null | undefined,
  events: AgentStoredEvent[] | undefined
): string {
  const fromRecord = conversation?.lastError?.trim() ?? "";
  if (fromRecord) {
    return fromRecord;
  }
  if (!events?.length) {
    return "";
  }
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index]!;
    if (event.kind === "status" && event.status === "failed") {
      const detail = event.detail?.trim();
      if (detail) {
        return detail;
      }
    }
    if (event.kind === "system" && event.level === "error") {
      const text = event.text.trim();
      if (text) {
        return text;
      }
    }
  }
  return "";
}

export function conversationHasCompletionFailure(
  conversation: AgentConversationRecord | null | undefined,
  events: AgentStoredEvent[] | undefined
): boolean {
  if (conversation?.status === "failed") {
    return true;
  }
  if (!events?.length) {
    return false;
  }
  return events.some((event) => event.kind === "status" && event.status === "failed");
}

function isComposerActiveStatus(status: AgentConversationStatus): boolean {
  return (
    status === "running" ||
    status === "pause_requested" ||
    status === "pausing" ||
    status === "awaiting_permission" ||
    status === "awaiting_question"
  );
}

/**
 * Composer primary control (send vs stop): treat stale `running` with a surfaced
 * completion failure as idle so the error dock and retry flow are usable.
 */
export function isAgentComposerBusy(
  conversation: AgentConversationRecord | null | undefined,
  events?: AgentStoredEvent[]
): boolean {
  if (!conversation) {
    return false;
  }
  if (!isComposerActiveStatus(conversation.status)) {
    return false;
  }
  if (conversationHasCompletionFailure(conversation, events)) {
    return false;
  }
  return true;
}

export const COMPLETION_RETRY_MIN_BUSY_MS = 800;

export function parseAgentCompletionError(
  message: string
): AgentCompletionErrorViewModel {
  const rawMessage = message.trim();
  const working = rawMessage.replace(CESIUM_FAILED_PREFIX, "").trim();
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

  const title = defaultTitle(httpStatus, code);
  const retryable =
    httpStatus === 429 ||
    (httpStatus !== undefined && httpStatus >= 500) ||
    code === "queueexceeded" ||
    /timeout|timed out|econnreset|network/i.test(summary);

  const detail =
    working.length > summary.length + 24 || working !== summary ? working : undefined;

  return {
    title,
    summary,
    detail,
    httpStatus,
    code,
    retryable,
    rawMessage,
  };
}

/** Backoff delays (ms) before auto-retry attempts 1–3. */
export const COMPLETION_RETRY_DELAYS_MS = [5_000, 15_000, 30_000] as const;

export const COMPLETION_AUTO_RETRY_MAX_ATTEMPTS = COMPLETION_RETRY_DELAYS_MS.length;

export const TAKING_LONGER_STATUS_PREFIX = "Taking longer";

export const COMPRESSING_CONTEXT_STATUS_PREFIX = "Compressing context";

export function isTakingLongerStatusDetail(detail: string | undefined): boolean {
  return detail?.trim().startsWith(TAKING_LONGER_STATUS_PREFIX) ?? false;
}

export function isCompressingContextStatusDetail(detail: string | undefined): boolean {
  return detail?.trim().startsWith(COMPRESSING_CONTEXT_STATUS_PREFIX) ?? false;
}

export function computeCompletionRetriesRemaining(attemptIndex: number): number {
  return Math.max(0, COMPLETION_AUTO_RETRY_MAX_ATTEMPTS - attemptIndex);
}

export function computeCompletionRetryDelayMs(attemptIndex: number): number {
  return (
    COMPLETION_RETRY_DELAYS_MS[
      Math.min(attemptIndex, COMPLETION_RETRY_DELAYS_MS.length - 1)
    ] ?? COMPLETION_RETRY_DELAYS_MS[0]!
  );
}

export function computeCompletionAutoRetryActive(input: {
  visible: boolean;
  supportsRetry: boolean;
  autoRetryEnabled: boolean;
  halted: boolean;
  retryable: boolean;
  attemptIndex: number;
  retryBusy: boolean;
  /** @deprecated Client retry owns the visible three-attempt countdown. */
  serverHandlesAutoRetry?: boolean;
}): boolean {
  return (
    input.visible &&
    input.supportsRetry &&
    input.autoRetryEnabled &&
    !input.halted &&
    input.retryable &&
    input.attemptIndex < COMPLETION_AUTO_RETRY_MAX_ATTEMPTS &&
    !input.retryBusy
  );
}

/** Smooth 0–1 progress for the retry countdown ring. */
export function computeRetryCountdownProgress(
  elapsedMs: number,
  delayMs: number
): number {
  if (delayMs <= 0) {
    return 1;
  }
  return Math.min(1, Math.max(0, elapsedMs / delayMs));
}
