import type { RunResult } from "@cursor/sdk";

const SANDBOX_UNSUPPORTED_PATTERN = /sandboxing is not supported in this environment/i;

export function isCursorSdkSandboxUnsupportedError(error: unknown): boolean {
  let current: unknown = error;
  for (let depth = 0; depth < 5 && current != null; depth += 1) {
    const message =
      current instanceof Error
        ? current.message
        : typeof current === "string"
          ? current
          : null;
    if (message && SANDBOX_UNSUPPORTED_PATTERN.test(message)) {
      return true;
    }
    current = current instanceof Error ? current.cause : null;
  }
  return false;
}

export function cursorSdkRunFailureDetail(result: RunResult): string | null {
  if (result.status !== "error") {
    return null;
  }
  const message =
    result.error?.message?.trim() ||
    result.result?.trim() ||
    "Cursor SDK run failed.";
  const code = result.error?.code?.trim();
  return code && !message.includes(code) ? `${message} (${code})` : message;
}

export function isCursorSdkSandboxRunFailure(result: RunResult): boolean {
  const detail = cursorSdkRunFailureDetail(result);
  return detail !== null && SANDBOX_UNSUPPORTED_PATTERN.test(detail);
}
