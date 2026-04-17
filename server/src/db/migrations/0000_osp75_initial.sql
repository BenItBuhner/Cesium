CREATE TABLE "agent_conversations" (
	"id" text PRIMARY KEY NOT NULL,
	"workspace_id" text NOT NULL,
	"schema_version" smallint DEFAULT 1 NOT NULL,
	"title" text NOT NULL,
	"status" text NOT NULL,
	"created_at" bigint NOT NULL,
	"updated_at" bigint NOT NULL,
	"last_event_seq" bigint DEFAULT 0 NOT NULL,
	"last_read_seq" bigint DEFAULT 0 NOT NULL,
	"config" jsonb NOT NULL,
	"provider_session_id" text,
	"config_options" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"capabilities" jsonb NOT NULL,
	"pending_permission" jsonb,
	"last_error" text,
	"experimental" boolean DEFAULT false NOT NULL,
	"archived_at" bigint
);
--> statement-breakpoint
CREATE TABLE "agent_events" (
	"conversation_id" text NOT NULL,
	"seq" bigint NOT NULL,
	"event_id" text NOT NULL,
	"kind" text NOT NULL,
	"payload" jsonb NOT NULL,
	"created_at" bigint NOT NULL,
	CONSTRAINT "agent_events_conversation_id_seq_pk" PRIMARY KEY("conversation_id","seq")
);
--> statement-breakpoint
CREATE TABLE "auth_sessions" (
	"id" text PRIMARY KEY NOT NULL,
	"username" text NOT NULL,
	"created_at" bigint NOT NULL,
	"last_seen_at" bigint NOT NULL,
	"last_rotated_at" bigint NOT NULL,
	"expires_at" bigint NOT NULL,
	"remember" boolean DEFAULT false NOT NULL
);
--> statement-breakpoint
CREATE TABLE "auth_state" (
	"id" smallint PRIMARY KEY DEFAULT 1 NOT NULL,
	"schema_version" smallint DEFAULT 1 NOT NULL,
	"secret" text NOT NULL,
	"created_at" bigint NOT NULL,
	"updated_at" bigint NOT NULL
);
--> statement-breakpoint
CREATE TABLE "fs_attachments" (
	"id" text PRIMARY KEY NOT NULL,
	"workspace_id" text NOT NULL,
	"relative_path" text NOT NULL,
	"mime" text,
	"size_bytes" bigint,
	"sha256" text,
	"created_at" bigint NOT NULL
);
--> statement-breakpoint
CREATE TABLE "global_settings" (
	"id" smallint PRIMARY KEY DEFAULT 1 NOT NULL,
	"payload" jsonb NOT NULL,
	"revision" bigint DEFAULT 0 NOT NULL,
	"updated_at" bigint NOT NULL
);
--> statement-breakpoint
CREATE TABLE "provider_cache" (
	"backend_id" text PRIMARY KEY NOT NULL,
	"schema_version" smallint DEFAULT 1 NOT NULL,
	"payload" jsonb NOT NULL,
	"fetched_at" bigint NOT NULL
);
--> statement-breakpoint
CREATE TABLE "workspace_profile" (
	"id" smallint PRIMARY KEY DEFAULT 1 NOT NULL,
	"default_workspace_id" text,
	"last_opened_workspace_id" text,
	"recent_workspace_ids" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"updated_at" bigint NOT NULL
);
--> statement-breakpoint
CREATE TABLE "workspace_sessions" (
	"workspace_id" text NOT NULL,
	"window_id" text DEFAULT '' NOT NULL,
	"payload" jsonb NOT NULL,
	"revision" bigint DEFAULT 0 NOT NULL,
	"updated_at" bigint NOT NULL,
	CONSTRAINT "workspace_sessions_workspace_id_window_id_pk" PRIMARY KEY("workspace_id","window_id")
);
--> statement-breakpoint
CREATE TABLE "workspace_windows" (
	"id" text PRIMARY KEY NOT NULL,
	"workspace_id" text NOT NULL,
	"label" text NOT NULL,
	"created_at" bigint NOT NULL,
	"updated_at" bigint NOT NULL,
	"last_opened_at" bigint NOT NULL,
	"last_focused_at" bigint,
	"closed_at" bigint
);
--> statement-breakpoint
CREATE TABLE "workspaces" (
	"id" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"root" text NOT NULL,
	"created_at" bigint NOT NULL,
	"updated_at" bigint NOT NULL,
	"last_opened_at" bigint NOT NULL,
	CONSTRAINT "workspaces_root_key" UNIQUE("root")
);
--> statement-breakpoint
ALTER TABLE "agent_conversations" ADD CONSTRAINT "agent_conversations_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_events" ADD CONSTRAINT "agent_events_conversation_id_agent_conversations_id_fk" FOREIGN KEY ("conversation_id") REFERENCES "public"."agent_conversations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "fs_attachments" ADD CONSTRAINT "fs_attachments_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workspace_windows" ADD CONSTRAINT "workspace_windows_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "agent_conversations_workspace_updated_idx" ON "agent_conversations" USING btree ("workspace_id","updated_at");--> statement-breakpoint
CREATE INDEX "agent_conversations_updated_idx" ON "agent_conversations" USING btree ("updated_at");--> statement-breakpoint
CREATE INDEX "agent_events_kind_idx" ON "agent_events" USING btree ("conversation_id","kind");--> statement-breakpoint
CREATE INDEX "auth_sessions_expires_idx" ON "auth_sessions" USING btree ("expires_at");--> statement-breakpoint
CREATE INDEX "fs_attachments_workspace_idx" ON "fs_attachments" USING btree ("workspace_id");--> statement-breakpoint
CREATE INDEX "workspace_windows_workspace_idx" ON "workspace_windows" USING btree ("workspace_id");