-- Timed settle ("ignore for a day"): optional expiry for the settled flag.
-- When the timestamp passes, the conversation auto-unsettles on read.
ALTER TABLE "agent_conversations"
  ADD COLUMN IF NOT EXISTS "settled_until" bigint;
