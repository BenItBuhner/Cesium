import { test } from "node:test";
import assert from "node:assert/strict";

/**
 * Exercises the cache/kv.ts key-value helpers, cache/rate-limit.ts consume
 * helper, and cache/pubsub.ts publish/subscribe in two configurations:
 *   - REDIS_URL unset: in-process Map + EventEmitter fallbacks.
 *   - REDIS_URL set (docker compose redis on 6380): real Redis PUB/SUB & INCR.
 *
 * The Redis leg is skipped automatically when Redis is unreachable so the
 * suite still runs in CI jobs without containers. The probe MUST happen
 * before any test() registration -- node --test starts executing already-
 * registered tests while the top-level await is still pending, and those
 * tests flip process.env.REDIS_URL out from under us.
 */

const REDIS_URL = process.env.REDIS_TEST_URL ?? "redis://127.0.0.1:6380/15";

async function probeRedis(): Promise<boolean> {
  const prev = process.env.REDIS_URL;
  process.env.REDIS_URL = REDIS_URL;
  try {
    const mod = await import("../src/cache/redis.js");
    const client = await mod.getRedis();
    if (!client) return false;
    await client.ping();
    await mod.closeRedis();
    return true;
  } catch {
    return false;
  } finally {
    if (prev === undefined) {
      delete process.env.REDIS_URL;
    } else {
      process.env.REDIS_URL = prev;
    }
  }
}

async function resetRedisModule(): Promise<void> {
  const { closeRedis } = await import("../src/cache/redis.js");
  await closeRedis();
}

type Kind = "in-process" | "redis";

async function runKvSuite(kind: Kind): Promise<void> {
  const kv = await import("../src/cache/kv.js");
  const base = `test:${kind}:${Date.now()}:${Math.random().toString(36).slice(2, 8)}`;

  await kv.setString(`${base}:s`, "hello");
  assert.equal(await kv.getString(`${base}:s`), "hello");

  await kv.setJSON(`${base}:j`, { name: "kv", n: 1 });
  const read = await kv.getJSON<{ name: string; n: number }>(`${base}:j`);
  assert.deepEqual(read, { name: "kv", n: 1 });

  const batch = await kv.mgetJSON<{ name: string; n: number }>([`${base}:j`, `${base}:missing`]);
  assert.equal(batch.length, 2);
  assert.deepEqual(batch[0], { name: "kv", n: 1 });
  assert.equal(batch[1], null);

  await kv.del(`${base}:j`);
  assert.equal(await kv.getString(`${base}:j`), null);

  await kv.setString(`${base}:ttl`, "bye", 1);
  assert.equal(await kv.getString(`${base}:ttl`), "bye");
  await new Promise((resolve) => setTimeout(resolve, 1_100));
  assert.equal(await kv.getString(`${base}:ttl`), null);
}

async function runRateLimitSuite(kind: Kind): Promise<void> {
  const rl = await import("../src/cache/rate-limit.js");
  const bucket = `rltest:${kind}:${Date.now()}:${Math.random().toString(36).slice(2, 8)}`;
  const policy = { windowMs: 1_000, max: 3 };

  const first = await rl.consume(bucket, policy);
  assert.equal(first.ok, true);
  assert.equal(first.limit, 3);
  assert.equal(first.remaining, 2);

  const second = await rl.consume(bucket, policy);
  assert.equal(second.ok, true);
  assert.equal(second.remaining, 1);

  const third = await rl.consume(bucket, policy);
  assert.equal(third.ok, true);
  assert.equal(third.remaining, 0);

  const fourth = await rl.consume(bucket, policy);
  assert.equal(fourth.ok, false);
  assert.equal(fourth.remaining, 0);
  assert.ok(fourth.retryAfterSec >= 0);

  await rl.resetBucket(bucket);
  const afterPeek = await rl.peek(bucket, policy);
  assert.equal(afterPeek.ok, true);
  assert.equal(afterPeek.remaining, 3);
}

// Probe runs BEFORE any test() registrations so the node --test runner
// cannot start executing registered tests (which mutate REDIS_URL) while
// this await is pending.
const redisAvailable = await probeRedis();
// Leave the Redis client closed after the probe. Subsequent tests own their
// own module lifecycle via resetRedisModule + REDIS_URL overrides.
await resetRedisModule();

test("cache kv: in-process fallback", async () => {
  const prev = process.env.REDIS_URL;
  delete process.env.REDIS_URL;
  await resetRedisModule();
  try {
    await runKvSuite("in-process");
  } finally {
    if (prev !== undefined) process.env.REDIS_URL = prev;
  }
});

test("cache rate-limit: in-process fallback", async () => {
  const prev = process.env.REDIS_URL;
  delete process.env.REDIS_URL;
  await resetRedisModule();
  try {
    await runRateLimitSuite("in-process");
  } finally {
    if (prev !== undefined) process.env.REDIS_URL = prev;
  }
});

test(
  "cache kv: redis-backed",
  { skip: !redisAvailable ? "Redis not reachable; skipping" : false },
  async () => {
    const prev = process.env.REDIS_URL;
    process.env.REDIS_URL = REDIS_URL;
    await resetRedisModule();
    try {
      await runKvSuite("redis");
    } finally {
      await resetRedisModule();
      if (prev === undefined) delete process.env.REDIS_URL;
      else process.env.REDIS_URL = prev;
    }
  }
);

test(
  "cache rate-limit: redis-backed",
  { skip: !redisAvailable ? "Redis not reachable; skipping" : false },
  async () => {
    const prev = process.env.REDIS_URL;
    process.env.REDIS_URL = REDIS_URL;
    await resetRedisModule();
    try {
      await runRateLimitSuite("redis");
    } finally {
      await resetRedisModule();
      if (prev === undefined) delete process.env.REDIS_URL;
      else process.env.REDIS_URL = prev;
    }
  }
);

test(
  "cache pubsub: redis round-trip with dedup across publishers",
  { skip: !redisAvailable ? "Redis not reachable; skipping" : false },
  async () => {
    const prev = process.env.REDIS_URL;
    process.env.REDIS_URL = REDIS_URL;
    await resetRedisModule();
    const pubsub = await import("../src/cache/pubsub.js");
    const channel = `pstest:${Date.now()}:${Math.random().toString(36).slice(2, 8)}`;
    const received: Array<{ v: number }> = [];
    const unsubscribe = await pubsub.subscribe<{ v: number }>(channel, (payload) => {
      received.push(payload);
    });
    try {
      await pubsub.publish(channel, { v: 1 });
      await pubsub.publish(channel, { v: 2 });
      // Give Redis time to echo back so the dedup guard via processToken is
      // exercised. If the guard were missing we'd see 4 deliveries here.
      await new Promise((resolve) => setTimeout(resolve, 150));
      assert.equal(received.length, 2, "expected two local deliveries");
      assert.equal(received[0]?.v, 1);
      assert.equal(received[1]?.v, 2);
    } finally {
      unsubscribe();
      await resetRedisModule();
      if (prev === undefined) delete process.env.REDIS_URL;
      else process.env.REDIS_URL = prev;
    }
  }
);
