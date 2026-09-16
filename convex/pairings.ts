import { v } from "convex/values";
import { mutation, query } from "./_generated/server";
import type { Doc } from "./_generated/dataModel";
import type { MutationCtx, QueryCtx } from "./_generated/server";
import { ensureUser } from "./lib/identity";

/**
 * Engine pairings - the cloud half of the one-link "attach this engine to my
 * account" flow (device-authorization style).
 *
 * 1. The engine registers a pending pairing here (through the web app's
 *    `/api/connect/pairings` facade; it has no account identity yet) and
 *    prints `/connect/<code>`.
 * 2. A signed-in browser opening that link reads the pairing (`lookup`),
 *    fetches the engine credential *from the engine* with the code, stores
 *    the sealed credential + server row through the normal account
 *    mutations, then marks the pairing `approve`d.
 * 3. The engine polls `status` with its poll secret to learn who attached.
 *
 * Nothing secret is stored on these rows: the code is the URL capability,
 * the poll secret is hashed, and the credential never transits this table.
 */

export const PAIRING_CODE_PATTERN = /^[a-z0-9]{20,64}$/;
const SERVER_ID_PATTERN = /^[A-Za-z0-9_-]{24,80}$/;
const SECRET_HASH_PATTERN = /^[A-Za-z0-9_-]{32,128}$/;
const FINGERPRINT_PATTERN = /^[A-Z0-9]{4}(?:-[A-Z0-9]{4}){2}$/;
const MIN_TTL_MS = 60_000;
const MAX_TTL_MS = 15 * 60_000;
const DEFAULT_TTL_MS = 10 * 60_000;
/** Approved rows linger so a slow CLI poll still sees the result. */
const APPROVED_RETENTION_MS = 24 * 60 * 60_000;
const EXPIRED_SWEEP_LIMIT = 25;

const pairingStatusValidator = v.union(
  v.literal("pending"),
  v.literal("approved"),
  v.literal("expired"),
  v.literal("unknown")
);

const lookupResult = v.union(
  v.null(),
  v.object({
    status: v.union(v.literal("pending"), v.literal("approved"), v.literal("expired")),
    serverId: v.string(),
    fingerprint: v.string(),
    label: v.string(),
    publicUrl: v.string(),
    expiresAt: v.number(),
    createdAt: v.number(),
  })
);

function normalizeCode(code: string): string {
  const trimmed = code.trim().toLowerCase();
  if (!PAIRING_CODE_PATTERN.test(trimmed)) {
    throw new Error("Invalid pairing code.");
  }
  return trimmed;
}

function normalizePublicUrl(value: string): string {
  let url: URL;
  try {
    url = new URL(value.trim());
  } catch {
    throw new Error("Engine public URL must be an absolute URL.");
  }
  const loopback =
    url.hostname === "localhost" || url.hostname === "127.0.0.1" || url.hostname === "::1";
  if (url.protocol !== "https:" && !(url.protocol === "http:" && loopback)) {
    throw new Error("Engine public URL must use HTTPS.");
  }
  if (url.username || url.password) {
    throw new Error("Engine public URL must not include credentials.");
  }
  const hostname = url.hostname.toLowerCase();
  if (hostname === "cesium.techlitnow.com" || hostname === "www.cesium.techlitnow.com") {
    throw new Error("cesium.techlitnow.com is the Cesium account site, not an engine.");
  }
  url.hash = "";
  url.search = "";
  url.pathname = "";
  return url.toString().replace(/\/+$/, "");
}

function normalizeLabel(value: string): string {
  const label = value.trim().slice(0, 120);
  return label || "Cesium engine";
}

/** Constant-time string comparison (both inputs are base64url hashes). */
function safeEqual(left: string, right: string): boolean {
  if (left.length !== right.length) {
    return false;
  }
  let mismatch = 0;
  for (let index = 0; index < left.length; index += 1) {
    mismatch |= left.charCodeAt(index) ^ right.charCodeAt(index);
  }
  return mismatch === 0;
}

async function findByCode(
  ctx: QueryCtx | MutationCtx,
  code: string
): Promise<Doc<"enginePairings"> | null> {
  return await ctx.db
    .query("enginePairings")
    .withIndex("by_code", (q) => q.eq("code", code))
    .unique();
}

function isRowExpired(row: Doc<"enginePairings">, now: number): boolean {
  if (row.status === "approved") {
    return row.expiresAt + APPROVED_RETENTION_MS <= now;
  }
  return row.expiresAt <= now;
}

/** Drop a bounded batch of rows past their retention so the table stays small. */
async function sweepExpired(ctx: MutationCtx, now: number): Promise<void> {
  const candidates = await ctx.db
    .query("enginePairings")
    .withIndex("by_expiry", (q) => q.lt("expiresAt", now))
    .take(EXPIRED_SWEEP_LIMIT);
  for (const row of candidates) {
    if (isRowExpired(row, now)) {
      await ctx.db.delete(row._id);
    }
  }
}

/**
 * Engine registers a pending pairing. Unauthenticated by design - the engine
 * is exactly the party that has no account identity yet - so the surface is
 * bounded: one pending row per server id (a fresh `connect` supersedes the
 * previous link), short TTL, opportunistic expiry sweeps.
 */
export const create = mutation({
  args: {
    code: v.string(),
    pollSecretHash: v.string(),
    serverId: v.string(),
    fingerprint: v.string(),
    label: v.string(),
    publicUrl: v.string(),
    ttlMs: v.optional(v.number()),
  },
  returns: v.object({ ok: v.literal(true), expiresAt: v.number() }),
  handler: async (ctx, args) => {
    const code = normalizeCode(args.code);
    if (!SECRET_HASH_PATTERN.test(args.pollSecretHash)) {
      throw new Error("Invalid poll secret hash.");
    }
    if (!SERVER_ID_PATTERN.test(args.serverId)) {
      throw new Error("Invalid server id.");
    }
    if (!FINGERPRINT_PATTERN.test(args.fingerprint)) {
      throw new Error("Invalid engine fingerprint.");
    }
    const publicUrl = normalizePublicUrl(args.publicUrl);
    const label = normalizeLabel(args.label);
    const now = Date.now();
    const ttl = Math.min(
      MAX_TTL_MS,
      Math.max(
        MIN_TTL_MS,
        typeof args.ttlMs === "number" && Number.isFinite(args.ttlMs) ? args.ttlMs : DEFAULT_TTL_MS
      )
    );
    await sweepExpired(ctx, now);
    if (await findByCode(ctx, code)) {
      throw new Error("Pairing code collision - retry.");
    }
    const previous = await ctx.db
      .query("enginePairings")
      .withIndex("by_server", (q) => q.eq("serverId", args.serverId))
      .collect();
    for (const row of previous) {
      if (row.status === "pending") {
        await ctx.db.delete(row._id);
      }
    }
    const expiresAt = now + ttl;
    await ctx.db.insert("enginePairings", {
      code,
      pollSecretHash: args.pollSecretHash,
      serverId: args.serverId,
      fingerprint: args.fingerprint,
      label,
      publicUrl,
      status: "pending",
      createdAt: now,
      expiresAt,
      updatedAt: now,
    });
    return { ok: true as const, expiresAt };
  },
});

/**
 * Browser reads what it is about to attach. Public: possession of the code
 * is the capability, and the confirmation must render before sign-in so the
 * user sees which engine they are about to attach. `now` is the client clock
 * (queries stay deterministic).
 */
export const lookup = query({
  args: { code: v.string(), now: v.optional(v.number()) },
  returns: lookupResult,
  handler: async (ctx, args) => {
    let code: string;
    try {
      code = normalizeCode(args.code);
    } catch {
      return null;
    }
    const row = await findByCode(ctx, code);
    if (!row) {
      return null;
    }
    const now = typeof args.now === "number" ? args.now : row.createdAt;
    const status: "pending" | "approved" | "expired" =
      row.status === "approved" ? "approved" : row.expiresAt <= now ? "expired" : "pending";
    return {
      status,
      serverId: row.serverId,
      fingerprint: row.fingerprint,
      label: row.label,
      publicUrl: row.publicUrl,
      expiresAt: row.expiresAt,
      createdAt: row.createdAt,
    };
  },
});

/**
 * Signed-in browser marks the pairing approved after it has claimed the
 * credential from the engine and saved the server row + sealed secret. The
 * approving account is recorded so the engine can report who attached.
 */
export const approve = mutation({
  args: {
    deviceKey: v.optional(v.string()),
    code: v.string(),
    /** Server id the engine reported at claim time; must match the pairing. */
    serverId: v.string(),
  },
  returns: v.object({ ok: v.literal(true), alreadyApproved: v.boolean() }),
  handler: async (ctx, args) => {
    const userId = await ensureUser(ctx, args.deviceKey);
    const code = normalizeCode(args.code);
    const row = await findByCode(ctx, code);
    if (!row) {
      throw new Error("This connect link is no longer valid. Run `cesium-server connect` again.");
    }
    if (row.serverId !== args.serverId) {
      throw new Error("The engine that answered does not match this connect link.");
    }
    const now = Date.now();
    if (row.status === "approved") {
      if (row.approvedUserId === userId) {
        return { ok: true as const, alreadyApproved: true };
      }
      throw new Error("This connect link was already used by another account.");
    }
    if (row.expiresAt <= now) {
      throw new Error("This connect link expired. Run `cesium-server connect` again.");
    }
    await ctx.db.patch(row._id, {
      status: "approved",
      approvedUserId: userId,
      approvedAt: now,
      updatedAt: now,
    });
    return { ok: true as const, alreadyApproved: false };
  },
});

/**
 * Engine polls the outcome. Gated by the poll secret it minted (hashed by
 * the web facade), so only the engine that created the pairing learns who
 * attached it.
 */
export const status = query({
  args: { code: v.string(), pollSecretHash: v.string(), now: v.optional(v.number()) },
  returns: v.object({
    status: pairingStatusValidator,
    expiresAt: v.union(v.number(), v.null()),
    approvedBy: v.union(
      v.null(),
      v.object({ email: v.union(v.string(), v.null()), name: v.union(v.string(), v.null()) })
    ),
  }),
  handler: async (ctx, args) => {
    let code: string;
    try {
      code = normalizeCode(args.code);
    } catch {
      return { status: "unknown" as const, expiresAt: null, approvedBy: null };
    }
    const row = await findByCode(ctx, code);
    if (!row || !safeEqual(row.pollSecretHash, args.pollSecretHash)) {
      return { status: "unknown" as const, expiresAt: null, approvedBy: null };
    }
    if (row.status === "approved") {
      const user = row.approvedUserId ? await ctx.db.get(row.approvedUserId) : null;
      return {
        status: "approved" as const,
        expiresAt: row.expiresAt,
        approvedBy: { email: user?.email ?? null, name: user?.name ?? null },
      };
    }
    const now = typeof args.now === "number" ? args.now : row.createdAt;
    return {
      status: row.expiresAt <= now ? ("expired" as const) : ("pending" as const),
      expiresAt: row.expiresAt,
      approvedBy: null,
    };
  },
});
