CREATE TABLE IF NOT EXISTS "extension_installs" (
  "workspace_id" text NOT NULL REFERENCES "workspaces"("id") ON DELETE cascade,
  "extension_id" text NOT NULL,
  "enabled" boolean NOT NULL DEFAULT true,
  "publisher" text NOT NULL,
  "name" text NOT NULL,
  "version" text NOT NULL,
  "compatibility" text NOT NULL,
  "payload" jsonb NOT NULL,
  "created_at" bigint NOT NULL,
  "updated_at" bigint NOT NULL,
  CONSTRAINT "extension_installs_workspace_id_extension_id_pk" PRIMARY KEY("workspace_id", "extension_id")
);

CREATE INDEX IF NOT EXISTS "extension_installs_workspace_updated_idx"
  ON "extension_installs" ("workspace_id", "updated_at");
