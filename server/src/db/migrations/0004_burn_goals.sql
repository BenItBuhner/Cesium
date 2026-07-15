CREATE TABLE IF NOT EXISTS "burn_goals" (
  "goal_id" text PRIMARY KEY NOT NULL,
  "workspace_id" text NOT NULL REFERENCES "workspaces"("id") ON DELETE cascade,
  "conversation_id" text NOT NULL REFERENCES "agent_conversations"("id") ON DELETE cascade,
  "schema_version" smallint DEFAULT 1 NOT NULL,
  "objective" text NOT NULL,
  "status" text NOT NULL,
  "phase" text NOT NULL,
  "token_budget" bigint,
  "tokens_used" bigint DEFAULT 0 NOT NULL,
  "time_used_seconds" bigint DEFAULT 0 NOT NULL,
  "payload" jsonb NOT NULL,
  "created_at" bigint NOT NULL,
  "updated_at" bigint NOT NULL,
  "completed_at" bigint
);

CREATE UNIQUE INDEX IF NOT EXISTS "burn_goals_conversation_key"
ON "burn_goals" ("conversation_id");

CREATE INDEX IF NOT EXISTS "burn_goals_workspace_updated_idx"
ON "burn_goals" ("workspace_id", "updated_at");

CREATE INDEX IF NOT EXISTS "burn_goals_status_idx"
ON "burn_goals" ("status");
