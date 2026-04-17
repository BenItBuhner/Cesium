import { getRedis, hasRedisUrl } from "./redis.js";

type FallbackEntry = { value: string; expiresAt: number | null };

const fallback = new Map<string, FallbackEntry>();

function pruneFallback(now: number): void {
  if (fallback.size < 2_000) return;
  for (const [key, entry] of fallback.entries()) {
    if (entry.expiresAt !== null && entry.expiresAt <= now) {
      fallback.delete(key);
    }
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
  const entry = fallback.get(key);
  if (!entry) return null;
  if (entry.expiresAt !== null && entry.expiresAt <= Date.now()) {
    fallback.delete(key);
    return null;
  }
  return entry.value;
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
    value,
    expiresAt:
      ttlSeconds && ttlSeconds > 0 ? Date.now() + ttlSeconds * 1000 : null,
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
  const raw = await getString(key);
  if (!raw) return null;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return null;
  }
}

export async function setJSON<T>(
  key: string,
  value: T,
  ttlSeconds?: number
): Promise<void> {
  await setString(key, JSON.stringify(value), ttlSeconds);
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
    const entry = fallback.get(key);
    if (!entry) return null;
    if (entry.expiresAt !== null && entry.expiresAt <= now) {
      fallback.delete(key);
      return null;
    }
    try {
      return JSON.parse(entry.value) as T;
    } catch {
      return null;
    }
  });
}
