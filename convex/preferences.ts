import { v } from "convex/values";
import { mutation, query } from "./_generated/server";
import { ensureUser, getAuthedUser } from "./lib/identity";

/**
 * The account settings document: a JSON string of
 * `{ version: 2, settings: <account-synced GlobalSettingsState slices> }`
 * (see `src/lib/cloud/account-settings.ts`). One row per user; every
 * signed-in client subscribes to it and applies changes live, so a model
 * pick or rail tweak on one device shows up on every other device.
 *
 * Generous cap: the document carries theme presets, keyboard shortcuts, rail
 * appearances, chat folders, and per-harness model memory. Convex documents
 * are limited to 1 MiB; this leaves ample headroom while still rejecting
 * runaway payloads.
 */
const MAX_PAYLOAD_CHARS = 256_000;

const preferencesDoc = v.object({
  payload: v.string(),
  updatedAt: v.number(),
});

/** Current account settings document, or `null` when the user never saved one. */
export const get = query({
  args: { deviceKey: v.optional(v.string()) },
  returns: v.union(preferencesDoc, v.null()),
  handler: async (ctx, args) => {
    const user = await getAuthedUser(ctx, args.deviceKey);
    if (!user) {
      return null;
    }
    const row = await ctx.db
      .query("preferences")
      .withIndex("by_user", (q) => q.eq("userId", user._id))
      .unique();
    return row ? { payload: row.payload, updatedAt: row.updatedAt } : null;
  },
});

/**
 * Save the account settings document. The write timestamp is assigned here so
 * every device compares against the same clock when resolving conflicts.
 */
export const save = mutation({
  args: { deviceKey: v.optional(v.string()), payload: v.string() },
  returns: v.object({ ok: v.boolean(), updatedAt: v.number() }),
  handler: async (ctx, args) => {
    if (args.payload.length > MAX_PAYLOAD_CHARS) {
      throw new Error("Settings payload too large.");
    }
    JSON.parse(args.payload); // reject non-JSON early
    const userId = await ensureUser(ctx, args.deviceKey);
    const now = Date.now();
    const existing = await ctx.db
      .query("preferences")
      .withIndex("by_user", (q) => q.eq("userId", userId))
      .unique();
    if (existing) {
      await ctx.db.patch(existing._id, { payload: args.payload, updatedAt: now });
    } else {
      await ctx.db.insert("preferences", {
        userId,
        payload: args.payload,
        updatedAt: now,
      });
    }
    return { ok: true, updatedAt: now };
  },
});
