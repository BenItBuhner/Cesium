import { EventEmitter } from "node:events";
import { createClient } from "redis";

type RedisMode = "memory" | "redis";
type RedisCommandClient = ReturnType<typeof createClient>;

type RedisTestOverrides = {
  mode?: RedisMode;
  url?: string;
};

type MemoryRateLimitBucket = {
  count: number;
  resetAt: number;
};

const memoryEmitter = new EventEmitter();
const memoryRateLimits = new Map<string, MemoryRateLimitBucket>();

let testOverrides: RedisTestOverrides | null = null;
let commandClientPromise: Promise<RedisCommandClient | null> | null = null;
let subscriberClientPromise: Promise<RedisCommandClient | null> | null = null;
const activeSubscriptions = new Map<string, number>();
const remoteChannelHandlers = new Map<string, (message: string) => void>();

function resolveRedisMode(): RedisMode {
  const override = testOverrides?.mode;
  if (override) {
    return override;
  }
  return process.env.OPENCURSOR_REDIS_URL?.trim() ? "redis" : "memory";
}

function resolveRedisUrl(): string {
  const override = testOverrides?.url?.trim();
  if (override) {
    return override;
  }
  const configured = process.env.OPENCURSOR_REDIS_URL?.trim();
  if (!configured) {
    throw new Error("OPENCURSOR_REDIS_URL is required for Redis-backed coordination.");
  }
  return configured;
}

async function createRedisClient(): Promise<RedisCommandClient | null> {
  if (resolveRedisMode() !== "redis") {
    return null;
  }
  const client = createClient({
    url: resolveRedisUrl(),
    socket: {
      reconnectStrategy: false,
    },
  });
  client.on("error", () => undefined);
  try {
    await client.connect();
    return client;
  } catch {
    await client.disconnect().catch(() => undefined);
    return null;
  }
}

async function getCommandClient(): Promise<RedisCommandClient | null> {
  if (!commandClientPromise) {
    commandClientPromise = createRedisClient();
  }
  return commandClientPromise;
}

async function getSubscriberClient(): Promise<RedisCommandClient | null> {
  if (!subscriberClientPromise) {
    subscriberClientPromise = (async () => {
      const commandClient = await getCommandClient();
      if (!commandClient) {
        return null;
      }
      const duplicate = commandClient.duplicate();
      duplicate.on("error", () => undefined);
      try {
        await duplicate.connect();
        return duplicate;
      } catch {
        await duplicate.disconnect().catch(() => undefined);
        return null;
      }
    })();
  }
  return subscriberClientPromise;
}

function pruneMemoryRateLimits(now: number): void {
  if (memoryRateLimits.size < 2_000) {
    return;
  }
  for (const [key, bucket] of memoryRateLimits.entries()) {
    if (bucket.resetAt <= now) {
      memoryRateLimits.delete(key);
    }
  }
}

export async function consumeDistributedRateLimit(input: {
  bucketKey: string;
  limit: number;
  windowMs: number;
}): Promise<{
  ok: boolean;
  limit: number;
  remaining: number;
  resetAt: number;
  retryAfterSec: number;
}> {
  const redisClient = await getCommandClient();
  if (redisClient) {
    const current = await redisClient.incr(input.bucketKey);
    if (current === 1) {
      await redisClient.pExpire(input.bucketKey, input.windowMs);
    }
    let ttl = await redisClient.pTTL(input.bucketKey);
    if (ttl < 0) {
      await redisClient.pExpire(input.bucketKey, input.windowMs);
      ttl = input.windowMs;
    }
    return {
      ok: current <= input.limit,
      limit: input.limit,
      remaining: Math.max(0, input.limit - current),
      resetAt: Date.now() + ttl,
      retryAfterSec: Math.max(1, Math.ceil(ttl / 1000)),
    };
  }

  const now = Date.now();
  pruneMemoryRateLimits(now);
  const existing = memoryRateLimits.get(input.bucketKey);
  const next =
    existing && existing.resetAt > now
      ? {
          count: existing.count + 1,
          resetAt: existing.resetAt,
        }
      : {
          count: 1,
          resetAt: now + input.windowMs,
        };
  memoryRateLimits.set(input.bucketKey, next);
  return {
    ok: next.count <= input.limit,
    limit: input.limit,
    remaining: Math.max(0, input.limit - next.count),
    resetAt: next.resetAt,
    retryAfterSec: Math.max(1, Math.ceil((next.resetAt - now) / 1000)),
  };
}

export function rateLimitStoreMode(): RedisMode {
  return resolveRedisMode();
}

export async function getCoordinationStatus(): Promise<{
  mode: RedisMode;
  connected: boolean;
}> {
  const mode = resolveRedisMode();
  if (mode === "memory") {
    return { mode, connected: false };
  }
  return {
    mode,
    connected: Boolean(await getCommandClient()),
  };
}

export async function subscribeToWorkspaceChannel(
  workspaceId: string,
  handler: (message: string) => void
): Promise<() => Promise<void>> {
  return subscribeDistributedChannel(`opencursor:workspace:${workspaceId}:v1`, handler);
}

export async function publishDistributedMessage(
  channel: string,
  message: string
): Promise<void> {
  const redisClient = await getCommandClient();
  if (redisClient) {
    await redisClient.publish(channel, message);
    return;
  }
  memoryEmitter.emit(channel, message);
}

export async function subscribeDistributedChannel(
  channel: string,
  handler: (message: string) => void
): Promise<() => Promise<void>> {
  memoryEmitter.on(channel, handler);
  const redisSubscriber = await getSubscriberClient();
  if (redisSubscriber) {
    const previousCount = activeSubscriptions.get(channel) ?? 0;
    if (previousCount === 0) {
      const remoteHandler = (message: string) => {
        memoryEmitter.emit(channel, message);
      };
      remoteChannelHandlers.set(channel, remoteHandler);
      await redisSubscriber.subscribe(channel, remoteHandler);
    }
    activeSubscriptions.set(channel, previousCount + 1);
    return async () => {
      memoryEmitter.off(channel, handler);
      const nextCount = (activeSubscriptions.get(channel) ?? 1) - 1;
      if (nextCount <= 0) {
        activeSubscriptions.delete(channel);
        const remoteHandler = remoteChannelHandlers.get(channel);
        remoteChannelHandlers.delete(channel);
        if (remoteHandler) {
          await redisSubscriber.unsubscribe(channel, remoteHandler).catch(() => undefined);
        }
        return;
      }
      activeSubscriptions.set(channel, nextCount);
    };
  }

  return async () => {
    memoryEmitter.off(channel, handler);
  };
}

export async function configureRedisForTests(
  overrides: Partial<RedisTestOverrides>
): Promise<void> {
  testOverrides = { ...(testOverrides ?? {}), ...overrides };
  await resetRedisForTests();
}

export async function resetRedisForTests(): Promise<void> {
  memoryEmitter.removeAllListeners();
  memoryRateLimits.clear();
  const [commandClient, subscriberClient] = await Promise.all([
    commandClientPromise?.catch(() => null) ?? Promise.resolve(null),
    subscriberClientPromise?.catch(() => null) ?? Promise.resolve(null),
  ]);
  commandClientPromise = null;
  subscriberClientPromise = null;
  activeSubscriptions.clear();
  remoteChannelHandlers.clear();
  await Promise.all([
    commandClient?.disconnect().catch(() => undefined),
    subscriberClient?.disconnect().catch(() => undefined),
  ]);
}
