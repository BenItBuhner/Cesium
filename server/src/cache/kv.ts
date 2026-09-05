import { getRedis, hasRedisUrl } from "./redis.js";

/**
 * In-process fallback entry. Values written through the JSON API are kept as
 * the parsed object graph: the default (no Redis) deployment used to
 * `JSON.stringify` on every set and `JSON.parse` on every hit, which for the
 * multi-hundred-KB settings / rail payloads made a cache hit cost about as much
 * as the disk read it was meant to avoid. The string form is materialized
 * lazily only if someone reads a JSON-written key through `getString`.
 *
 * Consumers treat returned values as immutable (they `.map`/spread before
 * changing anything), so handing out the shared graph is safe.
 */
type FallbackEntry = {
  raw: string | null;
  parsed: unknown;
  hasParsed: boolean;
  expiresAt: number | null;
};

const fallback = new Map<string, FallbackEntry>();

function pruneFallback(now: number): void {
  if (fallback.size < 2_000) return;
  for (const [key, entry] of fallback.entries()) {
    if (entry.expiresAt !== null && entry.expiresAt <= now) {
      fallback.delete(key);
    }
  }
}

function expiresAtFor(ttlSeconds: number | undefined): number | null {
  return ttlSeconds && ttlSeconds > 0 ? Date.now() + ttlSeconds * 1000 : null;
}

function readFallback(key: string, now = Date.now()): FallbackEntry | null {
  const entry = fallback.get(key);
  if (!entry) return null;
  if (entry.expiresAt !== null && entry.expiresAt <= now) {
    fallback.delete(key);
    return null;
  }
  return entry;
}

function parseEntry<T>(entry: FallbackEntry): T | null {
  if (entry.hasParsed) {
    return entry.parsed as T;
  }
  if (entry.raw === null) return null;
  try {
    const parsed = JSON.parse(entry.raw) as T;
    entry.parsed = parsed;
    entry.hasParsed = true;
    return parsed;
  } catch {
    return null;
  }
}

export async function getString(key: string): Promise<string | null> {
  if (hasRedisUrl()) {
    const client = await getRedis();
    if (client) {
      try {
        return await client.get(key);
      } catch {
        // fall through to local fallback
      }
    }
  }
  const entry = readFallback(key);
  if (!entry) return null;
  if (entry.raw === null) {
    entry.raw = JSON.stringify(entry.parsed);
  }
  return entry.raw;
}

export async function setString(
  key: string,
  value: string,
  ttlSeconds?: number
): Promise<void> {
  if (hasRedisUrl()) {
    const client = await getRedis();
    if (client) {
      try {
        if (ttlSeconds && ttlSeconds > 0) {
          await client.set(key, value, "EX", ttlSeconds);
        } else {
          await client.set(key, value);
        }
        return;
      } catch {
        // fall through
      }
    }
  }
  pruneFallback(Date.now());
  fallback.set(key, {
    raw: value,
    parsed: undefined,
    hasParsed: false,
    expiresAt: expiresAtFor(ttlSeconds),
  });
}

export async function del(key: string): Promise<void> {
  if (hasRedisUrl()) {
    const client = await getRedis();
    if (client) {
      try {
        await client.del(key);
      } catch {
        // fall through
      }
    }
  }
  fallback.delete(key);
}

export async function getJSON<T>(key: string): Promise<T | null> {
  if (hasRedisUrl()) {
    const client = await getRedis();
    if (client) {
      try {
        const raw = await client.get(key);
        if (!raw) return null;
        try {
          return JSON.parse(raw) as T;
        } catch {
          return null;
        }
      } catch {
        // fall through to local fallback
      }
    }
  }
  const entry = readFallback(key);
  if (!entry) return null;
  return parseEntry<T>(entry);
}

export async function setJSON<T>(
  key: string,
  value: T,
  ttlSeconds?: number
): Promise<void> {
  if (hasRedisUrl()) {
    const client = await getRedis();
    if (client) {
      try {
        const serialized = JSON.stringify(value);
        if (ttlSeconds && ttlSeconds > 0) {
          await client.set(key, serialized, "EX", ttlSeconds);
        } else {
          await client.set(key, serialized);
        }
        return;
      } catch {
        // fall through
      }
    }
  }
  pruneFallback(Date.now());
  fallback.set(key, {
    raw: null,
    parsed: value,
    hasParsed: true,
    expiresAt: expiresAtFor(ttlSeconds),
  });
}

export async function mgetJSON<T>(keys: string[]): Promise<Array<T | null>> {
  if (keys.length === 0) return [];
  if (hasRedisUrl()) {
    const client = await getRedis();
    if (client) {
      try {
        const values = await client.mget(...keys);
        return values.map((raw) => {
          if (!raw) return null;
          try {
            return JSON.parse(raw) as T;
          } catch {
            return null;
          }
        });
      } catch {
        // fall through to local fallback
      }
    }
  }
  const now = Date.now();
  return keys.map((key) => {
    const entry = readFallback(key, now);
    if (!entry) return null;
    return parseEntry<T>(entry);
  });
}
