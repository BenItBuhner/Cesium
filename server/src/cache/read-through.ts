import { del, getJSON, setJSON } from "./kv.js";

/**
 * Read-through cache helper backed by Redis KV (with in-process fallback
 * inherited from `cache/kv.ts`).
 *
 * Callers provide a `loader` that hits the real source of truth; on cache
 * miss the loaded value is written back with the supplied TTL. Keep TTLs
 * short (tens of seconds) and call `invalidate()` from every write path so
 * freshness stays within one RTT of Postgres.
 *
 * Empty objects/arrays are still cached so repeated misses don't stampede
 * Postgres. `null`/`undefined` loaders results are _not_ cached to avoid
 * poisoning the key for a transient failure.
 */
// Under `NODE_ENV=test` we bypass caching entirely. The parameterized storage
// fixture swaps drivers mid-process (legacy-json → pg) and both runs share a
// single Redis instance, so a cached record from the first driver would be
// served to the second and cause phantom "already exists" / stale-row bugs.
// Tests cover the cache primitives directly via `test/cache.test.ts`.
const CACHING_DISABLED = process.env.NODE_ENV === "test";

export async function readThrough<T>(
  key: string,
  ttlSeconds: number,
  loader: () => Promise<T>
): Promise<T> {
  if (CACHING_DISABLED) {
    return loader();
  }
  const cached = await getJSON<{ v: T }>(key);
  if (cached !== null) {
    return cached.v;
  }
  const value = await loader();
  if (value !== undefined && value !== null) {
    // Wrap in an envelope so we can distinguish cached `null` from "missing"
    // if we ever want to cache negative lookups without additional keys.
    await setJSON(key, { v: value }, ttlSeconds);
  }
  return value;
}

export async function invalidate(...keys: string[]): Promise<void> {
  if (CACHING_DISABLED) return;
  await Promise.all(keys.map((key) => del(key)));
}
