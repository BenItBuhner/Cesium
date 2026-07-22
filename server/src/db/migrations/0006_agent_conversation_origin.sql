-- Provenance for conversations triggered from external sources (Cloud Agents:
-- Linear / GitHub / Slack). Nullable jsonb: { kind, providerId, taskId, label, url }.
ALTER TABLE "agent_conversations"
  ADD COLUMN IF NOT EXISTS "origin" jsonb;
