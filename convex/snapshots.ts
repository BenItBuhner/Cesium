import { v } from "convex/values";
import { mutation, query } from "./_generated/server";
import { ensureUser, getAuthedUser } from "./lib/identity";

/**
 * Portable conversation snapshots. The engine exports a sanitized
 * `{ record, events }` pair (see `GET /api/agents/conversations/:id/snapshot`);
 * any other engine can materialize it via the import chassis.
 */

const MAX_EVENTS_CHARS = 900_000; // stay under Convex's ~1MiB document ceiling
const MAX_RECORD_CHARS = 64_000;

export const push = mutation({
  args: {
    deviceKey: v.optional(v.string()),
    snapshotKey: v.string(),
    title: v.string(),
    backendId: v.string(),
    modelId: v.optional(v.string()),
    modelName: v.optional(v.string()),
    workspaceName: v.optional(v.string()),
    serverName: v.optional(v.string()),
    messageCount: v.number(),
    recordJson: v.string(),
    eventsJson: v.string(),
    sourceUpdatedAt: v.number(),
  },
  handler: async (ctx, args) => {
    if (args.recordJson.length > MAX_RECORD_CHARS) {
      throw new Error("Conversation record too large for a cloud snapshot.");
    }
    if (args.eventsJson.length > MAX_EVENTS_CHARS) {
      throw new Error(
        "Conversation transcript too large for a cloud snapshot. Trim events before pushing."
      );
    }
    const userId = await ensureUser(ctx, args.deviceKey);
    const now = Date.now();
    const existing = await ctx.db
      .query("conversationSnapshots")
      .withIndex("by_user_key", (q) =>
        q.eq("userId", userId).eq("snapshotKey", args.snapshotKey)
      )
      .unique();
    const fields = {
      title: args.title,
      backendId: args.backendId,
      modelId: args.modelId,
      modelName: args.modelName,
      workspaceName: args.workspaceName,
      serverName: args.serverName,
      messageCount: args.messageCount,
      recordJson: args.recordJson,
      eventsJson: args.eventsJson,
      sourceUpdatedAt: args.sourceUpdatedAt,
      updatedAt: now,
    };
    if (existing) {
      await ctx.db.patch(existing._id, fields);
      return { created: false };
    }
    await ctx.db.insert("conversationSnapshots", {
      userId,
      snapshotKey: args.snapshotKey,
      createdAt: now,
      ...fields,
    });
    return { created: true };
  },
});

/** Full snapshot (with transcript) for materializing on an engine. */
export const get = query({
  args: { deviceKey: v.optional(v.string()), snapshotKey: v.string() },
  handler: async (ctx, args) => {
    const user = await getAuthedUser(ctx, args.deviceKey);
    if (!user) {
      return null;
    }
    const snapshot = await ctx.db
      .query("conversationSnapshots")
      .withIndex("by_user_key", (q) =>
        q.eq("userId", user._id).eq("snapshotKey", args.snapshotKey)
      )
      .unique();
    if (!snapshot) {
      return null;
    }
    return {
      snapshotKey: snapshot.snapshotKey,
      title: snapshot.title,
      backendId: snapshot.backendId,
      modelId: snapshot.modelId ?? null,
      modelName: snapshot.modelName ?? null,
      workspaceName: snapshot.workspaceName ?? null,
      serverName: snapshot.serverName ?? null,
      messageCount: snapshot.messageCount,
      recordJson: snapshot.recordJson,
      eventsJson: snapshot.eventsJson,
      sourceUpdatedAt: snapshot.sourceUpdatedAt,
    };
  },
});

export const remove = mutation({
  args: { deviceKey: v.optional(v.string()), snapshotKey: v.string() },
  handler: async (ctx, args) => {
    const userId = await ensureUser(ctx, args.deviceKey);
    const existing = await ctx.db
      .query("conversationSnapshots")
      .withIndex("by_user_key", (q) =>
        q.eq("userId", userId).eq("snapshotKey", args.snapshotKey)
      )
      .unique();
    if (existing) {
      await ctx.db.delete(existing._id);
    }
    return { ok: existing !== null };
  },
});
