import { v } from "convex/values";
import { mutation } from "./_generated/server";
import { ensureUser } from "./lib/identity";

const MAX_PAYLOAD_CHARS = 64_000;

/** Save the portable personalization payload (client `UserPreferences` JSON). */
export const save = mutation({
  args: { deviceKey: v.optional(v.string()), payload: v.string() },
  handler: async (ctx, args) => {
    if (args.payload.length > MAX_PAYLOAD_CHARS) {
      throw new Error("Preferences payload too large.");
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
    return { ok: true };
  },
});
