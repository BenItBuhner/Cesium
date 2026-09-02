import { v } from "convex/values";
import { mutation, query } from "./_generated/server";
import type { Doc, Id } from "./_generated/dataModel";
import type { QueryCtx } from "./_generated/server";
import { ensureUser, getAuthedUser } from "./lib/identity";

/**
 * Server-sharing views for one user, computed from `serverShares`:
 * - incoming: invites addressed to me (by claimed user id or account email),
 *   pending or accepted - what the recipient manages.
 * - outgoing: grants I own across all my servers - what the owner manages.
 * - sharedServers: connection payloads for accepted, unpaused, unexpired
 *   grants, shaped like owned servers so clients can connect the same way.
 *
 * `now` comes from the client (queries must stay deterministic), so expiry
 * filtering is as fresh as the client's last bootstrap.
 */
async function collectShareViews(
  ctx: QueryCtx,
  user: Doc<"users">,
  now: number | undefined
) {
  const [claimed, addressed, outgoingRows] = await Promise.all([
    ctx.db
      .query("serverShares")
      .withIndex("by_grantee", (q) => q.eq("granteeUserId", user._id))
      .collect(),
    user.email
      ? ctx.db
          .query("serverShares")
          .withIndex("by_email", (q) =>
            q.eq("granteeEmail", user.email!.trim().toLowerCase())
          )
          .collect()
      : Promise.resolve([] as Doc<"serverShares">[]),
    ctx.db
      .query("serverShares")
      .withIndex("by_owner", (q) => q.eq("ownerUserId", user._id))
      .collect(),
  ]);
  const incomingRows = [
    ...claimed,
    // Email-addressed invites not yet claimed by any account.
    ...addressed.filter((share) => !share.granteeUserId),
  ].filter(
    (share) =>
      share.ownerUserId !== user._id &&
      (share.status === "pending" || share.status === "accepted")
  );

  const serverIds = new Set<Id<"servers">>();
  const userIds = new Set<Id<"users">>();
  for (const share of incomingRows) {
    serverIds.add(share.serverId);
    userIds.add(share.ownerUserId);
  }
  for (const share of outgoingRows) {
    serverIds.add(share.serverId);
    if (share.granteeUserId) {
      userIds.add(share.granteeUserId);
    }
  }
  const serverById = new Map<Id<"servers">, Doc<"servers"> | null>();
  const userById = new Map<Id<"users">, Doc<"users"> | null>();
  await Promise.all([
    ...[...serverIds].map(async (id) => {
      serverById.set(id, await ctx.db.get(id));
    }),
    ...[...userIds].map(async (id) => {
      userById.set(id, await ctx.db.get(id));
    }),
  ]);

  const isExpired = (share: Doc<"serverShares">) =>
    share.expiresAt !== undefined && now !== undefined && share.expiresAt <= now;

  const incomingShares = incomingRows.map((share) => {
    const owner = userById.get(share.ownerUserId) ?? null;
    const server = serverById.get(share.serverId) ?? null;
    return {
      shareId: share._id,
      serverName: server?.name ?? "Shared server",
      ownerName: owner?.name ?? null,
      ownerEmail: owner?.email ?? null,
      status: share.status as "pending" | "accepted",
      paused: share.paused,
      expiresAt: share.expiresAt ?? null,
      expired: isExpired(share),
      createdAt: share.createdAt,
    };
  });

  const outgoingShares = outgoingRows.map((share) => {
    const grantee = share.granteeUserId
      ? (userById.get(share.granteeUserId) ?? null)
      : null;
    const server = serverById.get(share.serverId) ?? null;
    return {
      shareId: share._id,
      serverName: server?.name ?? "Removed server",
      serverBaseUrl: server?.baseUrl ?? null,
      serverRendezvousId: server?.rendezvous?.serverId ?? null,
      granteeEmail: share.granteeEmail ?? null,
      granteeName: grantee?.name ?? grantee?.email ?? null,
      inviteCode: share.inviteCode,
      status: share.status,
      paused: share.paused,
      expiresAt: share.expiresAt ?? null,
      expired: isExpired(share),
      createdAt: share.createdAt,
      respondedAt: share.respondedAt ?? null,
    };
  });

  const sharedServers = incomingRows
    .filter(
      (share) =>
        share.status === "accepted" && !share.paused && !isExpired(share)
    )
    .flatMap((share) => {
      const server = serverById.get(share.serverId);
      if (!server) {
        return [];
      }
      const owner = userById.get(share.ownerUserId) ?? null;
      // Codespace lifecycle metadata (and its embedded engine credentials)
      // stays with the owner; recipients get connection material only.
      return [
        {
          shareId: share._id,
          name: server.name,
          baseUrl: server.baseUrl,
          kind: server.kind,
          sessionToken: server.sessionToken ?? null,
          rendezvous: server.rendezvous ?? null,
          notes: server.notes ?? null,
          lastConnectedAt: server.lastConnectedAt ?? null,
          ownerName: owner?.name ?? owner?.email ?? null,
        },
      ];
    });

  return { incomingShares, outgoingShares, sharedServers };
}

/**
 * One-round-trip boot for a Cesium client: everything needed to restore the
 * user's world on a fresh device. Returns `null` when not authenticated (the
 * client then runs purely local-first).
 */
export const bootstrap = query({
  args: {
    deviceKey: v.optional(v.string()),
    /** Client clock (ms epoch) used only to filter expired shares. */
    now: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    const user = await getAuthedUser(ctx, args.deviceKey);
    if (!user) {
      return null;
    }
    const [servers, preferences, agentPrefs, onboarding, snapshots, secrets, shareViews] =
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
        collectShareViews(ctx, user, args.now),
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
      /** Servers other accounts shared with this user (accepted + live). */
      sharedServers: shareViews.sharedServers,
      /** Invites/grants addressed to this user, for the recipient-side UI. */
      incomingShares: shareViews.incomingShares,
      /** Grants this user owns across their servers, for the owner-side UI. */
      outgoingShares: shareViews.outgoingShares,
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
