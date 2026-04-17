import { randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";
import { getRedis, getRedisSubscriber, hasRedisUrl } from "./redis.js";

/**
 * Thin typed pub/sub wrapper. When Redis is configured, `publish` uses
 * `PUBLISH` and `subscribe` multiplexes over a single shared subscriber
 * connection. When Redis is not configured, everything routes through an
 * in-process EventEmitter so single-server deployments don't need a broker.
 *
 * Same-process delivery is always handled by the local EventEmitter so
 * publishers see their own events even when Redis is slow or down. To avoid
 * double-delivery, each Redis envelope carries a per-process `src` token; we
 * drop inbound Redis messages that we published ourselves.
 */

type RedisEnvelope<T = unknown> = { src: string; data: T };

const emitter = new EventEmitter();
emitter.setMaxListeners(0);

const processToken = randomUUID();
const subscribedChannels = new Set<string>();
let subscriberWired = false;

function isRedisEnvelope(value: unknown): value is RedisEnvelope {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as Record<string, unknown>).src === "string" &&
    "data" in (value as Record<string, unknown>)
  );
}

async function ensureSubscriberWired(): Promise<void> {
  if (subscriberWired) return;
  const sub = await getRedisSubscriber();
  if (!sub) return;
  subscriberWired = true;
  sub.on("message", (channel, raw) => {
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      parsed = raw;
    }
    // Drop our own echo so same-process subscribers don't see each event twice.
    if (isRedisEnvelope(parsed)) {
      if (parsed.src === processToken) return;
      emitter.emit(channel, parsed.data);
      return;
    }
    emitter.emit(channel, parsed);
  });
}

export async function publish(channel: string, payload: unknown): Promise<void> {
  emitter.emit(channel, payload);
  if (hasRedisUrl()) {
    const client = await getRedis();
    if (client) {
      try {
        const envelope: RedisEnvelope = { src: processToken, data: payload };
        await client.publish(channel, JSON.stringify(envelope));
      } catch {
        // Same-process subscribers already saw the event via the emitter, so
        // a Redis outage only affects cross-process delivery.
      }
    }
  }
}

export async function subscribe<T = unknown>(
  channel: string,
  handler: (payload: T) => void
): Promise<() => void> {
  const wrapped = (payload: unknown) => handler(payload as T);
  emitter.on(channel, wrapped);

  if (hasRedisUrl()) {
    await ensureSubscriberWired();
    const sub = await getRedisSubscriber();
    if (sub && !subscribedChannels.has(channel)) {
      subscribedChannels.add(channel);
      try {
        await sub.subscribe(channel);
      } catch {
        // Local emitter still works; swallow so callers get a valid unsub.
      }
    }
  }

  return () => {
    emitter.off(channel, wrapped);
  };
}

/**
 * Synchronous local subscribe used by legacy call sites that can't await.
 * Returns immediately with an unsub fn. Redis cross-process fanout is wired
 * lazily in the background; if Redis isn't configured, this degrades to a
 * pure in-process listener.
 */
export function subscribeSync<T = unknown>(
  channel: string,
  handler: (payload: T) => void
): () => void {
  const wrapped = (payload: unknown) => handler(payload as T);
  emitter.on(channel, wrapped);
  if (hasRedisUrl()) {
    void (async () => {
      await ensureSubscriberWired();
      const sub = await getRedisSubscriber();
      if (sub && !subscribedChannels.has(channel)) {
        subscribedChannels.add(channel);
        await sub.subscribe(channel).catch(() => undefined);
      }
    })();
  }
  return () => {
    emitter.off(channel, wrapped);
  };
}
