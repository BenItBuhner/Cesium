import { v } from "convex/values";
import { mutation, query } from "./_generated/server";

/**
 * Convex-backed rendezvous registry.
 *
 * Engines behind rotating tunnels publish an encrypted "current base URL"
 * record every few seconds; clients holding the locator's read secret decrypt
 * it to follow the engine. `src/lib/rendezvous-store.ts` used to require
 * Upstash Redis for this - production never had it attached, so publishing
 * failed and every engine fell back to the copy-the-password connect block.
 * These functions give the web app's `/api/rendezvous/<serverId>` routes a
 * store that exists wherever Convex does. The deployment only ever sees
 * ciphertext plus the SHA-256 of the write secret that claimed the id.
 */

const SERVER_ID_PATTERN = /^[A-Za-z0-9_-]{24,80}$/;
const SECRET_HASH_PATTERN = /^[A-Za-z0-9_-]{32,128}$/;
const CIPHERTEXT_PATTERN = /^[A-Za-z0-9_-]{16,64}\.[A-Za-z0-9_-]{32,4096}$/;
const MAX_TTL_SECONDS = 15 * 60;
/** Ownership of a server id lapses after a year without a publish. */
const AUTH_TTL_MS = 365 * 24 * 60 * 60 * 1000;

const recordValidator = v.object({
  version: v.number(),
  serverId: v.string(),
  ciphertext: v.string(),
  updatedAt: v.number(),
  expiresAt: v.number(),
});

function safeEqual(left: string, right: string): boolean {
  if (left.length !== right.length) {
    return false;
  }
  let mismatch = 0;
  for (let index = 0; index < left.length; index += 1) {
    mismatch |= left.charCodeAt(index) ^ right.charCodeAt(index);
  }
  return mismatch === 0;
}

export const get = query({
  args: { serverId: v.string(), now: v.optional(v.number()) },
  returns: v.union(v.null(), recordValidator),
  handler: async (ctx, args) => {
    if (!SERVER_ID_PATTERN.test(args.serverId)) {
      return null;
    }
    const row = await ctx.db
      .query("rendezvousRecords")
      .withIndex("by_server", (q) => q.eq("serverId", args.serverId))
      .unique();
    if (!row) {
      return null;
    }
    if (typeof args.now === "number" && row.expiresAt <= args.now) {
      return null;
    }
    return {
      version: row.version,
      serverId: row.serverId,
      ciphertext: row.ciphertext,
      updatedAt: row.updatedAt,
      expiresAt: row.expiresAt,
    };
  },
});

/**
 * First publish claims the server id for the write secret (by hash); later
 * publishes must present the same hash. A claim that has not been refreshed
 * for a year lapses so abandoned ids can be reused.
 */
export const claimAndPut = mutation({
  args: {
    serverId: v.string(),
    secretHash: v.string(),
    ciphertext: v.string(),
    ttlSeconds: v.number(),
  },
  returns: v.object({
    result: v.union(v.literal("ok"), v.literal("forbidden")),
    record: v.union(v.null(), recordValidator),
  }),
  handler: async (ctx, args) => {
    if (!SERVER_ID_PATTERN.test(args.serverId)) {
      throw new Error("Invalid server id.");
    }
    if (!SECRET_HASH_PATTERN.test(args.secretHash)) {
      throw new Error("Invalid secret hash.");
    }
    if (!CIPHERTEXT_PATTERN.test(args.ciphertext)) {
      throw new Error("Invalid encrypted rendezvous record.");
    }
    const ttlSeconds = Math.min(
      MAX_TTL_SECONDS,
      Math.max(5, Number.isFinite(args.ttlSeconds) ? Math.floor(args.ttlSeconds) : 90)
    );
    const now = Date.now();
    const expiresAt = now + ttlSeconds * 1000;
    const existing = await ctx.db
      .query("rendezvousRecords")
      .withIndex("by_server", (q) => q.eq("serverId", args.serverId))
      .unique();
    if (existing && existing.authExpiresAt > now && !safeEqual(existing.secretHash, args.secretHash)) {
      return { result: "forbidden" as const, record: null };
    }
    const record = {
      version: 1,
      serverId: args.serverId,
      ciphertext: args.ciphertext,
      updatedAt: now,
      expiresAt,
    };
    if (existing) {
      await ctx.db.patch(existing._id, {
        secretHash: args.secretHash,
        ciphertext: args.ciphertext,
        version: 1,
        updatedAt: now,
        expiresAt,
        authExpiresAt: now + AUTH_TTL_MS,
      });
    } else {
      await ctx.db.insert("rendezvousRecords", {
        serverId: args.serverId,
        secretHash: args.secretHash,
        ciphertext: args.ciphertext,
        version: 1,
        updatedAt: now,
        expiresAt,
        authExpiresAt: now + AUTH_TTL_MS,
      });
    }
    return { result: "ok" as const, record };
  },
});
