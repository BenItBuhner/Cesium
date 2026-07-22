import { timingSafeEqual } from "node:crypto";
import { Redis } from "@upstash/redis";

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

let cachedStore: RendezvousStore | null = null;

export function createRendezvousStoreFromEnv(
  env: NodeJS.ProcessEnv = process.env
): RendezvousStore {
  const url = env.UPSTASH_REDIS_REST_URL?.trim() || env.KV_REST_API_URL?.trim();
  const token =
    env.UPSTASH_REDIS_REST_TOKEN?.trim() || env.KV_REST_API_TOKEN?.trim();
  if (!url || !token) {
    throw new Error(
      "Rendezvous storage is not configured. Attach Upstash Redis to this Vercel project."
    );
  }
  return new UpstashRendezvousStore(
    new Redis({
      url,
      token,
      automaticDeserialization: true,
      cache: "no-store",
      retry: { retries: 2 },
    })
  );
}

export function getRendezvousStore(): RendezvousStore {
  cachedStore ??= createRendezvousStoreFromEnv();
  return cachedStore;
}
