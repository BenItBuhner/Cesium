export function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

export function asString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value : undefined;
}

export function asNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

export function firstString(
  record: Record<string, unknown> | undefined,
  keys: readonly string[]
): string | undefined {
  if (!record) {
    return undefined;
  }
  for (const key of keys) {
    const value = record[key];
    if (typeof value === "string" && value.trim()) {
      return value.trim();
    }
  }
  return undefined;
}

export function compactJson(value: unknown, limit = 520): string | undefined {
  if (value == null) {
    return undefined;
  }
  let text: string;
  try {
    text = typeof value === "string" ? value : JSON.stringify(value);
  } catch {
    return undefined;
  }
  const trimmed = text.trim();
  if (!trimmed || trimmed === "{}" || trimmed === "[]") {
    return undefined;
  }
  return trimmed.length > limit ? `${trimmed.slice(0, limit - 1)}…` : trimmed;
}
