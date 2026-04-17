import { sql } from "drizzle-orm";
import {
  bigint,
  boolean,
  index,
  jsonb,
  pgTable,
  primaryKey,
  smallint,
  text,
  unique,
} from "drizzle-orm/pg-core";

/**
 * All bigint columns use mode:"number". The legacy JSON files already serialize
 * timestamps/seqs as plain numbers (`updatedAt: 1761234567890`), and every call
 * site reads them as `number`; switching to `bigint` JS objects here would force
 * a breaking refactor for zero benefit until someone actually needs seq > 2^53.
 */

export const workspaces = pgTable(
  "workspaces",
  {
    id: text("id").primaryKey(),
    name: text("name").notNull(),
    root: text("root").notNull(),
    createdAt: bigint("created_at", { mode: "number" }).notNull(),
    updatedAt: bigint("updated_at", { mode: "number" }).notNull(),
    lastOpenedAt: bigint("last_opened_at", { mode: "number" }).notNull(),
  },
  (table) => [unique("workspaces_root_key").on(table.root)]
);

export const workspaceWindows = pgTable(
  "workspace_windows",
  {
    id: text("id").primaryKey(),
    workspaceId: text("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    label: text("label").notNull(),
    createdAt: bigint("created_at", { mode: "number" }).notNull(),
    updatedAt: bigint("updated_at", { mode: "number" }).notNull(),
    lastOpenedAt: bigint("last_opened_at", { mode: "number" }).notNull(),
    lastFocusedAt: bigint("last_focused_at", { mode: "number" }),
    closedAt: bigint("closed_at", { mode: "number" }),
  },
  (table) => [
    index("workspace_windows_workspace_idx").on(table.workspaceId),
  ]
);

export const workspaceProfile = pgTable("workspace_profile", {
  id: smallint("id").primaryKey().default(1),
  defaultWorkspaceId: text("default_workspace_id"),
  lastOpenedWorkspaceId: text("last_opened_workspace_id"),
  recentWorkspaceIds: jsonb("recent_workspace_ids")
    .$type<string[]>()
    .notNull()
    .default(sql`'[]'::jsonb`),
  updatedAt: bigint("updated_at", { mode: "number" }).notNull(),
});

export const workspaceSessions = pgTable(
  "workspace_sessions",
  {
    workspaceId: text("workspace_id").notNull(),
    /**
     * Empty string sentinel for the workspace-level session (no window).
     * Storing NULL would defeat the composite primary key, so we normalize in
     * the driver layer rather than the DB layer.
     */
    windowId: text("window_id").notNull().default(""),
    payload: jsonb("payload").notNull(),
    revision: bigint("revision", { mode: "number" }).notNull().default(0),
    updatedAt: bigint("updated_at", { mode: "number" }).notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.workspaceId, table.windowId] }),
  ]
);

export const globalSettings = pgTable("global_settings", {
  id: smallint("id").primaryKey().default(1),
  payload: jsonb("payload").notNull(),
  revision: bigint("revision", { mode: "number" }).notNull().default(0),
  updatedAt: bigint("updated_at", { mode: "number" }).notNull(),
});

export const authState = pgTable("auth_state", {
  id: smallint("id").primaryKey().default(1),
  schemaVersion: smallint("schema_version").notNull().default(1),
  secret: text("secret").notNull(),
  createdAt: bigint("created_at", { mode: "number" }).notNull(),
  updatedAt: bigint("updated_at", { mode: "number" }).notNull(),
});

export const authSessions = pgTable(
  "auth_sessions",
  {
    id: text("id").primaryKey(),
    username: text("username").notNull(),
    createdAt: bigint("created_at", { mode: "number" }).notNull(),
    lastSeenAt: bigint("last_seen_at", { mode: "number" }).notNull(),
    lastRotatedAt: bigint("last_rotated_at", { mode: "number" }).notNull(),
    expiresAt: bigint("expires_at", { mode: "number" }).notNull(),
    remember: boolean("remember").notNull().default(false),
  },
  (table) => [index("auth_sessions_expires_idx").on(table.expiresAt)]
);

export const agentConversations = pgTable(
  "agent_conversations",
  {
    id: text("id").primaryKey(),
    workspaceId: text("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    schemaVersion: smallint("schema_version").notNull().default(1),
    title: text("title").notNull(),
    status: text("status").notNull(),
    createdAt: bigint("created_at", { mode: "number" }).notNull(),
    updatedAt: bigint("updated_at", { mode: "number" }).notNull(),
    lastEventSeq: bigint("last_event_seq", { mode: "number" })
      .notNull()
      .default(0),
    lastReadSeq: bigint("last_read_seq", { mode: "number" })
      .notNull()
      .default(0),
    config: jsonb("config").notNull(),
    providerSessionId: text("provider_session_id"),
    configOptions: jsonb("config_options")
      .$type<unknown[]>()
      .notNull()
      .default(sql`'[]'::jsonb`),
    capabilities: jsonb("capabilities").notNull(),
    pendingPermission: jsonb("pending_permission"),
    lastError: text("last_error"),
    experimental: boolean("experimental").notNull().default(false),
    archivedAt: bigint("archived_at", { mode: "number" }),
  },
  (table) => [
    index("agent_conversations_workspace_updated_idx").on(
      table.workspaceId,
      table.updatedAt
    ),
    index("agent_conversations_updated_idx").on(table.updatedAt),
  ]
);

export const agentEvents = pgTable(
  "agent_events",
  {
    conversationId: text("conversation_id")
      .notNull()
      .references(() => agentConversations.id, { onDelete: "cascade" }),
    seq: bigint("seq", { mode: "number" }).notNull(),
    eventId: text("event_id").notNull(),
    kind: text("kind").notNull(),
    payload: jsonb("payload").notNull(),
    createdAt: bigint("created_at", { mode: "number" }).notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.conversationId, table.seq] }),
    index("agent_events_kind_idx").on(table.conversationId, table.kind),
  ]
);

export const providerCache = pgTable("provider_cache", {
  backendId: text("backend_id").primaryKey(),
  schemaVersion: smallint("schema_version").notNull().default(1),
  payload: jsonb("payload").notNull(),
  fetchedAt: bigint("fetched_at", { mode: "number" }).notNull(),
});

export const fsAttachments = pgTable(
  "fs_attachments",
  {
    id: text("id").primaryKey(),
    workspaceId: text("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    relativePath: text("relative_path").notNull(),
    mime: text("mime"),
    sizeBytes: bigint("size_bytes", { mode: "number" }),
    sha256: text("sha256"),
    createdAt: bigint("created_at", { mode: "number" }).notNull(),
  },
  (table) => [index("fs_attachments_workspace_idx").on(table.workspaceId)]
);
