/**
 * Memoized loose-JSON parsing for event projection.
 *
 * Chat projection re-runs over the full event log on every streaming flush,
 * and tool events carry their payloads as JSON strings. Re-parsing the same
 * (often large) payload strings dozens of times per second dominated CPU
 * profiles of long transcripts. The event strings are immutable and reused
 * across flushes, so caching by string identity turns repeat parses into map
 * hits. Failed parses are cached too - the exception path is the expensive
 * one. Callers must treat returned objects as immutable (projection already
 * relies on structural sharing).
 */

const MISS = Symbol("loose-json-miss");

const objectCache = new Map<string, Record<string, unknown> | typeof MISS>();
const arrayCache = new Map<string, unknown[] | typeof MISS>();
/**
 * Bounded: on overflow the cache resets (simpler than LRU, same effect here).
 * Sized above the client event cap (6k/conversation) times a few payload
 * fields so a full-transcript projection never clears the cache mid-pass.
 */
const MAX_CACHE_ENTRIES = 32_768;

function remember<V>(cache: Map<string, V | typeof MISS>, key: string, value: V | typeof MISS): void {
  if (cache.size >= MAX_CACHE_ENTRIES) {
    cache.clear();
  }
  cache.set(key, value);
}

export function parseLooseJsonObjectCached(
  value: unknown
): Record<string, unknown> | undefined {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  if (typeof value !== "string" || value.length === 0) {
    return undefined;
  }
  const cached = objectCache.get(value);
  if (cached !== undefined) {
    return cached === MISS ? undefined : cached;
  }
  let result: Record<string, unknown> | undefined;
  if (value.trim()) {
    try {
      const parsed = JSON.parse(value) as unknown;
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        result = parsed as Record<string, unknown>;
      }
    } catch {
      /* cached as miss */
    }
  }
  remember(objectCache, value, result ?? MISS);
  return result;
}

/** Parses a string that starts with a JSON array (after trimming). */
export function tryParseLeadingJsonArrayCached(text: string): unknown[] | undefined {
  if (typeof text !== "string" || text.length === 0) {
    return undefined;
  }
  const cached = arrayCache.get(text);
  if (cached !== undefined) {
    return cached === MISS ? undefined : cached;
  }
  let result: unknown[] | undefined;
  const trimmed = text.trim();
  if (trimmed.startsWith("[")) {
    try {
      const parsed = JSON.parse(trimmed) as unknown;
      if (Array.isArray(parsed)) {
        result = parsed;
      }
    } catch {
      /* cached as miss */
    }
  }
  remember(arrayCache, text, result ?? MISS);
  return result;
}
