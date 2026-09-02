import { v } from "convex/values";
import { mutation } from "./_generated/server";
import type { Doc, Id } from "./_generated/dataModel";
import type { MutationCtx } from "./_generated/server";
import { ensureUser } from "./lib/identity";

/**
 * Account-to-account server sharing.
 *
 * The owner of a `servers` row grants access to another Cesium account, by
 * email (auto-matched to the recipient's signed-in identity) and/or by an
 * invite link carrying a capability code. The recipient accepts or declines;
 * accepted grants surface the server's connection payload (base URL,
 * rendezvous locator, session token) in the recipient's bootstrap. The owner
 * can pause, time-limit, or revoke a grant at any time; the recipient can
 * leave. All reads flow through `context.bootstrap`, so state changes
 * propagate live over Convex reactivity.
 */

const INVITE_CODE_ALPHABET =
  "0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ-_";
const INVITE_CODE_PATTERN = /^[A-Za-z0-9_-]{16,64}$/;

function generateInviteCode(): string {
  const bytes = new Uint8Array(24);
  crypto.getRandomValues(bytes);
  // 64-char alphabet keeps `byte & 63` uniform: 24 chars = 144 bits entropy.
  return Array.from(bytes, (byte) => INVITE_CODE_ALPHABET[byte & 63]).join("");
}

export function normalizeShareEmail(email: string): string {
  return email.trim().toLowerCase();
}

function isValidEmail(email: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
}

function normalizeBaseUrl(baseUrl: string): string {
  return baseUrl.trim().replace(/\/+$/, "");
}

async function getUserDoc(
  ctx: MutationCtx,
  deviceKey: string | undefined
): Promise<Doc<"users">> {
  const userId = await ensureUser(ctx, deviceKey);
  const user = await ctx.db.get(userId);
  if (!user) {
    throw new Error("User record not found.");
  }
  return user;
}

async function findOwnedServer(
  ctx: MutationCtx,
  userId: Id<"users">,
  args: { baseUrl?: string; rendezvousServerId?: string }
): Promise<Doc<"servers"> | null> {
  if (args.rendezvousServerId) {
    const rows = await ctx.db
      .query("servers")
      .withIndex("by_user", (q) => q.eq("userId", userId))
      .collect();
    return (
      rows.find((row) => row.rendezvous?.serverId === args.rendezvousServerId) ??
      null
    );
  }
  if (args.baseUrl) {
    return await ctx.db
      .query("servers")
      .withIndex("by_user_url", (q) =>
        q.eq("userId", userId).eq("baseUrl", normalizeBaseUrl(args.baseUrl!))
      )
      .unique();
  }
  return null;
}

/** True when this user may respond to the share (addressed or claimed by them). */
function isShareGrantee(share: Doc<"serverShares">, user: Doc<"users">): boolean {
  if (share.granteeUserId) {
    return share.granteeUserId === user._id;
  }
  const email = user.email ? normalizeShareEmail(user.email) : null;
  return Boolean(email && share.granteeEmail && share.granteeEmail === email);
}

/**
 * Owner creates a grant for one of their servers. Addressed by email, or
 * link-only when no email is given. Re-inviting the same email while a
 * pending invite exists refreshes and returns that invite instead of
 * stacking duplicates.
 */
export const create = mutation({
  args: {
    deviceKey: v.optional(v.string()),
    baseUrl: v.optional(v.string()),
    rendezvousServerId: v.optional(v.string()),
    granteeEmail: v.optional(v.string()),
    expiresAt: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    const owner = await getUserDoc(ctx, args.deviceKey);
    const server = await findOwnedServer(ctx, owner._id, args);
    if (!server) {
      throw new Error(
        "Server not found on your account. Make sure it has synced before sharing."
      );
    }
    const email = args.granteeEmail
      ? normalizeShareEmail(args.granteeEmail)
      : undefined;
    if (email !== undefined) {
      if (!isValidEmail(email)) {
        throw new Error("Enter a valid email address for the invite.");
      }
      if (owner.email && normalizeShareEmail(owner.email) === email) {
        throw new Error("That is your own account email - no share needed.");
      }
    }
    const now = Date.now();
    if (args.expiresAt !== undefined && args.expiresAt <= now) {
      throw new Error("Expiry must be in the future.");
    }
    if (email) {
      const existing = await ctx.db
        .query("serverShares")
        .withIndex("by_server", (q) => q.eq("serverId", server._id))
        .collect();
      const live = existing.find(
        (share) =>
          share.granteeEmail === email &&
          (share.status === "pending" || share.status === "accepted")
      );
      if (live?.status === "accepted") {
        throw new Error("This server is already shared with that email.");
      }
      if (live) {
        await ctx.db.patch(live._id, {
          expiresAt: args.expiresAt,
          updatedAt: now,
        });
        return {
          shareId: live._id,
          inviteCode: live.inviteCode,
          created: false,
        };
      }
    }
    const shareId = await ctx.db.insert("serverShares", {
      serverId: server._id,
      ownerUserId: owner._id,
      granteeEmail: email,
      inviteCode: generateInviteCode(),
      status: "pending",
      paused: false,
      expiresAt: args.expiresAt,
      createdAt: now,
      updatedAt: now,
    });
    const share = await ctx.db.get(shareId);
    return { shareId, inviteCode: share!.inviteCode, created: true };
  },
});

/**
 * Recipient accepts or declines a share addressed to them. Accepted shares
 * can also be left later (`accept: false` on an accepted share).
 */
export const respond = mutation({
  args: {
    deviceKey: v.optional(v.string()),
    shareId: v.id("serverShares"),
    accept: v.boolean(),
  },
  handler: async (ctx, args) => {
    const user = await getUserDoc(ctx, args.deviceKey);
    const share = await ctx.db.get(args.shareId);
    if (!share || !isShareGrantee(share, user)) {
      throw new Error("Share invite not found.");
    }
    if (share.status !== "pending" && share.status !== "accepted") {
      throw new Error("This share is no longer active.");
    }
    if (share.status === "accepted" && args.accept) {
      return { status: share.status };
    }
    const now = Date.now();
    if (args.accept && share.expiresAt !== undefined && share.expiresAt <= now) {
      throw new Error("This invite has expired. Ask the owner to share again.");
    }
    const status = args.accept ? "accepted" : "declined";
    await ctx.db.patch(share._id, {
      granteeUserId: user._id,
      status,
      respondedAt: now,
      updatedAt: now,
    });
    return { status };
  },
});

/**
 * Claim an invite link. Possession of the code is the capability: the link
 * was handed out deliberately (email forward, chat, etc.), so claiming
 * accepts immediately - the recipient clicked it on purpose.
 */
export const claimByCode = mutation({
  args: {
    deviceKey: v.optional(v.string()),
    inviteCode: v.string(),
  },
  handler: async (ctx, args) => {
    const user = await getUserDoc(ctx, args.deviceKey);
    const code = args.inviteCode.trim();
    if (!INVITE_CODE_PATTERN.test(code)) {
      throw new Error("That invite code is not valid.");
    }
    const share = await ctx.db
      .query("serverShares")
      .withIndex("by_code", (q) => q.eq("inviteCode", code))
      .unique();
    if (!share || share.status === "revoked") {
      throw new Error("Invite not found or revoked.");
    }
    if (share.ownerUserId === user._id) {
      throw new Error("This is your own invite link - share it with someone else.");
    }
    const now = Date.now();
    if (share.expiresAt !== undefined && share.expiresAt <= now) {
      throw new Error("This invite has expired. Ask the owner to share again.");
    }
    const server = await ctx.db.get(share.serverId);
    const owner = await ctx.db.get(share.ownerUserId);
    if (share.status === "accepted" && share.granteeUserId === user._id) {
      return {
        serverName: server?.name ?? "Shared server",
        ownerName: owner?.name ?? owner?.email ?? null,
        alreadyAccepted: true,
      };
    }
    if (share.status === "accepted") {
      throw new Error("This invite was already claimed by another account.");
    }
    await ctx.db.patch(share._id, {
      granteeUserId: user._id,
      status: "accepted",
      respondedAt: now,
      updatedAt: now,
    });
    return {
      serverName: server?.name ?? "Shared server",
      ownerName: owner?.name ?? owner?.email ?? null,
      alreadyAccepted: false,
    };
  },
});

/** Owner-side controls: pause/resume and adjust (or clear) the expiry. */
export const update = mutation({
  args: {
    deviceKey: v.optional(v.string()),
    shareId: v.id("serverShares"),
    paused: v.optional(v.boolean()),
    expiresAt: v.optional(v.union(v.number(), v.null())),
  },
  handler: async (ctx, args) => {
    const owner = await getUserDoc(ctx, args.deviceKey);
    const share = await ctx.db.get(args.shareId);
    if (!share || share.ownerUserId !== owner._id) {
      throw new Error("Share not found.");
    }
    if (share.status === "revoked") {
      throw new Error("This share was revoked - create a new one instead.");
    }
    const now = Date.now();
    if (
      args.expiresAt !== undefined &&
      args.expiresAt !== null &&
      args.expiresAt <= now
    ) {
      throw new Error("Expiry must be in the future.");
    }
    await ctx.db.patch(share._id, {
      ...(args.paused !== undefined ? { paused: args.paused } : {}),
      ...(args.expiresAt !== undefined
        ? { expiresAt: args.expiresAt === null ? undefined : args.expiresAt }
        : {}),
      updatedAt: now,
    });
    return { ok: true };
  },
});

/** Owner revokes a grant. The recipient loses access on their next sync. */
export const revoke = mutation({
  args: {
    deviceKey: v.optional(v.string()),
    shareId: v.id("serverShares"),
  },
  handler: async (ctx, args) => {
    const owner = await getUserDoc(ctx, args.deviceKey);
    const share = await ctx.db.get(args.shareId);
    if (!share || share.ownerUserId !== owner._id) {
      throw new Error("Share not found.");
    }
    await ctx.db.patch(share._id, {
      status: "revoked",
      paused: false,
      updatedAt: Date.now(),
    });
    return { ok: true };
  },
});

/** Owner deletes a finished (declined/revoked) grant row from the list. */
export const remove = mutation({
  args: {
    deviceKey: v.optional(v.string()),
    shareId: v.id("serverShares"),
  },
  handler: async (ctx, args) => {
    const owner = await getUserDoc(ctx, args.deviceKey);
    const share = await ctx.db.get(args.shareId);
    if (!share || share.ownerUserId !== owner._id) {
      throw new Error("Share not found.");
    }
    if (share.status === "accepted" || share.status === "pending") {
      throw new Error("Revoke the share before deleting it.");
    }
    await ctx.db.delete(share._id);
    return { ok: true };
  },
});
