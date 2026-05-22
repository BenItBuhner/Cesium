CREATE TABLE IF NOT EXISTS "orchestration_boards" (
  "id" text PRIMARY KEY NOT NULL,
  "workspace_id" text NOT NULL REFERENCES "workspaces"("id") ON DELETE cascade,
  "schema_version" smallint DEFAULT 1 NOT NULL,
  "title" text NOT NULL,
  "description" text DEFAULT '' NOT NULL,
  "head_conversation_id" text REFERENCES "agent_conversations"("id") ON DELETE set null,
  "created_at" bigint NOT NULL,
  "updated_at" bigint NOT NULL,
  "archived_at" bigint,
  "settings" jsonb NOT NULL
);

CREATE TABLE IF NOT EXISTS "orchestration_issues" (
  "id" text PRIMARY KEY NOT NULL,
  "board_id" text NOT NULL REFERENCES "orchestration_boards"("id") ON DELETE cascade,
  "schema_version" smallint DEFAULT 1 NOT NULL,
  "title" text NOT NULL,
  "description" text DEFAULT '' NOT NULL,
  "column_id" text NOT NULL,
  "priority" text NOT NULL,
  "sort_order" bigint NOT NULL,
  "acceptance_criteria" jsonb DEFAULT '[]'::jsonb NOT NULL,
  "dependency_issue_ids" jsonb DEFAULT '[]'::jsonb NOT NULL,
  "blocked_reason" text,
  "verification" jsonb NOT NULL,
  "created_at" bigint NOT NULL,
  "updated_at" bigint NOT NULL,
  "completed_at" bigint
);

CREATE TABLE IF NOT EXISTS "orchestration_assignments" (
  "id" text PRIMARY KEY NOT NULL,
  "board_id" text NOT NULL REFERENCES "orchestration_boards"("id") ON DELETE cascade,
  "issue_id" text NOT NULL REFERENCES "orchestration_issues"("id") ON DELETE cascade,
  "conversation_id" text NOT NULL REFERENCES "agent_conversations"("id") ON DELETE cascade,
  "schema_version" smallint DEFAULT 1 NOT NULL,
  "role" text NOT NULL,
  "status" text NOT NULL,
  "created_at" bigint NOT NULL,
  "updated_at" bigint NOT NULL,
  "config" jsonb NOT NULL,
  "last_known_conversation_status" text
);

CREATE TABLE IF NOT EXISTS "orchestration_events" (
  "id" text PRIMARY KEY NOT NULL,
  "board_id" text NOT NULL REFERENCES "orchestration_boards"("id") ON DELETE cascade,
  "issue_id" text,
  "assignment_id" text,
  "schema_version" smallint DEFAULT 1 NOT NULL,
  "kind" text NOT NULL,
  "actor" jsonb NOT NULL,
  "message" text NOT NULL,
  "payload" jsonb NOT NULL,
  "created_at" bigint NOT NULL
);

CREATE INDEX IF NOT EXISTS "orchestration_boards_workspace_updated_idx"
ON "orchestration_boards" ("workspace_id", "updated_at");

CREATE INDEX IF NOT EXISTS "orchestration_issues_board_column_sort_idx"
ON "orchestration_issues" ("board_id", "column_id", "sort_order");

CREATE INDEX IF NOT EXISTS "orchestration_assignments_board_issue_idx"
ON "orchestration_assignments" ("board_id", "issue_id");

CREATE INDEX IF NOT EXISTS "orchestration_assignments_conversation_idx"
ON "orchestration_assignments" ("conversation_id");

CREATE INDEX IF NOT EXISTS "orchestration_events_board_created_idx"
ON "orchestration_events" ("board_id", "created_at");

CREATE INDEX IF NOT EXISTS "orchestration_events_issue_idx"
ON "orchestration_events" ("issue_id");
