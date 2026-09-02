import { v } from "convex/values";
import { mutation, query } from "./_generated/server";
import { ensureUser, getAuthedUser } from "./lib/identity";

const MAX_PAYLOAD_CHARS = 32_000;
/**
 * `codespace-engine-auth` holds the account-wide Codespace engine
 * credentials (Codespaces user secrets are account-global, so every pairing
 * shares one pair). Persisted as soon as setup generates them - before the
 * codespace exists - so a setup run that dies mid-provision leaves an
 * orphan whose engine password is still recoverable on retry.
 */
const ALLOWED_KINDS = new Set([
  "wrapping-key",
  "voice.settings",
  "codespace-engine-auth",
]);

/**
 * Harness auth sync: sealed (AES-256-GCM envelope) harness sign-in bundles,
 * one row per harness, e.g. `harness.auth.codex`. Payloads are ciphertext
 * sealed client-side with the account wrapping key - this deployment never
 * sees plaintext credential material. The larger cap covers JWT-heavy CLI
 * credential files after encryption + base64 expansion.
 */
const HARNESS_AUTH_KIND_PREFIX = "harness.auth.";
const HARNESS_AUTH_SYNC_IDS = new Set([
  "codex",
  "claude",
  "cursor",
  "opencode",
  "grok",
  "devin",
  "google-antigravity",
  "cesium-agent",
]);
const HARNESS_AUTH_MAX_PAYLOAD_CHARS = 200_000;

const secretRecord = v.object({
  kind: v.string(),
  payload: v.string(),
  updatedAt: v.number(),
});

function isHarnessAuthKind(kind: string): boolean {
  return (
    kind.startsWith(HARNESS_AUTH_KIND_PREFIX) &&
    HARNESS_AUTH_SYNC_IDS.has(kind.slice(HARNESS_AUTH_KIND_PREFIX.length))
  );
}

function assertKind(kind: string): string {
  const trimmed = kind.trim();
  if (!ALLOWED_KINDS.has(trimmed) && !isHarnessAuthKind(trimmed)) {
    throw new Error("Unknown secret kind.");
  }
  return trimmed;
}

function maxPayloadChars(kind: string): number {
  return isHarnessAuthKind(kind) ? HARNESS_AUTH_MAX_PAYLOAD_CHARS : MAX_PAYLOAD_CHARS;
}

export const list = query({
  args: { deviceKey: v.optional(v.string()) },
  returns: v.array(secretRecord),
  handler: async (ctx, args) => {
    const user = await getAuthedUser(ctx, args.deviceKey);
    if (!user) {
      return [];
    }
    const rows = await ctx.db
      .query("userSecrets")
      .withIndex("by_user_kind", (q) => q.eq("userId", user._id))
      .collect();
    return rows.map((row) => ({
      kind: row.kind,
      payload: row.payload,
      updatedAt: row.updatedAt,
    }));
  },
});

export const save = mutation({
  args: {
    deviceKey: v.optional(v.string()),
    kind: v.string(),
    payload: v.string(),
    updatedAt: v.optional(v.number()),
  },
  returns: v.object({ ok: v.literal(true), updatedAt: v.number() }),
  handler: async (ctx, args) => {
    const kind = assertKind(args.kind);
    if (args.payload.length > maxPayloadChars(kind)) {
      throw new Error("Secret payload too large.");
    }
    if (args.payload.length === 0) {
      throw new Error("Secret payload is empty.");
    }
    const userId = await ensureUser(ctx, args.deviceKey);
    const updatedAt =
      typeof args.updatedAt === "number" && Number.isFinite(args.updatedAt)
        ? args.updatedAt
        : Date.now();
    const existing = await ctx.db
      .query("userSecrets")
      .withIndex("by_user_kind", (q) => q.eq("userId", userId).eq("kind", kind))
      .unique();
    if (existing) {
      await ctx.db.patch(existing._id, { payload: args.payload, updatedAt });
    } else {
      await ctx.db.insert("userSecrets", {
        userId,
        kind,
        payload: args.payload,
        updatedAt,
      });
    }
    return { ok: true as const, updatedAt };
  },
});

export const remove = mutation({
  args: {
    deviceKey: v.optional(v.string()),
    kind: v.string(),
  },
  returns: v.object({ ok: v.literal(true) }),
  handler: async (ctx, args) => {
    const kind = assertKind(args.kind);
    const userId = await ensureUser(ctx, args.deviceKey);
    const existing = await ctx.db
      .query("userSecrets")
      .withIndex("by_user_kind", (q) => q.eq("userId", userId).eq("kind", kind))
      .unique();
    if (existing) {
      await ctx.db.delete(existing._id);
    }
    return { ok: true as const };
  },
});
