CREATE TABLE "agent_skills" (
	"agent_id" text,
	"skill_id" text,
	"position" integer NOT NULL,
	CONSTRAINT "agent_skills_pkey" PRIMARY KEY("agent_id","skill_id")
);
--> statement-breakpoint
CREATE TABLE "message_skills" (
	"message_id" text,
	"skill_id" text,
	"revision_id" text NOT NULL,
	"explicit" boolean NOT NULL,
	"position" integer NOT NULL,
	CONSTRAINT "message_skills_pkey" PRIMARY KEY("message_id","skill_id")
);
--> statement-breakpoint
CREATE TABLE "skill_files" (
	"revision_id" text,
	"path" text,
	"blob_id" text NOT NULL,
	"byte_size" integer NOT NULL,
	"sha256" text NOT NULL,
	CONSTRAINT "skill_files_pkey" PRIMARY KEY("revision_id","path")
);
--> statement-breakpoint
CREATE TABLE "skill_group_grants" (
	"skill_id" text,
	"group_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "skill_group_grants_pkey" PRIMARY KEY("skill_id","group_id")
);
--> statement-breakpoint
CREATE TABLE "skill_revisions" (
	"id" text PRIMARY KEY,
	"skill_id" text NOT NULL,
	"revision" integer NOT NULL,
	"name" text NOT NULL,
	"description" text NOT NULL,
	"manual_only" boolean NOT NULL,
	"content_hash" text NOT NULL,
	"findings" jsonb DEFAULT '[]' NOT NULL,
	"source" jsonb,
	"baseline_revision_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "skill_user_grants" (
	"skill_id" text,
	"user_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "skill_user_grants_pkey" PRIMARY KEY("skill_id","user_id")
);
--> statement-breakpoint
CREATE TABLE "skills" (
	"id" text PRIMARY KEY,
	"user_id" text NOT NULL,
	"name" text NOT NULL,
	"description" text NOT NULL,
	"manual_only" boolean DEFAULT false NOT NULL,
	"audience" text DEFAULT 'private' NOT NULL,
	"revision" integer DEFAULT 1 NOT NULL,
	"deleted_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX "message_skills_revision_idx" ON "message_skills" ("revision_id");--> statement-breakpoint
CREATE INDEX "skill_files_blob_idx" ON "skill_files" ("blob_id");--> statement-breakpoint
CREATE INDEX "skill_group_grants_group_idx" ON "skill_group_grants" ("group_id");--> statement-breakpoint
CREATE UNIQUE INDEX "skill_revisions_number_idx" ON "skill_revisions" ("skill_id","revision");--> statement-breakpoint
CREATE INDEX "skill_user_grants_user_idx" ON "skill_user_grants" ("user_id");--> statement-breakpoint
CREATE INDEX "skills_user_idx" ON "skills" ("user_id");--> statement-breakpoint
ALTER TABLE "agent_skills" ADD CONSTRAINT "agent_skills_agent_id_agents_id_fkey" FOREIGN KEY ("agent_id") REFERENCES "agents"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "message_skills" ADD CONSTRAINT "message_skills_message_id_messages_id_fkey" FOREIGN KEY ("message_id") REFERENCES "messages"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "message_skills" ADD CONSTRAINT "message_skills_revision_id_skill_revisions_id_fkey" FOREIGN KEY ("revision_id") REFERENCES "skill_revisions"("id") ON DELETE RESTRICT;--> statement-breakpoint
ALTER TABLE "skill_files" ADD CONSTRAINT "skill_files_revision_id_skill_revisions_id_fkey" FOREIGN KEY ("revision_id") REFERENCES "skill_revisions"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "skill_files" ADD CONSTRAINT "skill_files_blob_id_attachment_blobs_id_fkey" FOREIGN KEY ("blob_id") REFERENCES "attachment_blobs"("id") ON DELETE RESTRICT;--> statement-breakpoint
ALTER TABLE "skill_group_grants" ADD CONSTRAINT "skill_group_grants_skill_id_skills_id_fkey" FOREIGN KEY ("skill_id") REFERENCES "skills"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "skill_group_grants" ADD CONSTRAINT "skill_group_grants_group_id_groups_id_fkey" FOREIGN KEY ("group_id") REFERENCES "groups"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "skill_revisions" ADD CONSTRAINT "skill_revisions_skill_id_skills_id_fkey" FOREIGN KEY ("skill_id") REFERENCES "skills"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "skill_user_grants" ADD CONSTRAINT "skill_user_grants_skill_id_skills_id_fkey" FOREIGN KEY ("skill_id") REFERENCES "skills"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "skill_user_grants" ADD CONSTRAINT "skill_user_grants_user_id_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "user"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "skills" ADD CONSTRAINT "skills_user_id_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "user"("id") ON DELETE CASCADE;