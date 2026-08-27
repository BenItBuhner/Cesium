import { v } from "convex/values";
import { mutation } from "./_generated/server";
import type { Doc } from "./_generated/dataModel";
import type { MutationCtx } from "./_generated/server";
import { ensureUser } from "./lib/identity";

const RENDEZVOUS_SERVER_ID_PATTERN = /^[A-Za-z0-9_-]{24,80}$/;
const RENDEZVOUS_SECRET_PATTERN = /^[A-Za-z0-9_-]{32,128}$/;

const rendezvousValidator = v.object({
  version: v.number(),
  serverId: v.string(),
  secret: v.string(),
  registryBaseUrl: v.string(),
});

type RendezvousLocator = {
  version: number;
  serverId: string;
  secret: string;
  registryBaseUrl: string;
};

function normalizeBaseUrl(baseUrl: string): string {
  return baseUrl.trim().replace(/\/+$/, "");
}

function validateRendezvous(locator: RendezvousLocator): RendezvousLocator {
  if (
    locator.version !== 1 ||
    !RENDEZVOUS_SERVER_ID_PATTERN.test(locator.serverId) ||
    !RENDEZVOUS_SECRET_PATTERN.test(locator.secret) ||
    !/^https?:\/\//.test(locator.registryBaseUrl)
  ) {
    throw new Error("Invalid rendezvous locator.");
  }
  return {
    version: 1,
    serverId: locator.serverId,
    secret: locator.secret,
    registryBaseUrl: normalizeBaseUrl(locator.registryBaseUrl),
  };
}

async function findByRendezvousServerId(
  ctx: MutationCtx,
  userId: Doc<"servers">["userId"],
  rendezvousServerId: string
): Promise<Doc<"servers"> | null> {
  const rows = await ctx.db
    .query("servers")
    .withIndex("by_user", (q) => q.eq("userId", userId))
    .collect();
  return rows.find((row) => row.rendezvous?.serverId === rendezvousServerId) ?? null;
}

/**
 * Upsert one of the user's engines. Tunnel-backed engines (public access) are
 * keyed by their rendezvous server id - their base URL rotates with the
 * tunnel - while plain engines stay keyed by base URL.
 */
export const save = mutation({
  args: {
    deviceKey: v.optional(v.string()),
    name: v.string(),
    baseUrl: v.string(),
    kind: v.union(v.literal("remote"), v.literal("local")),
    sessionToken: v.optional(v.string()),
    rendezvous: v.optional(rendezvousValidator),
    notes: v.optional(v.string()),
    markConnected: v.optional(v.boolean()),
  },
  handler: async (ctx, args) => {
    const userId = await ensureUser(ctx, args.deviceKey);
    const baseUrl = normalizeBaseUrl(args.baseUrl);
    if (!/^https?:\/\//.test(baseUrl)) {
      throw new Error("Server base URL must be http(s).");
    }
    let hostname = "";
    try {
      hostname = new URL(baseUrl).hostname.toLowerCase();
    } catch {
      throw new Error("Server base URL must be http(s).");
    }
    if (
      hostname === "cesium.techlitnow.com" ||
      hostname === "www.cesium.techlitnow.com"
    ) {
      throw new Error(
        "cesium.techlitnow.com is the Cesium account site, not an engine."
      );
    }
    const rendezvous = args.rendezvous ? validateRendezvous(args.rendezvous) : undefined;
    const now = Date.now();
    const existing =
      (rendezvous
        ? await findByRendezvousServerId(ctx, userId, rendezvous.serverId)
        : null) ??
      (await ctx.db
        .query("servers")
        .withIndex("by_user_url", (q) => q.eq("userId", userId).eq("baseUrl", baseUrl))
        .unique());
    if (existing) {
      await ctx.db.patch(existing._id, {
        name: args.name,
        baseUrl,
        kind: args.kind,
        ...(args.sessionToken !== undefined ? { sessionToken: args.sessionToken } : {}),
        ...(rendezvous ? { rendezvous } : {}),
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
      ...(rendezvous ? { rendezvous } : {}),
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
  args: {
    deviceKey: v.optional(v.string()),
    baseUrl: v.optional(v.string()),
    /** Removes a tunnel-backed engine even after its base URL rotated. */
    rendezvousServerId: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const userId = await ensureUser(ctx, args.deviceKey);
    const existing = args.rendezvousServerId
      ? await findByRendezvousServerId(ctx, userId, args.rendezvousServerId)
      : args.baseUrl
        ? await ctx.db
            .query("servers")
            .withIndex("by_user_url", (q) =>
              q.eq("userId", userId).eq("baseUrl", normalizeBaseUrl(args.baseUrl!))
            )
            .unique()
        : null;
    if (existing) {
      await ctx.db.delete(existing._id);
    }
    return { ok: existing !== null };
  },
});
