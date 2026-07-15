import type { Redis as IORedisClient } from "ioredis";

/**
 * Lazy Redis client factory. When REDIS_URL is unset, every public helper
 * returns null so callers can fall back to in-process implementations
 * (pub/sub via EventEmitter, cache via Map, rate limit via Map) without
 * changing their call shape.
 */

let primary: IORedisClient | null = null;
let subscriber: IORedisClient | null = null;
let primaryInitPromise: Promise<IORedisClient | null> | null = null;
let subscriberInitPromise: Promise<IORedisClient | null> | null = null;

export function hasRedisUrl(): boolean {
  const raw = process.env.REDIS_URL?.trim();
  return Boolean(raw && raw.length > 0);
}

/**
 * ioredis' default retryStrategy retries forever, so `connect()` never settles
 * while the host is unreachable (`connectTimeout` only bounds each attempt).
 * Bound the *initial* connect; once connected, the default strategy still
 * handles reconnects indefinitely.
 */
const INITIAL_CONNECT_TIMEOUT_MS = 8_000;

async function connectWithinDeadline(client: IORedisClient): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(
      () => reject(new Error(`initial connect timed out after ${INITIAL_CONNECT_TIMEOUT_MS}ms`)),
      INITIAL_CONNECT_TIMEOUT_MS
    );
    timer.unref?.();
  });
  try {
    await Promise.race([client.connect(), deadline]);
  } catch (error) {
    // Stop the background retry loop so the failed client cannot keep the
    // process alive or reconnect after we've fallen back to in-process mode.
    client.disconnect();
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

async function createClient(role: "primary" | "subscriber"): Promise<IORedisClient | null> {
  const url = process.env.REDIS_URL?.trim();
  if (!url) return null;
  try {
    const mod = await import("ioredis");
    const IORedis = mod.Redis ?? mod.default;
    const client: IORedisClient = new IORedis(url, {
      lazyConnect: true,
      maxRetriesPerRequest: 2,
      enableReadyCheck: true,
      connectTimeout: 5_000,
      reconnectOnError: () => true,
      name: `cesium-${role}`,
    });
    client.on("error", (err: Error) => {
      // Keep noise low: the fallback path absorbs the failure elsewhere.
      if (process.env.OPENCURSOR_REDIS_DEBUG === "1") {
        console.warn(`[redis:${role}]`, err.message);
      }
    });
    await connectWithinDeadline(client);
    // Under `node --test` Node sets NODE_ENV=test. Unref the underlying TCP
    // socket so a lingering Redis connection does not keep the event loop
    // alive after all tests complete. Production callers (NODE_ENV !== test)
    // keep the default behaviour so the process stays resident.
    if (process.env.NODE_ENV === "test") {
      const stream = (client as unknown as { stream?: { unref?: () => void } }).stream;
      stream?.unref?.();
    }
    return client;
  } catch (error) {
    console.warn(
      `[redis:${role}] init failed, falling back to in-process mode:`,
      (error as Error).message
    );
    return null;
  }
}

export async function getRedis(): Promise<IORedisClient | null> {
  if (primary) return primary;
  if (!hasRedisUrl()) return null;
  if (!primaryInitPromise) {
    primaryInitPromise = createClient("primary").then((client) => {
      primary = client;
      return client;
    });
  }
  return primaryInitPromise;
}

export async function getRedisSubscriber(): Promise<IORedisClient | null> {
  if (subscriber) return subscriber;
  if (!hasRedisUrl()) return null;
  if (!subscriberInitPromise) {
    subscriberInitPromise = createClient("subscriber").then((client) => {
      subscriber = client;
      return client;
    });
  }
  return subscriberInitPromise;
}

export async function closeRedis(): Promise<void> {
  const tasks: Array<Promise<unknown>> = [];
  if (primary) tasks.push(primary.quit().catch(() => undefined));
  if (subscriber) tasks.push(subscriber.quit().catch(() => undefined));
  await Promise.all(tasks);
  primary = null;
  subscriber = null;
  primaryInitPromise = null;
  subscriberInitPromise = null;
}
