import { v } from "convex/values";
import { mutation, query } from "./_generated/server";
import { ensureUser, getAuthedUser } from "./lib/identity";

/**
 * One-round-trip boot for a Cesium client: everything needed to restore the
 * user's world on a fresh device. Returns `null` when not authenticated (the
 * client then runs purely local-first).
 */
export const bootstrap = query({
  args: { deviceKey: v.optional(v.string()) },
  handler: async (ctx, args) => {
    const user = await getAuthedUser(ctx, args.deviceKey);
    if (!user) {
      return null;
    }
    const [servers, preferences, agentPrefs, onboarding, snapshots, secrets] =
      await Promise.all([
        ctx.db
          .query("servers")
          .withIndex("by_user", (q) => q.eq("userId", user._id))
          .collect(),
        ctx.db
          .query("preferences")
          .withIndex("by_user", (q) => q.eq("userId", user._id))
          .unique(),
        ctx.db
          .query("agentPrefs")
          .withIndex("by_user", (q) => q.eq("userId", user._id))
          .collect(),
        ctx.db
          .query("onboarding")
          .withIndex("by_user", (q) => q.eq("userId", user._id))
          .unique(),
        ctx.db
          .query("conversationSnapshots")
          .withIndex("by_user", (q) => q.eq("userId", user._id))
          .collect(),
        ctx.db
          .query("userSecrets")
          .withIndex("by_user_kind", (q) => q.eq("userId", user._id))
          .collect(),
      ]);
    return {
      user: {
        key: user.key,
        name: user.name ?? null,
        email: user.email ?? null,
        imageUrl: user.imageUrl ?? null,
        createdAt: user.createdAt,
      },
      servers: servers.map((server) => ({
        id: server._id,
        name: server.name,
        baseUrl: server.baseUrl,
        kind: server.kind,
        sessionToken: server.sessionToken ?? null,
        rendezvous: server.rendezvous ?? null,
        codespace: server.codespace ?? null,
        notes: server.notes ?? null,
        lastConnectedAt: server.lastConnectedAt ?? null,
      })),
      preferencesPayload: preferences?.payload ?? null,
      secrets: secrets.map((secret) => ({
        kind: secret.kind,
        payload: secret.payload,
        updatedAt: secret.updatedAt,
      })),
      agentPrefs: agentPrefs.map((pref) => ({
        backendId: pref.backendId,
        enabled: pref.enabled,
        defaultModelId: pref.defaultModelId ?? null,
        defaultModelName: pref.defaultModelName ?? null,
        configuredAt: pref.configuredAt,
      })),
      onboarding: onboarding
        ? {
            platform: onboarding.platform,
            completedSteps: onboarding.completedSteps,
            completedAt: onboarding.completedAt ?? null,
          }
        : null,
      /** Metadata only - transcripts are pulled per-snapshot on demand. */
      snapshots: snapshots
        .sort((a, b) => b.sourceUpdatedAt - a.sourceUpdatedAt)
        .map((snapshot) => ({
          snapshotKey: snapshot.snapshotKey,
          title: snapshot.title,
          backendId: snapshot.backendId,
          modelId: snapshot.modelId ?? null,
          modelName: snapshot.modelName ?? null,
          workspaceName: snapshot.workspaceName ?? null,
          serverName: snapshot.serverName ?? null,
          messageCount: snapshot.messageCount,
          sourceUpdatedAt: snapshot.sourceUpdatedAt,
          updatedAt: snapshot.updatedAt,
        })),
    };
  },
});

/** Register/refresh the signed-in user row (called once on client boot). */
export const register = mutation({
  args: { deviceKey: v.optional(v.string()) },
  handler: async (ctx, args) => {
    const userId = await ensureUser(ctx, args.deviceKey);
    const user = await ctx.db.get(userId);
    return { key: user!.key };
  },
});
