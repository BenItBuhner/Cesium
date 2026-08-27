import { v } from "convex/values";
import { mutation } from "./_generated/server";
import { ensureUser } from "./lib/identity";

/**
 * Merge onboarding progress. Steps are additive across devices - a step
 * completed anywhere is completed everywhere.
 */
export const update = mutation({
  args: {
    deviceKey: v.optional(v.string()),
    platform: v.string(),
    completeSteps: v.optional(v.array(v.string())),
    markComplete: v.optional(v.boolean()),
  },
  handler: async (ctx, args) => {
    const userId = await ensureUser(ctx, args.deviceKey);
    const existing = await ctx.db
      .query("onboarding")
      .withIndex("by_user", (q) => q.eq("userId", userId))
      .unique();
    const now = Date.now();
    const mergedSteps = Array.from(
      new Set([...(existing?.completedSteps ?? []), ...(args.completeSteps ?? [])])
    );
    const completedAt = args.markComplete
      ? (existing?.completedAt ?? now)
      : existing?.completedAt;
    if (existing) {
      await ctx.db.patch(existing._id, {
        platform: args.platform,
        completedSteps: mergedSteps,
        completedAt,
        updatedAt: now,
      });
    } else {
      await ctx.db.insert("onboarding", {
        userId,
        platform: args.platform,
        completedSteps: mergedSteps,
        completedAt,
        updatedAt: now,
      });
    }
    return { completedSteps: mergedSteps, completedAt: completedAt ?? null };
  },
});
