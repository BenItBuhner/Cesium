import { z } from "zod";
import type {
  AgentConversationListResult,
  AgentConversationRecord,
  AgentConversationSnapshot,
  AgentConversationSnapshotHead,
  WorkspaceRecord,
} from "@cesium/core";
import {
  CESIUM_CAPABILITIES,
  CESIUM_PROTOCOL_VERSION,
  type CesiumAuthStatus,
  type CesiumServerMetadata,
  type CloudAgentSettingsPublic,
  type CloudAgentTaskRecord,
} from "./types.js";

export const WorkspaceRecordSchema = z
  .object({
    id: z.string().min(1),
    root: z.string(),
    name: z.string(),
    createdAt: z.number(),
    updatedAt: z.number(),
    lastOpenedAt: z.number(),
    kind: z.enum(["workspace", "standalone-chat"]).optional(),
  })
  .passthrough() as z.ZodType<WorkspaceRecord>;

export const WorkspacesResponseSchema = z.object({
  workspaces: z.array(WorkspaceRecordSchema),
  defaultWorkspaceId: z.string().nullable(),
  lastOpenedWorkspaceId: z.string().nullable().optional(),
  startupWorkspaceId: z.string().nullable().optional(),
  recentWorkspaceIds: z.array(z.string()),
  homeWorkspaceId: z.string().nullable(),
  repositoriesByWorkspaceId: z.record(z.string(), z.unknown()).optional(),
});

export const AgentConversationRecordSchema = z
  .object({
    schemaVersion: z.literal(1),
    id: z.string().min(1),
    workspaceId: z.string().min(1),
    title: z.string(),
    createdAt: z.number(),
    updatedAt: z.number(),
    lastEventSeq: z.number(),
    status: z.string(),
    config: z
      .object({
        backendId: z.string(),
        mode: z.string(),
        modelId: z.string(),
        modelName: z.string(),
      })
      .passthrough(),
    providerSessionId: z.string().nullable(),
    configOptions: z.array(z.unknown()),
    capabilities: z.record(z.string(), z.boolean()),
    pendingPermission: z.unknown().nullable(),
    pendingQuestion: z.unknown().nullable(),
    lastError: z.string().nullable(),
    experimental: z.boolean(),
    archivedAt: z.number().nullable(),
    lastReadSeq: z.number(),
    queuedPrompts: z.array(z.unknown()),
    origin: z.unknown().nullable().optional(),
  })
  .passthrough() as unknown as z.ZodType<AgentConversationRecord>;

export const AgentConversationListSchema = z
  .object({
    backends: z.array(z.unknown()),
    conversations: z.array(AgentConversationRecordSchema),
    nextCursor: z.string().nullable().optional(),
  })
  .passthrough() as unknown as z.ZodType<AgentConversationListResult>;

const AgentEventSchema = z
  .object({
    seq: z.number(),
    eventId: z.string(),
    conversationId: z.string(),
    createdAt: z.number(),
    kind: z.string(),
  })
  .passthrough();

export const AgentConversationSnapshotSchema = z
  .object({
    conversation: AgentConversationRecordSchema,
    events: z.array(AgentEventSchema),
  })
  .passthrough() as unknown as z.ZodType<AgentConversationSnapshot>;

export const AgentConversationSnapshotHeadSchema = z
  .object({
    conversation: AgentConversationRecordSchema,
    events: z.array(AgentEventSchema),
    window: z.object({
      oldestSeq: z.number(),
      newestSeq: z.number(),
      hasOlder: z.boolean(),
    }),
  })
  .passthrough() as unknown as z.ZodType<AgentConversationSnapshotHead>;

export const AgentConversationSnapshotResponseSchema = z.object({
  snapshot: z.union([AgentConversationSnapshotHeadSchema, AgentConversationSnapshotSchema]),
});

export const CesiumServerMetadataSchema = z.object({
  name: z.literal("cesium"),
  protocolVersion: z.literal(CESIUM_PROTOCOL_VERSION),
  capabilities: z.array(z.enum(CESIUM_CAPABILITIES)),
  transports: z.object({
    http: z.literal("/api"),
    websocket: z.literal("/ws"),
  }),
}) satisfies z.ZodType<CesiumServerMetadata>;

export const CesiumAuthStatusSchema = z.object({
  enabled: z.boolean(),
  authenticated: z.boolean(),
  session: z
    .object({
      username: z.string(),
      createdAt: z.number(),
      expiresAt: z.number(),
      lastSeenAt: z.number(),
      remember: z.boolean(),
    })
    .nullable(),
  rotationIntervalMs: z.number(),
}) satisfies z.ZodType<CesiumAuthStatus>;

const CloudAgentProviderIdSchema = z.enum(["linear", "github", "slack"]);
const CloudAgentExecutionModeSchema = z.enum(["isolated", "local"]);

export const CloudAgentTaskSchema = z
  .object({
    schemaVersion: z.literal(1),
    id: z.string().min(1),
    createdAt: z.number(),
    updatedAt: z.number(),
    title: z.string(),
    prompt: z.string(),
    status: z.enum([
      "inbox",
      "dispatching",
      "running",
      "awaiting_review",
      "completed",
      "failed",
      "cancelled",
    ]),
    source: z
      .object({
        providerId: z.union([CloudAgentProviderIdSchema, z.literal("manual")]),
        externalId: z.string().optional(),
        url: z.string().optional(),
        repo: z.string().optional(),
        teamKey: z.string().optional(),
        project: z.string().optional(),
        channel: z.string().optional(),
        labels: z.array(z.string()).optional(),
        sender: z.string().optional(),
      })
      .passthrough(),
    unverified: z.boolean().optional(),
    workspaceId: z.string().nullable(),
    runWorkspaceId: z.string().nullable().optional(),
    conversationId: z.string().nullable(),
    backendId: z.string().nullable(),
    modelId: z.string().nullable(),
    executionMode: CloudAgentExecutionModeSchema,
    branch: z.string().nullable().optional(),
    worktreePath: z.string().nullable().optional(),
    attachments: z
      .array(
        z.object({
          url: z.string(),
          name: z.string().optional(),
          mimeType: z.string().optional(),
        })
      )
      .optional(),
    timeline: z.array(
      z.object({
        at: z.number(),
        kind: z.enum([
          "received",
          "dispatched",
          "turn_completed",
          "steered",
          "update_posted",
          "status",
          "error",
        ]),
        message: z.string(),
      })
    ),
    lastError: z.string().nullable().optional(),
  })
  .passthrough() as z.ZodType<CloudAgentTaskRecord>;

export const CloudAgentSettingsSchema = z
  .object({
    schemaVersion: z.literal(1),
    updatedAt: z.number(),
    defaults: z.object({
      backendId: z.string(),
      modelId: z.string().nullable(),
      executionMode: CloudAgentExecutionModeSchema,
      autoDispatch: z.boolean(),
      workspaceId: z.string().nullable(),
    }),
    routingRules: z.array(
      z.object({
        id: z.string(),
        providerId: z.union([CloudAgentProviderIdSchema, z.literal("any")]),
        match: z.string(),
        workspaceId: z.string(),
        backendId: z.string().optional(),
        modelId: z.string().optional(),
        executionMode: CloudAgentExecutionModeSchema.optional(),
      })
    ),
    connections: z.array(
      z.object({
        providerId: CloudAgentProviderIdSchema,
        method: z.enum(["oauth", "token"]),
        configured: z.literal(true),
        tokenLastFour: z.string(),
        webhookSecretConfigured: z.boolean(),
        accountLabel: z.string().optional(),
        scopes: z.array(z.string()).optional(),
        connectedAt: z.number(),
        updatedAt: z.number(),
      })
    ),
    oauthApps: z.array(
      z.object({
        providerId: CloudAgentProviderIdSchema,
        clientId: z.string(),
        clientSecretConfigured: z.boolean(),
        updatedAt: z.number(),
      })
    ),
  })
  .passthrough() as z.ZodType<CloudAgentSettingsPublic>;

export const CloudAgentTasksResponseSchema = z.object({
  tasks: z.array(CloudAgentTaskSchema),
});
