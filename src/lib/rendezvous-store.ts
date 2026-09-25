import { timingSafeEqual } from "node:crypto";
import { Redis } from "@upstash/redis";
import { ConvexHttpClient } from "convex/browser";
import { api } from "@convex/_generated/api";
import { getConvexUrl } from "@/lib/cloud/cloud-flags";

export type RendezvousRecord = {
  version: 1;
  serverId: string;
  ciphertext: string;
  updatedAt: number;
  expiresAt: number;
};

export type RendezvousWriteResult = "ok" | "forbidden";

export interface RendezvousStore {
  get(serverId: string): Promise<RendezvousRecord | null>;
  claimAndPut(
    serverId: string,
    secretHash: string,
    record: RendezvousRecord,
    ttlSeconds: number
  ): Promise<RendezvousWriteResult>;
  consumeRateLimit(key: string, limit: number, windowSeconds: number): Promise<boolean>;
}

const AUTH_TTL_SECONDS = 365 * 24 * 60 * 60;

function equalSecretHashes(left: string, right: string): boolean {
  const a = Buffer.from(left);
  const b = Buffer.from(right);
  return a.length === b.length && timingSafeEqual(a, b);
}

export class UpstashRendezvousStore implements RendezvousStore {
  constructor(private readonly redis: Redis) {}

  async get(serverId: string): Promise<RendezvousRecord | null> {
    return (await this.redis.get<RendezvousRecord>(`cesium:rendezvous:record:${serverId}`)) ?? null;
  }

  async claimAndPut(
    serverId: string,
    secretHash: string,
    record: RendezvousRecord,
    ttlSeconds: number
  ): Promise<RendezvousWriteResult> {
    const authKey = `cesium:rendezvous:auth:${serverId}`;
    const claimed = await this.redis.set(authKey, secretHash, {
      ex: AUTH_TTL_SECONDS,
      nx: true,
    });
    if (claimed === null) {
      const existing = await this.redis.get<string>(authKey);
      if (!existing || !equalSecretHashes(existing, secretHash)) {
        return "forbidden";
      }
      await this.redis.expire(authKey, AUTH_TTL_SECONDS);
    }
    await this.redis.set(`cesium:rendezvous:record:${serverId}`, record, {
      ex: ttlSeconds,
    });
    return "ok";
  }

  async consumeRateLimit(
    key: string,
    limit: number,
    windowSeconds: number
  ): Promise<boolean> {
    const redisKey = `cesium:rendezvous:rate:${key}`;
    const count = await this.redis.incr(redisKey);
    if (count === 1) {
      await this.redis.expire(redisKey, windowSeconds);
    }
    return count <= limit;
  }
}

/**
 * Process-local fixed-window counter. Vercel functions are per-instance, so
 * this is best-effort abuse damping rather than a global limit - which is all
 * the rendezvous endpoints need (records are ciphertext, writes are
 * secret-gated).
 */
export class MemoryRateLimiter {
  private readonly buckets = new Map<string, { count: number; resetAt: number }>();

  constructor(private readonly now: () => number = Date.now) {}

  consume(key: string, limit: number, windowSeconds: number): boolean {
    const now = this.now();
    const bucket = this.buckets.get(key);
    if (!bucket || bucket.resetAt <= now) {
      if (this.buckets.size > 10_000) {
        for (const [candidate, value] of this.buckets) {
          if (value.resetAt <= now) this.buckets.delete(candidate);
        }
      }
      this.buckets.set(key, { count: 1, resetAt: now + windowSeconds * 1000 });
      return true;
    }
    bucket.count += 1;
    return bucket.count <= limit;
  }
}

/**
 * Engines heartbeat every 30 s (older installs still every 15 s); a record
 * lives 90 s. Re-publishing the same (server, secret) within this window is
 * skipped so a fast-beating engine costs about half the Convex writes without
 * any client seeing a stale endpoint.
 */
const CONVEX_PUBLISH_DEBOUNCE_MS = 20_000;

type StoredRendezvousRecord = Omit<RendezvousRecord, "version"> & { version: number };

type ConvexRendezvousClient = {
  query: (
    name: typeof api.rendezvous.get,
    args: { serverId: string; now?: number }
  ) => Promise<StoredRendezvousRecord | null>;
  mutation: (
    name: typeof api.rendezvous.claimAndPut,
    args: { serverId: string; secretHash: string; ciphertext: string; ttlSeconds: number }
  ) => Promise<{ result: RendezvousWriteResult; record: StoredRendezvousRecord | null }>;
};

/**
 * Rendezvous registry on the Cesium Cloud Convex deployment (see
 * `convex/rendezvous.ts`). Used whenever no Upstash Redis is attached - which
 * is production's actual posture - so tunnel-backed engines can publish and
 * clients can follow URL rotations without any extra infrastructure.
 */
export class ConvexRendezvousStore implements RendezvousStore {
  private readonly limiter: MemoryRateLimiter;
  private readonly recentWrites = new Map<string, { record: RendezvousRecord; writtenAt: number }>();

  constructor(
    private readonly client: ConvexRendezvousClient,
    private readonly now: () => number = Date.now
  ) {
    this.limiter = new MemoryRateLimiter(now);
  }

  async get(serverId: string): Promise<RendezvousRecord | null> {
    const record = await this.client.query(api.rendezvous.get, { serverId, now: this.now() });
    return record ? { ...record, version: 1 } : null;
  }

  async claimAndPut(
    serverId: string,
    secretHash: string,
    record: RendezvousRecord,
    ttlSeconds: number
  ): Promise<RendezvousWriteResult> {
    const key = `${serverId}\0${secretHash}`;
    const recent = this.recentWrites.get(key);
    const now = this.now();
    if (recent && now - recent.writtenAt < CONVEX_PUBLISH_DEBOUNCE_MS) {
      return "ok";
    }
    const result = await this.client.mutation(api.rendezvous.claimAndPut, {
      serverId,
      secretHash,
      ciphertext: record.ciphertext,
      ttlSeconds,
    });
    if (result.result === "ok") {
      this.recentWrites.set(key, { record, writtenAt: now });
      if (this.recentWrites.size > 5_000) {
        for (const [candidate, value] of this.recentWrites) {
          if (now - value.writtenAt >= CONVEX_PUBLISH_DEBOUNCE_MS) this.recentWrites.delete(candidate);
        }
      }
    }
    return result.result;
  }

  async consumeRateLimit(key: string, limit: number, windowSeconds: number): Promise<boolean> {
    return this.limiter.consume(key, limit, windowSeconds);
  }
}

let cachedStore: RendezvousStore | null = null;

export function resolveRendezvousBackend(
  env: NodeJS.ProcessEnv = process.env
): "upstash" | "convex" | "none" {
  const url = env.UPSTASH_REDIS_REST_URL?.trim() || env.KV_REST_API_URL?.trim();
  const token =
    env.UPSTASH_REDIS_REST_TOKEN?.trim() || env.KV_REST_API_TOKEN?.trim();
  if (url && token) {
    return "upstash";
  }
  return getConvexUrl() ? "convex" : "none";
}

export function createRendezvousStoreFromEnv(
  env: NodeJS.ProcessEnv = process.env
): RendezvousStore {
  const backend = resolveRendezvousBackend(env);
  if (backend === "upstash") {
    const url = env.UPSTASH_REDIS_REST_URL?.trim() || env.KV_REST_API_URL?.trim();
    const token =
      env.UPSTASH_REDIS_REST_TOKEN?.trim() || env.KV_REST_API_TOKEN?.trim();
    return new UpstashRendezvousStore(
      new Redis({
        url: url!,
        token: token!,
        automaticDeserialization: true,
        cache: "no-store",
        retry: { retries: 2 },
      })
    );
  }
  if (backend === "convex") {
    return new ConvexRendezvousStore(new ConvexHttpClient(getConvexUrl()!));
  }
  throw new Error(
    "Rendezvous storage is not configured. Attach Upstash Redis to this Vercel project or enable Cesium Cloud (Convex)."
  );
}

export function getRendezvousStore(): RendezvousStore {
  cachedStore ??= createRendezvousStoreFromEnv();
  return cachedStore;
}
