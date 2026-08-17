-- User-facing "settled" flag: settled conversations sink to the bottom of the
-- agent rail. Cleared automatically when the user sends a new prompt.
ALTER TABLE "agent_conversations"
  ADD COLUMN IF NOT EXISTS "settled_at" bigint;
