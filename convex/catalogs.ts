import { v } from "convex/values";
import { mutation, query } from "./_generated/server";
import { ensureUser, getAuthedUser } from "./lib/identity";

/**
 * Per-engine conversation catalogs (see `conversationCatalogs` in schema.ts).
 *
 * A catalog is the last rail listing a signed-in client fetched from one of
 * the user's engines, mirrored to the account so every other client can show
 * that engine's conversations while it is asleep or unreachable.
 */

/** Stay well under Convex's ~1 MiB document ceiling; clients trim first. */
export const MAX_CATALOG_PAYLOAD_CHARS = 900_000;
const MAX_SERVER_KEY_CHARS = 512;

const catalogRowValidator = v.object({
  serverKey: v.string(),
  serverName: v.string(),
  baseUrl: v.string(),
  payload: v.string(),
  conversationCount: v.number(),
  sourceUpdatedAt: v.number(),
  updatedAt: v.number(),
});

export const save = mutation({
  args: {
    deviceKey: v.optional(v.string()),
    serverKey: v.string(),
    serverName: v.string(),
    baseUrl: v.string(),
    payload: v.string(),
    conversationCount: v.number(),
    sourceUpdatedAt: v.number(),
  },
  returns: v.object({ created: v.boolean(), skipped: v.boolean() }),
  handler: async (ctx, args) => {
    const serverKey = args.serverKey.trim();
    if (!serverKey || serverKey.length > MAX_SERVER_KEY_CHARS) {
      throw new Error("Catalog server key is missing or too long.");
    }
    if (args.payload.length > MAX_CATALOG_PAYLOAD_CHARS) {
      throw new Error("Conversation catalog too large. Trim it before saving.");
    }
    if (!Number.isFinite(args.conversationCount) || args.conversationCount < 0) {
      throw new Error("Invalid conversation count.");
    }
    const userId = await ensureUser(ctx, args.deviceKey);
    const now = Date.now();
    const existing = await ctx.db
      .query("conversationCatalogs")
      .withIndex("by_user_server", (q) =>
        q.eq("userId", userId).eq("serverKey", serverKey)
      )
      .unique();
    const fields = {
      serverName: args.serverName,
      baseUrl: args.baseUrl.trim().replace(/\/+$/, ""),
      payload: args.payload,
      conversationCount: Math.floor(args.conversationCount),
      sourceUpdatedAt: args.sourceUpdatedAt,
      updatedAt: now,
    };
    if (existing) {
      // Last write wins: clients push right after a live fetch, so the newest
      // push is the freshest view (deletions legitimately shrink the listing).
      if (existing.payload === fields.payload) {
        await ctx.db.patch(existing._id, { updatedAt: now });
        return { created: false, skipped: true };
      }
      await ctx.db.patch(existing._id, fields);
      return { created: false, skipped: false };
    }
    await ctx.db.insert("conversationCatalogs", {
      userId,
      serverKey,
      ...fields,
    });
    return { created: true, skipped: false };
  },
});

export const remove = mutation({
  args: { deviceKey: v.optional(v.string()), serverKey: v.string() },
  returns: v.object({ ok: v.boolean() }),
  handler: async (ctx, args) => {
    const userId = await ensureUser(ctx, args.deviceKey);
    const existing = await ctx.db
      .query("conversationCatalogs")
      .withIndex("by_user_server", (q) =>
        q.eq("userId", userId).eq("serverKey", args.serverKey.trim())
      )
      .unique();
    if (existing) {
      await ctx.db.delete(existing._id);
    }
    return { ok: existing !== null };
  },
});

/**
 * Every catalog for the signed-in user. One row per engine, so this stays
 * small (tens of rows at most) even though each payload carries a full rail
 * listing; clients subscribe once and merge into their local cache.
 */
export const list = query({
  args: { deviceKey: v.optional(v.string()) },
  returns: v.union(v.array(catalogRowValidator), v.null()),
  handler: async (ctx, args) => {
    const user = await getAuthedUser(ctx, args.deviceKey);
    if (!user) {
      return null;
    }
    const rows = await ctx.db
      .query("conversationCatalogs")
      .withIndex("by_user", (q) => q.eq("userId", user._id))
      .collect();
    return rows.map((row) => ({
      serverKey: row.serverKey,
      serverName: row.serverName,
      baseUrl: row.baseUrl,
      payload: row.payload,
      conversationCount: row.conversationCount,
      sourceUpdatedAt: row.sourceUpdatedAt,
      updatedAt: row.updatedAt,
    }));
  },
});
