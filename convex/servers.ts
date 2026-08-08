import { v } from "convex/values";
import { mutation } from "./_generated/server";
import { ensureUser } from "./lib/identity";

function normalizeBaseUrl(baseUrl: string): string {
  return baseUrl.trim().replace(/\/+$/, "");
}

/** Upsert one of the user's engines, keyed by base URL. */
export const save = mutation({
  args: {
    deviceKey: v.optional(v.string()),
    name: v.string(),
    baseUrl: v.string(),
    kind: v.union(v.literal("remote"), v.literal("local")),
    sessionToken: v.optional(v.string()),
    notes: v.optional(v.string()),
    markConnected: v.optional(v.boolean()),
  },
  handler: async (ctx, args) => {
    const userId = await ensureUser(ctx, args.deviceKey);
    const baseUrl = normalizeBaseUrl(args.baseUrl);
    if (!/^https?:\/\//.test(baseUrl)) {
      throw new Error("Server base URL must be http(s).");
    }
    const now = Date.now();
    const existing = await ctx.db
      .query("servers")
      .withIndex("by_user_url", (q) => q.eq("userId", userId).eq("baseUrl", baseUrl))
      .unique();
    if (existing) {
      await ctx.db.patch(existing._id, {
        name: args.name,
        kind: args.kind,
        ...(args.sessionToken !== undefined ? { sessionToken: args.sessionToken } : {}),
        ...(args.notes !== undefined ? { notes: args.notes } : {}),
        ...(args.markConnected ? { lastConnectedAt: now } : {}),
        updatedAt: now,
      });
      return { id: existing._id, created: false };
    }
    const id = await ctx.db.insert("servers", {
      userId,
      name: args.name,
      baseUrl,
      kind: args.kind,
      sessionToken: args.sessionToken,
      notes: args.notes,
      lastConnectedAt: args.markConnected ? now : undefined,
      createdAt: now,
      updatedAt: now,
    });
    return { id, created: true };
  },
});

export const touch = mutation({
  args: { deviceKey: v.optional(v.string()), baseUrl: v.string() },
  handler: async (ctx, args) => {
    const userId = await ensureUser(ctx, args.deviceKey);
    const existing = await ctx.db
      .query("servers")
      .withIndex("by_user_url", (q) =>
        q.eq("userId", userId).eq("baseUrl", normalizeBaseUrl(args.baseUrl))
      )
      .unique();
    if (existing) {
      await ctx.db.patch(existing._id, { lastConnectedAt: Date.now() });
    }
    return { ok: existing !== null };
  },
});

export const remove = mutation({
  args: { deviceKey: v.optional(v.string()), baseUrl: v.string() },
  handler: async (ctx, args) => {
    const userId = await ensureUser(ctx, args.deviceKey);
    const existing = await ctx.db
      .query("servers")
      .withIndex("by_user_url", (q) =>
        q.eq("userId", userId).eq("baseUrl", normalizeBaseUrl(args.baseUrl))
      )
      .unique();
    if (existing) {
      await ctx.db.delete(existing._id);
    }
    return { ok: existing !== null };
  },
});
