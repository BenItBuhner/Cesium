import { getRedis, hasRedisUrl } from "./redis.js";

export type RateLimitPolicy = {
  windowMs: number;
  max: number;
};

export type RateLimitResult = {
  ok: boolean;
  limit: number;
  remaining: number;
  resetAt: number;
  retryAfterSec: number;
};

type FallbackBucket = { count: number; resetAt: number };

const fallback = new Map<string, FallbackBucket>();

function pruneFallback(now: number): void {
  if (fallback.size < 2_000) return;
  for (const [key, bucket] of fallback.entries()) {
    if (bucket.resetAt <= now) fallback.delete(key);
  }
}

function resultFromBucket(
  policy: RateLimitPolicy,
  count: number,
  resetAt: number
): RateLimitResult {
  const remaining = Math.max(0, policy.max - count);
  const now = Date.now();
  const retryAfterSec = Math.max(0, Math.ceil((resetAt - now) / 1000));
  return {
    ok: count <= policy.max,
    limit: policy.max,
    remaining,
    resetAt,
    retryAfterSec,
  };
}

/** Like {@link resultFromBucket} but `ok` means another attempt is allowed (count &lt; max). */
function peekResultFromBucket(
  policy: RateLimitPolicy,
  count: number,
  resetAt: number
): RateLimitResult {
  const remaining = Math.max(0, policy.max - count);
  const now = Date.now();
  const retryAfterSec = Math.max(0, Math.ceil((resetAt - now) / 1000));
  return {
    ok: count < policy.max,
    limit: policy.max,
    remaining,
    resetAt,
    retryAfterSec,
  };
}

function consumeFallback(
  bucketKey: string,
  policy: RateLimitPolicy
): RateLimitResult {
  const now = Date.now();
  pruneFallback(now);
  const existing = fallback.get(bucketKey);
  const resetAt =
    !existing || existing.resetAt <= now ? now + policy.windowMs : existing.resetAt;
  const count = !existing || existing.resetAt <= now ? 1 : existing.count + 1;
  fallback.set(bucketKey, { count, resetAt });
  return resultFromBucket(policy, count, resetAt);
}

/**
 * Consume one unit against a rate-limit bucket. Uses Redis INCR+PEXPIRE when
 * available, falls back to the in-process Map so tests and solo deployments
 * still work. Semantics match the legacy `consumeRateLimit` function:
 *   - First request in a window seeds count=1 and resetAt=now+window.
 *   - Subsequent requests increment the count.
 *   - When the window expires, the bucket resets to 1.
 */
export async function consume(
  bucketKey: string,
  policy: RateLimitPolicy
): Promise<RateLimitResult> {
  if (hasRedisUrl()) {
    const client = await getRedis();
    if (client) {
      try {
        const now = Date.now();
        const key = `rl:${bucketKey}`;
        const pipeline = client.multi();
        pipeline.incr(key);
        pipeline.pttl(key);
        const execResult = await pipeline.exec();
        if (!execResult) throw new Error("redis pipeline returned null");
        const rawCount = execResult[0]?.[1];
        const rawTtl = execResult[1]?.[1];
        const count = Number(rawCount ?? 0);
        const ttlMs = Number(rawTtl ?? -1);
        if (!Number.isFinite(count)) throw new Error("bad INCR result");

        let resetAt: number;
        if (count === 1 || ttlMs < 0) {
          await client.pexpire(key, policy.windowMs);
          resetAt = now + policy.windowMs;
        } else {
          resetAt = now + ttlMs;
        }
        return resultFromBucket(policy, count, resetAt);
      } catch {
        // Fall through to in-process path.
      }
    }
  }
  return consumeFallback(bucketKey, policy);
}

function peekFallback(bucketKey: string, policy: RateLimitPolicy): RateLimitResult {
  const now = Date.now();
  pruneFallback(now);
  const existing = fallback.get(bucketKey);
  if (!existing || existing.resetAt <= now) {
    return peekResultFromBucket(policy, 0, now + policy.windowMs);
  }
  return peekResultFromBucket(policy, existing.count, existing.resetAt);
}

/**
 * Read the current bucket without incrementing. `ok` is true when
 * `count &lt; max` (another attempt is allowed). Use with {@link consume}
 * only after a failed attempt when you want to rate-limit failures, not
 * successes.
 */
export async function peek(
  bucketKey: string,
  policy: RateLimitPolicy
): Promise<RateLimitResult> {
  if (hasRedisUrl()) {
    const client = await getRedis();
    if (client) {
      try {
        const now = Date.now();
        const key = `rl:${bucketKey}`;
        const pipeline = client.multi();
        pipeline.get(key);
        pipeline.pttl(key);
        const execResult = await pipeline.exec();
        if (!execResult) throw new Error("redis pipeline returned null");
        const rawVal = execResult[0]?.[1];
        const rawTtl = execResult[1]?.[1];
        const count = rawVal == null ? 0 : Number(rawVal);
        const ttlMs = Number(rawTtl ?? -2);
        if (!Number.isFinite(count)) throw new Error("bad GET result");

        let resetAt: number;
        if (rawVal == null || ttlMs === -2) {
          resetAt = now + policy.windowMs;
        } else if (ttlMs === -1) {
          resetAt = now + policy.windowMs;
        } else {
          resetAt = now + ttlMs;
        }
        return peekResultFromBucket(policy, count, resetAt);
      } catch {
        // Fall through to in-process path.
      }
    }
  }
  return peekFallback(bucketKey, policy);
}

/** Drop a bucket so the next attempt starts fresh (e.g. after successful login). */
export async function resetBucket(bucketKey: string): Promise<void> {
  if (hasRedisUrl()) {
    const client = await getRedis();
    if (client) {
      try {
        await client.del(`rl:${bucketKey}`);
        return;
      } catch {
        // Fall through.
      }
    }
  }
  fallback.delete(bucketKey);
}
