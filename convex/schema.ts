import { defineSchema, defineTable } from "convex/server";
import { v } from "convex/values";

/**
 * Cesium Cloud Context — user-scoped, cross-device state.
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
    kind: v.union(v.literal("remote"), v.literal("local")),
    /**
     * Engine session token from password auth, when the engine requires it.
     * Lets a fresh device reconnect without re-entering credentials.
     * TODO(production hardening): replace with per-device scoped tokens.
     */
    sessionToken: v.optional(v.string()),
    /**
     * Rendezvous locator for tunnel-backed engines shared via public access.
     * `baseUrl` is only the last known endpoint for these — tunnel URLs
     * rotate — so every signed-in device uses this locator to re-resolve the
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
    notes: v.optional(v.string()),
    lastConnectedAt: v.optional(v.number()),
    createdAt: v.number(),
    updatedAt: v.number(),
  })
    .index("by_user", ["userId"])
    .index("by_user_url", ["userId", "baseUrl"]),

  /** Personalization: the client `UserPreferences` payload as portable JSON. */
  preferences: defineTable({
    userId: v.id("users"),
    payload: v.string(),
    updatedAt: v.number(),
  }).index("by_user", ["userId"]),

  /** Per-backend agent setup the user completed (not secrets — presence/prefs). */
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
