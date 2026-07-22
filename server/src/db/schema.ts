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
    queuedPrompts: jsonb("queued_prompts")
      .notNull()
      .default(sql`'[]'::jsonb`),
    origin: jsonb("origin"),
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

export const orchestrationBoards = pgTable(
  "orchestration_boards",
  {
    id: text("id").primaryKey(),
    workspaceId: text("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    schemaVersion: smallint("schema_version").notNull().default(1),
    title: text("title").notNull(),
    description: text("description").notNull().default(""),
    headConversationId: text("head_conversation_id").references(
      () => agentConversations.id,
      { onDelete: "set null" }
    ),
    createdAt: bigint("created_at", { mode: "number" }).notNull(),
    updatedAt: bigint("updated_at", { mode: "number" }).notNull(),
    archivedAt: bigint("archived_at", { mode: "number" }),
    settings: jsonb("settings").notNull(),
  },
  (table) => [
    index("orchestration_boards_workspace_updated_idx").on(
      table.workspaceId,
      table.updatedAt
    ),
  ]
);

export const orchestrationIssues = pgTable(
  "orchestration_issues",
  {
    id: text("id").primaryKey(),
    boardId: text("board_id")
      .notNull()
      .references(() => orchestrationBoards.id, { onDelete: "cascade" }),
    schemaVersion: smallint("schema_version").notNull().default(1),
    title: text("title").notNull(),
    description: text("description").notNull().default(""),
    columnId: text("column_id").notNull(),
    priority: text("priority").notNull(),
    sortOrder: bigint("sort_order", { mode: "number" }).notNull(),
    acceptanceCriteria: jsonb("acceptance_criteria")
      .$type<string[]>()
      .notNull()
      .default(sql`'[]'::jsonb`),
    dependencyIssueIds: jsonb("dependency_issue_ids")
      .$type<string[]>()
      .notNull()
      .default(sql`'[]'::jsonb`),
    blockedReason: text("blocked_reason"),
    verification: jsonb("verification").notNull(),
    createdAt: bigint("created_at", { mode: "number" }).notNull(),
    updatedAt: bigint("updated_at", { mode: "number" }).notNull(),
    completedAt: bigint("completed_at", { mode: "number" }),
  },
  (table) => [
    index("orchestration_issues_board_column_sort_idx").on(
      table.boardId,
      table.columnId,
      table.sortOrder
    ),
  ]
);

export const orchestrationAssignments = pgTable(
  "orchestration_assignments",
  {
    id: text("id").primaryKey(),
    boardId: text("board_id")
      .notNull()
      .references(() => orchestrationBoards.id, { onDelete: "cascade" }),
    issueId: text("issue_id")
      .notNull()
      .references(() => orchestrationIssues.id, { onDelete: "cascade" }),
    conversationId: text("conversation_id")
      .notNull()
      .references(() => agentConversations.id, { onDelete: "cascade" }),
    schemaVersion: smallint("schema_version").notNull().default(1),
    role: text("role").notNull(),
    status: text("status").notNull(),
    createdAt: bigint("created_at", { mode: "number" }).notNull(),
    updatedAt: bigint("updated_at", { mode: "number" }).notNull(),
    config: jsonb("config").notNull(),
    lastKnownConversationStatus: text("last_known_conversation_status"),
  },
  (table) => [
    index("orchestration_assignments_board_issue_idx").on(
      table.boardId,
      table.issueId
    ),
    index("orchestration_assignments_conversation_idx").on(table.conversationId),
  ]
);

export const orchestrationEvents = pgTable(
  "orchestration_events",
  {
    id: text("id").primaryKey(),
    boardId: text("board_id")
      .notNull()
      .references(() => orchestrationBoards.id, { onDelete: "cascade" }),
    issueId: text("issue_id"),
    assignmentId: text("assignment_id"),
    schemaVersion: smallint("schema_version").notNull().default(1),
    kind: text("kind").notNull(),
    actor: jsonb("actor").notNull(),
    message: text("message").notNull(),
    payload: jsonb("payload").notNull(),
    createdAt: bigint("created_at", { mode: "number" }).notNull(),
  },
  (table) => [
    index("orchestration_events_board_created_idx").on(
      table.boardId,
      table.createdAt
    ),
    index("orchestration_events_issue_idx").on(table.issueId),
  ]
);

export const goals = pgTable(
  "burn_goals",
  {
    goalId: text("goal_id").primaryKey(),
    workspaceId: text("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    conversationId: text("conversation_id")
      .notNull()
      .references(() => agentConversations.id, { onDelete: "cascade" }),
    schemaVersion: smallint("schema_version").notNull().default(1),
    objective: text("objective").notNull(),
    status: text("status").notNull(),
    phase: text("phase").notNull(),
    tokenBudget: bigint("token_budget", { mode: "number" }),
    tokensUsed: bigint("tokens_used", { mode: "number" }).notNull().default(0),
    timeUsedSeconds: bigint("time_used_seconds", { mode: "number" }).notNull().default(0),
    payload: jsonb("payload").notNull(),
    createdAt: bigint("created_at", { mode: "number" }).notNull(),
    updatedAt: bigint("updated_at", { mode: "number" }).notNull(),
    completedAt: bigint("completed_at", { mode: "number" }),
  },
  (table) => [
    unique("burn_goals_conversation_key").on(table.conversationId),
    index("burn_goals_workspace_updated_idx").on(table.workspaceId, table.updatedAt),
    index("burn_goals_status_idx").on(table.status),
  ]
);

export const extensionInstalls = pgTable(
  "extension_installs",
  {
    workspaceId: text("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    extensionId: text("extension_id").notNull(),
    enabled: boolean("enabled").notNull().default(true),
    publisher: text("publisher").notNull(),
    name: text("name").notNull(),
    version: text("version").notNull(),
    compatibility: text("compatibility").notNull(),
    payload: jsonb("payload").notNull(),
    createdAt: bigint("created_at", { mode: "number" }).notNull(),
    updatedAt: bigint("updated_at", { mode: "number" }).notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.workspaceId, table.extensionId] }),
    index("extension_installs_workspace_updated_idx").on(
      table.workspaceId,
      table.updatedAt
    ),
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
