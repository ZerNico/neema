CREATE TABLE "project_memories" (
	"id" text PRIMARY KEY,
	"project_id" text NOT NULL,
	"content" text NOT NULL,
	"content_hash" text NOT NULL,
	"origin" text NOT NULL,
	"created_by_user_id" text,
	"source_conversation_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "project_group_grants" (
	"project_id" text,
	"group_id" text,
	"role" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "project_group_grants_pkey" PRIMARY KEY("project_id","group_id")
);
--> statement-breakpoint
CREATE TABLE "project_members" (
	"project_id" text,
	"user_id" text,
	"role" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "project_members_pkey" PRIMARY KEY("project_id","user_id")
);
--> statement-breakpoint
CREATE TABLE "projects" (
	"id" text PRIMARY KEY,
	"user_id" text NOT NULL,
	"name" text NOT NULL,
	"description" text DEFAULT '' NOT NULL,
	"instructions" text DEFAULT '' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "message_generation_config" ADD COLUMN "resolved_project" jsonb;--> statement-breakpoint
ALTER TABLE "conversations" ADD COLUMN "project_id" text;--> statement-breakpoint
ALTER TABLE "documents" ADD COLUMN "project_id" text;--> statement-breakpoint
ALTER TABLE "group_members" ADD COLUMN "share_projects" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "documents" ALTER COLUMN "conversation_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "default_capabilities" ALTER COLUMN "capabilities" SET DEFAULT '{"agentsUse":true,"agentsCreate":true,"knowledgeUse":true,"knowledgeCreate":true,"skillsUse":true,"skillsCreate":true,"projectsUse":true,"projectsCreate":true,"schedules":true,"webSearch":true,"deepResearch":true,"memory":true,"documents":true,"customTools":true,"work":true,"attachments":true}';--> statement-breakpoint
ALTER TABLE "groups" ALTER COLUMN "capabilities" SET DEFAULT '{"agentsUse":true,"agentsCreate":true,"knowledgeUse":true,"knowledgeCreate":true,"skillsUse":true,"skillsCreate":true,"projectsUse":true,"projectsCreate":true,"schedules":true,"webSearch":true,"deepResearch":true,"memory":true,"documents":true,"customTools":true,"work":true,"attachments":true}';--> statement-breakpoint
CREATE INDEX "conversations_project_id_idx" ON "conversations" ("project_id");--> statement-breakpoint
CREATE INDEX "documents_project_idx" ON "documents" ("project_id");--> statement-breakpoint
CREATE UNIQUE INDEX "project_memories_project_content_hash_idx" ON "project_memories" ("project_id","content_hash");--> statement-breakpoint
CREATE INDEX "project_memories_source_conversation_id_idx" ON "project_memories" ("source_conversation_id");--> statement-breakpoint
CREATE INDEX "project_group_grants_group_id_idx" ON "project_group_grants" ("group_id");--> statement-breakpoint
CREATE INDEX "project_members_user_id_idx" ON "project_members" ("user_id");--> statement-breakpoint
CREATE INDEX "projects_user_id_idx" ON "projects" ("user_id");--> statement-breakpoint
ALTER TABLE "conversations" ADD CONSTRAINT "conversations_project_id_projects_id_fkey" FOREIGN KEY ("project_id") REFERENCES "projects"("id") ON DELETE SET NULL;--> statement-breakpoint
ALTER TABLE "documents" ADD CONSTRAINT "documents_project_id_projects_id_fkey" FOREIGN KEY ("project_id") REFERENCES "projects"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "project_memories" ADD CONSTRAINT "project_memories_project_id_projects_id_fkey" FOREIGN KEY ("project_id") REFERENCES "projects"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "project_memories" ADD CONSTRAINT "project_memories_created_by_user_id_user_id_fkey" FOREIGN KEY ("created_by_user_id") REFERENCES "user"("id") ON DELETE SET NULL;--> statement-breakpoint
ALTER TABLE "project_memories" ADD CONSTRAINT "project_memories_source_conversation_id_conversations_id_fkey" FOREIGN KEY ("source_conversation_id") REFERENCES "conversations"("id") ON DELETE SET NULL;--> statement-breakpoint
ALTER TABLE "project_group_grants" ADD CONSTRAINT "project_group_grants_project_id_projects_id_fkey" FOREIGN KEY ("project_id") REFERENCES "projects"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "project_group_grants" ADD CONSTRAINT "project_group_grants_group_id_groups_id_fkey" FOREIGN KEY ("group_id") REFERENCES "groups"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "project_members" ADD CONSTRAINT "project_members_project_id_projects_id_fkey" FOREIGN KEY ("project_id") REFERENCES "projects"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "project_members" ADD CONSTRAINT "project_members_user_id_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "user"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "projects" ADD CONSTRAINT "projects_user_id_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "user"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "conversations" ADD CONSTRAINT "conversations_project_not_temporary" CHECK (not ("temporary" and "project_id" is not null));--> statement-breakpoint
ALTER TABLE "documents" ADD CONSTRAINT "documents_one_owner" CHECK (("conversation_id" is null) <> ("project_id" is null));--> statement-breakpoint
ALTER TABLE "documents" ADD CONSTRAINT "documents_answer_in_conversation" CHECK ("created_by_message_id" is null or "conversation_id" is not null);--> statement-breakpoint
-- Existing policies gain the new keys as allowed, like every feature was when it arrived.
UPDATE "groups" SET "capabilities" = "capabilities" || '{"projectsUse":true,"projectsCreate":true}'::jsonb WHERE NOT ("capabilities" ? 'projectsUse');--> statement-breakpoint
UPDATE "default_capabilities" SET "capabilities" = "capabilities" || '{"projectsUse":true,"projectsCreate":true}'::jsonb WHERE NOT ("capabilities" ? 'projectsUse');
