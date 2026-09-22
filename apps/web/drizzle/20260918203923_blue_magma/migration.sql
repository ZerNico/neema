CREATE TABLE "schedule_runs" (
	"id" text PRIMARY KEY,
	"schedule_id" text NOT NULL,
	"conversation_id" text,
	"fired_at" timestamp with time zone DEFAULT now() NOT NULL,
	"status" text NOT NULL,
	"error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "schedules" (
	"id" text PRIMARY KEY,
	"user_id" text NOT NULL,
	"name" text NOT NULL,
	"prompt" text NOT NULL,
	"schedule_text" text NOT NULL,
	"cron" text NOT NULL,
	"timezone" text NOT NULL,
	"end_at" timestamp with time zone,
	"model_id" text,
	"agent_id" text,
	"search_enabled" boolean DEFAULT false NOT NULL,
	"research_enabled" boolean DEFAULT false NOT NULL,
	"collection_ids" jsonb DEFAULT '[]' NOT NULL,
	"skill_ids" jsonb DEFAULT '[]' NOT NULL,
	"paused" boolean DEFAULT false NOT NULL,
	"next_fire_at" timestamp with time zone,
	"last_fired_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "conversation_agent_drafts" RENAME TO "conversation_drafts";--> statement-breakpoint
ALTER TABLE "conversation_drafts" RENAME COLUMN "target_agent_id" TO "target_id";--> statement-breakpoint
ALTER INDEX "conversation_agent_drafts_conversation_idx" RENAME TO "conversation_drafts_conversation_idx";--> statement-breakpoint
ALTER TABLE "conversations" ADD COLUMN "schedule_id" text;--> statement-breakpoint
ALTER TABLE "conversation_drafts" ADD COLUMN "kind" text;--> statement-breakpoint
UPDATE "conversation_drafts" SET "kind" = 'agent';--> statement-breakpoint
ALTER TABLE "conversation_drafts" ALTER COLUMN "kind" SET NOT NULL;--> statement-breakpoint
CREATE INDEX "conversations_schedule_id_idx" ON "conversations" ("schedule_id");--> statement-breakpoint
CREATE INDEX "conversation_drafts_kind_idx" ON "conversation_drafts" ("kind");--> statement-breakpoint
CREATE INDEX "schedule_runs_schedule_idx" ON "schedule_runs" ("schedule_id","fired_at");--> statement-breakpoint
CREATE INDEX "schedules_user_idx" ON "schedules" ("user_id");--> statement-breakpoint
CREATE INDEX "schedules_due_idx" ON "schedules" ("next_fire_at") WHERE "next_fire_at" is not null;--> statement-breakpoint
ALTER TABLE "schedule_runs" ADD CONSTRAINT "schedule_runs_schedule_id_schedules_id_fkey" FOREIGN KEY ("schedule_id") REFERENCES "schedules"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "schedule_runs" ADD CONSTRAINT "schedule_runs_conversation_id_conversations_id_fkey" FOREIGN KEY ("conversation_id") REFERENCES "conversations"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "schedules" ADD CONSTRAINT "schedules_user_id_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "user"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "conversations" ADD CONSTRAINT "conversations_schedule_id_schedules_id_fkey" FOREIGN KEY ("schedule_id") REFERENCES "schedules"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "schedule_runs" ADD CONSTRAINT "schedule_runs_conversation_id_unique" UNIQUE ("conversation_id");