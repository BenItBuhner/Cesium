CREATE INDEX IF NOT EXISTS "agent_conversations_workspace_archived_updated_id_idx"
ON "agent_conversations" ("workspace_id", "archived_at", "updated_at", "id");
