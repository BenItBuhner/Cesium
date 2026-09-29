/**
 * Coercion and truncation helpers shared by both Cesium harness engines (the
 * server turn loop and the browser machine). `asString` trims: whitespace-only
 * values count as missing.
 */

export function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

export function asString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

export function parseJsonArgs(value: unknown): Record<string, unknown> {
  if (asRecord(value)) {
    return value as Record<string, unknown>;
  }
  if (typeof value !== "string" || !value.trim()) {
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

/** Head-only truncation. Use for previews where only the opening matters. */
export function truncate(value: string, max = 40_000): string {
  return value.length > max ? `${value.slice(0, max)}\n...[truncated ${value.length - max} chars]` : value;
}

export function truncationMarker(omitted: number): string {
  return `\n...[truncated ${omitted} chars from the middle]...\n`;
}

/**
 * Head+tail truncation. Keeps the first and last `max / 2` characters and
 * replaces the middle with an explicit elision marker, so the most recent end
 * (final test output, latest activity) survives alongside the opening.
 */
export function truncateMiddle(value: string, max = 40_000): string {
  if (value.length <= max) {
    return value;
  }
  const headLength = Math.ceil(max / 2);
  const tailLength = max - headLength;
  const omitted = value.length - headLength - tailLength;
  return `${value.slice(0, headLength)}${truncationMarker(omitted)}${
    tailLength > 0 ? value.slice(-tailLength) : ""
  }`;
}
