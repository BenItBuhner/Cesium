-- Pending "conversation was moved" notice delivered as a system reminder on
-- the next Cesium turn. Nullable jsonb: { fromWorkspaceId, toWorkspaceId,
-- fromBranch, toBranch, movedAt, initiatedBy, ... }.
ALTER TABLE "agent_conversations"
  ADD COLUMN IF NOT EXISTS "pending_relocation" jsonb;
