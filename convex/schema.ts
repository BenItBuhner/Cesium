import { defineSchema, defineTable } from "convex/server";
import { v } from "convex/values";

/**
 * Cesium Cloud Context - user-scoped, cross-device state.
 *
 * Everything a signed-in user needs to sit down at any Cesium client and be
 * productive immediately: their engines (servers), personalization payload,
 * agent backend preferences, onboarding progress, and portable conversation
 * snapshots. Engines themselves stay self-hosted; only context lives here.
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
   * Encrypted or wrapping-key material for account-scoped credentials.
   * Payloads are sealed client-side (AES-256-GCM envelopes) before upload.
   */
  userSecrets: defineTable({
    userId: v.id("users"),
    kind: v.string(),
    payload: v.string(),
    updatedAt: v.number(),
  }).index("by_user_kind", ["userId", "kind"]),

  /** Personalization: the client `UserPreferences` payload as portable JSON. */
  preferences: defineTable({
    userId: v.id("users"),
    payload: v.string(),
    updatedAt: v.number(),
  }).index("by_user", ["userId"]),

  /** Per-backend agent setup the user completed (not secrets - presence/prefs). */
  agentPrefs: defineTable({
    userId: v.id("users"),
    backendId: v.string(),
    enabled: v.boolean(),
    defaultModelId: v.optional(v.string()),
    defaultModelName: v.optional(v.string()),
    configuredAt: v.number(),
  })
    .index("by_user", ["userId"])
    .index("by_user_backend", ["userId", "backendId"]),

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
});
