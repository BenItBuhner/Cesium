import { defineSchema, defineTable } from "convex/server";
import { v } from "convex/values";

/**
 * Cesium Cloud Context - user-scoped, cross-device state.
 *
 * Everything a signed-in user needs to sit down at any Cesium client and be
 * productive immediately: their engines (servers), the account settings
 * document, onboarding progress, and portable conversation snapshots.
 * Engines themselves stay self-hosted; only context lives here.
 */
export default defineSchema({
  /**
   * One row per identity. `key` is stable across devices:
   * - `clerk:<subject>` for Clerk-authenticated users (production).
   * - `device:<uuid>` for gated device-key mode (local dev / keyless demos).
   */
  users: defineTable({
    key: v.string(),
    name: v.optional(v.string()),
    email: v.optional(v.string()),
    imageUrl: v.optional(v.string()),
    createdAt: v.number(),
    lastSeenAt: v.number(),
  }).index("by_key", ["key"]),

  /** A user's connected Cesium engines (Bun/Hono servers). */
  servers: defineTable({
    userId: v.id("users"),
    name: v.string(),
    baseUrl: v.string(),
    kind: v.union(
      v.literal("remote"),
      v.literal("local"),
      /** Engine running inside a paired GitHub Codespace. */
      v.literal("codespace")
    ),
    /**
     * Engine session token from password auth, when the engine requires it.
     * Lets a fresh device reconnect without re-entering credentials.
     * TODO(production hardening): replace with per-device scoped tokens.
     */
    sessionToken: v.optional(v.string()),
    /**
     * Rendezvous locator for tunnel-backed engines shared via public access.
     * `baseUrl` is only the last known endpoint for these - tunnel URLs
     * rotate - so every signed-in device uses this locator to re-resolve the
     * engine's current public URL from the encrypted rendezvous registry.
     */
    rendezvous: v.optional(
      v.object({
        version: v.number(),
        serverId: v.string(),
        secret: v.string(),
        registryBaseUrl: v.string(),
      })
    ),
    /**
     * Durable GitHub Codespace pairing: exactly one row per (user, repo).
     * The codespace itself is disposable - if GitHub deletes it (retention
     * expiry) this metadata drives one-click recreation, and `codespaceName`
     * / `baseUrl` simply move to the replacement. Engine credentials are
     * mirrored here (same trust model as `sessionToken`) so any signed-in
     * device can re-login after a session expires.
     */
    codespace: v.optional(
      v.object({
        repoFullName: v.string(),
        repositoryId: v.number(),
        codespaceName: v.string(),
        displayName: v.optional(v.string()),
        machine: v.optional(v.string()),
        devcontainerPath: v.string(),
        lastKnownState: v.optional(v.string()),
        lastSyncedAt: v.optional(v.number()),
        engineUsername: v.optional(v.string()),
        enginePassword: v.optional(v.string()),
      })
    ),
    notes: v.optional(v.string()),
    lastConnectedAt: v.optional(v.number()),
    createdAt: v.number(),
    updatedAt: v.number(),
  })
    .index("by_user", ["userId"])
    .index("by_user_url", ["userId", "baseUrl"]),

  /**
   * Account-to-account server sharing: one row per grant of one server to one
   * recipient. The owner keeps full control (pause, expiry, revoke); the
   * recipient sees the share in their bootstrap - as a pending invite until
   * they accept, then as a connectable server. Invites are addressable two
   * ways: by the recipient's account email (auto-matched at bootstrap) and by
   * a capability `inviteCode` carried in an invite link.
   */
  serverShares: defineTable({
    serverId: v.id("servers"),
    ownerUserId: v.id("users"),
    /** Set once a signed-in user accepts (or claims the invite link). */
    granteeUserId: v.optional(v.id("users")),
    /** Normalized (lowercase) recipient email for email-addressed invites. */
    granteeEmail: v.optional(v.string()),
    /** URL-safe capability token embedded in the invite link. */
    inviteCode: v.string(),
    status: v.union(
      v.literal("pending"),
      v.literal("accepted"),
      /** Declined by the recipient, or left after accepting. */
      v.literal("declined"),
      v.literal("revoked")
    ),
    /** Owner-side temporary kill switch; the grant survives, access pauses. */
    paused: v.boolean(),
    /** Optional owner-set time limit (ms epoch); expired shares stop resolving. */
    expiresAt: v.optional(v.number()),
    createdAt: v.number(),
    updatedAt: v.number(),
    respondedAt: v.optional(v.number()),
  })
    .index("by_server", ["serverId"])
    .index("by_owner", ["ownerUserId"])
    .index("by_grantee", ["granteeUserId"])
    .index("by_email", ["granteeEmail"])
    .index("by_code", ["inviteCode"]),

  /**
   * Encrypted or wrapping-key material for account-scoped credentials.
   * Payloads are sealed client-side (AES-256-GCM envelopes) before upload.
   */
  userSecrets: defineTable({
    userId: v.id("users"),
    kind: v.string(),
    payload: v.string(),
    updatedAt: v.number(),
  }).index("by_user_kind", ["userId", "kind"]),

  /**
   * The account settings document (`{ version: 2, settings }` JSON): every
   * client-side preference that follows the user - theme, rail layout,
   * keyboard shortcuts, feature flags, and the composer defaults (last-used
   * harness / mode / model per harness). Engine-scoped state (model toggles
   * merged against a live catalog, remembered permissions keyed by workspace)
   * stays on each engine. `updatedAt` is the conflict-resolution clock.
   */
  preferences: defineTable({
    userId: v.id("users"),
    payload: v.string(),
    updatedAt: v.number(),
  }).index("by_user", ["userId"]),

  /** Setup-flow progress, so onboarding resumes on any device. */
  onboarding: defineTable({
    userId: v.id("users"),
    platform: v.string(),
    completedSteps: v.array(v.string()),
    completedAt: v.optional(v.number()),
    updatedAt: v.number(),
  }).index("by_user", ["userId"]),

  /**
   * Portable conversation snapshots (record + events as JSON), pushable from
   * any engine and materializable on any other via the import chassis.
   */
  conversationSnapshots: defineTable({
    userId: v.id("users"),
    /** Stable cross-device identity: `<engine conversation id>`. */
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
    createdAt: v.number(),
    updatedAt: v.number(),
  })
    .index("by_user", ["userId"])
    .index("by_user_key", ["userId", "snapshotKey"]),

  /**
   * Per-engine conversation catalogs: the rail summaries (`/api/agents/
   * conversations/all` groups, trimmed) a client last fetched from one of the
   * user's engines. Engines that sleep - GitHub Codespaces idle out within
   * hours - are unreachable most of the time, so without this every device
   * saw their conversations vanish. Any signed-in client refreshes the row
   * whenever it fetches the live list; every other client reads it back
   * when the engine is asleep and wakes the engine on open.
   *
   * `serverKey` is the durable engine identity: `codespace:<owner/repo>` for
   * codespace pairings (their base URL moves on recreate), otherwise the
   * normalized base URL.
   */
  conversationCatalogs: defineTable({
    userId: v.id("users"),
    serverKey: v.string(),
    serverName: v.string(),
    baseUrl: v.string(),
    /** JSON `{ version, groups }` - rail groups with summaries only. */
    payload: v.string(),
    conversationCount: v.number(),
    /** Newest `updatedAt` among the catalogued conversations. */
    sourceUpdatedAt: v.number(),
    updatedAt: v.number(),
  })
    .index("by_user", ["userId"])
    .index("by_user_server", ["userId", "serverKey"]),
});
