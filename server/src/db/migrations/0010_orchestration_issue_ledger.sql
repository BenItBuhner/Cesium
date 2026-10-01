-- Work ledger: todos, Goal items and orchestration issues are one list per
-- conversation board. Each issue carries its ledger key, kind, parent
-- milestone and evidence; issues created before the ledger keep NULL until
-- the ledger imports them.
ALTER TABLE "orchestration_issues"
  ADD COLUMN IF NOT EXISTS "ledger" jsonb;
