import type { MutationCtx, QueryCtx } from "../_generated/server";
import type { Doc, Id } from "../_generated/dataModel";

/**
 * Identity resolution for Cesium Cloud Context functions.
 *
 * Production path: Clerk JWT via Convex auth (`ctx.auth.getUserIdentity()`).
 * Fallback path: an explicit `deviceKey` argument, honored ONLY when the
 * deployment opts in with `CESIUM_ALLOW_DEVICE_KEYS=1` (set on local/dev
 * deployments; never on production). This keeps every function
 * production-shaped while letting local-first installs sync without Clerk.
 */

const DEVICE_KEY_PATTERN = /^[A-Za-z0-9-]{16,64}$/;

export type ResolvedIdentity = {
  key: string;
  name?: string;
  email?: string;
  imageUrl?: string;
};

export async function resolveIdentity(
  ctx: QueryCtx | MutationCtx,
  deviceKey: string | undefined
): Promise<ResolvedIdentity | null> {
  const identity = await ctx.auth.getUserIdentity();
  if (identity) {
    return {
      key: `clerk:${identity.subject}`,
      name: typeof identity.name === "string" ? identity.name : undefined,
      email: typeof identity.email === "string" ? identity.email : undefined,
      imageUrl:
        typeof identity.pictureUrl === "string" ? identity.pictureUrl : undefined,
    };
  }
  if (
    deviceKey &&
    process.env.CESIUM_ALLOW_DEVICE_KEYS === "1" &&
    DEVICE_KEY_PATTERN.test(deviceKey)
  ) {
    return { key: `device:${deviceKey}` };
  }
  return null;
}

export async function requireIdentity(
  ctx: QueryCtx | MutationCtx,
  deviceKey: string | undefined
): Promise<ResolvedIdentity> {
  const resolved = await resolveIdentity(ctx, deviceKey);
  if (!resolved) {
    throw new Error(
      "Not authenticated. Sign in (Clerk) or supply a device key on a deployment with CESIUM_ALLOW_DEVICE_KEYS=1."
    );
  }
  return resolved;
}

export async function findUser(
  ctx: QueryCtx | MutationCtx,
  key: string
): Promise<Doc<"users"> | null> {
  return await ctx.db
    .query("users")
    .withIndex("by_key", (q) => q.eq("key", key))
    .unique();
}

/** Resolve identity and load the user row without writing (query-safe). */
export async function getAuthedUser(
  ctx: QueryCtx | MutationCtx,
  deviceKey: string | undefined
): Promise<Doc<"users"> | null> {
  const resolved = await resolveIdentity(ctx, deviceKey);
  if (!resolved) {
    return null;
  }
  return await findUser(ctx, resolved.key);
}

/** Resolve identity and upsert the user row (mutations only). */
export async function ensureUser(
  ctx: MutationCtx,
  deviceKey: string | undefined
): Promise<Id<"users">> {
  const resolved = await requireIdentity(ctx, deviceKey);
  const existing = await findUser(ctx, resolved.key);
  const now = Date.now();
  if (existing) {
    await ctx.db.patch(existing._id, {
      lastSeenAt: now,
      ...(resolved.name ? { name: resolved.name } : {}),
      ...(resolved.email ? { email: resolved.email } : {}),
      ...(resolved.imageUrl ? { imageUrl: resolved.imageUrl } : {}),
    });
    return existing._id;
  }
  return await ctx.db.insert("users", {
    key: resolved.key,
    name: resolved.name,
    email: resolved.email,
    imageUrl: resolved.imageUrl,
    createdAt: now,
    lastSeenAt: now,
  });
}
