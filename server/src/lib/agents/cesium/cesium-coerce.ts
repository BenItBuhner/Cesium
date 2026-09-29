import { asRecord, asString } from "../../coerce.js";

// asString here TRIMS (whitespace-only -> undefined), deliberately unlike the
// untrimmed json-coerce.ts variant; both re-exports share the canonical lib/coerce.ts.
export { asRecord, asString, asStringArray } from "../../coerce.js";

/** Finite number, also accepting numeric strings ("42" -> 42). */
export function asNumber(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }
  if (typeof value === "string" && value.trim()) {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) {
      return parsed;
    }
  }
  return undefined;
}

export function safeJson(value: unknown): string {
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

export { truncate, truncateMiddle, truncationMarker } from "@cesium/core/cesium-coerce";

export function parseJsonArgs(value: unknown): Record<string, unknown> {
  return tryParseJsonArgs(value).args;
}

/**
 * `parseJsonArgs` that also reports whether the text parsed: `ok` is false
 * only for a non-blank string that is not JSON (e.g. arguments cut off
 * mid-stream), so callers can tell a broken call from an empty one.
 */
export function tryParseJsonArgs(value: unknown): { args: Record<string, unknown>; ok: boolean } {
  if (asRecord(value)) {
    return { args: value as Record<string, unknown>, ok: true };
  }
  if (typeof value !== "string" || !value.trim()) {
    return { args: {}, ok: true };
  }
  try {
    return { args: asRecord(JSON.parse(value)) ?? {}, ok: true };
  } catch {
    return { args: {}, ok: false };
  }
}

export function pickFirstString(
  record: Record<string, unknown> | null | undefined,
  keys: readonly string[]
): string | undefined {
  if (!record) {
    return undefined;
  }
  for (const key of keys) {
    const value = asString(record[key]);
    if (value) {
      return value;
    }
  }
  return undefined;
}
