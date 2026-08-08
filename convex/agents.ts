import { v } from "convex/values";
import { mutation } from "./_generated/server";
import { ensureUser } from "./lib/identity";

/** Upsert the user's setup state for one agent backend (no secrets). */
export const save = mutation({
  args: {
    deviceKey: v.optional(v.string()),
    backendId: v.string(),
    enabled: v.boolean(),
    defaultModelId: v.optional(v.string()),
    defaultModelName: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const userId = await ensureUser(ctx, args.deviceKey);
    const existing = await ctx.db
      .query("agentPrefs")
      .withIndex("by_user_backend", (q) =>
        q.eq("userId", userId).eq("backendId", args.backendId)
      )
      .unique();
    const now = Date.now();
    if (existing) {
      await ctx.db.patch(existing._id, {
        enabled: args.enabled,
        defaultModelId: args.defaultModelId ?? existing.defaultModelId,
        defaultModelName: args.defaultModelName ?? existing.defaultModelName,
        configuredAt: now,
      });
    } else {
      await ctx.db.insert("agentPrefs", {
        userId,
        backendId: args.backendId,
        enabled: args.enabled,
        defaultModelId: args.defaultModelId,
        defaultModelName: args.defaultModelName,
        configuredAt: now,
      });
    }
    return { ok: true };
  },
});
