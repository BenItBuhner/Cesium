/**
 * Canonical coercion helpers for untrusted JSON (settings files, tool
 * arguments, webhook payloads, CLI output). Import these instead of declaring
 * a file-local copy; the variants with different semantics live next to the
 * code that needs them (`agents/json-coerce.ts` keeps untrimmed strings and
 * `undefined` records, `agents/cesium/cesium-coerce.ts` parses numeric
 * strings, `agents/import/reader-utils.ts` accepts empty strings).
 */

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Plain object (not an array) or `null`. */
export function asRecord(value: unknown): Record<string, unknown> | null {
  return isRecord(value) ? value : null;
}

/** Trimmed, non-empty string or `undefined`. */
export function asString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

/** Finite number or `undefined`; numeric strings are not coerced. */
export function asNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

export function asStringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((entry): entry is string => typeof entry === "string")
    : [];
}

export function asError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}
