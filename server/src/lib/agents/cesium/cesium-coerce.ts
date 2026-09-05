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

export function truncate(value: string, max = 40_000): string {
  return value.length > max ? `${value.slice(0, max)}\n...[truncated ${value.length - max} chars]` : value;
}

export function parseJsonArgs(value: unknown): Record<string, unknown> {
  if (asRecord(value)) {
    return value as Record<string, unknown>;
  }
  if (typeof value !== "string") {
    return {};
  }
  try {
    return asRecord(JSON.parse(value)) ?? {};
  } catch {
    return {};
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
