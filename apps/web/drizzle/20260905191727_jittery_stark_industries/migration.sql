CREATE TABLE "research_calls" (
	"id" text PRIMARY KEY,
	"run_id" text NOT NULL,
	"task_id" text,
	"ordinal" integer NOT NULL,
	"phase" text NOT NULL,
	"reserved_output_tokens" integer NOT NULL,
	"status" text DEFAULT 'running' NOT NULL,
	"usage" jsonb,
	"usage_complete" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "research_runs" (
	"id" text PRIMARY KEY,
	"user_id" text NOT NULL,
	"conversation_id" text NOT NULL,
	"message_id" text NOT NULL,
	"status" text DEFAULT 'queued' NOT NULL,
	"progress" jsonb NOT NULL,
	"owner" text,
	"lease_until" timestamp with time zone DEFAULT now() + interval '60 seconds' NOT NULL,
	"cancel_requested" boolean DEFAULT false NOT NULL,
	"deadline" timestamp with time zone DEFAULT now() + interval '10 minutes' NOT NULL,
	"model_id" text NOT NULL,
	"model_name" text NOT NULL,
	"pricing" jsonb,
	"snapshot" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"completed_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "research_tasks" (
	"id" text PRIMARY KEY,
	"run_id" text NOT NULL,
	"ordinal" integer NOT NULL,
	"title" text NOT NULL,
	"assignment" text NOT NULL,
	"status" text DEFAULT 'queued' NOT NULL,
	"report" text,
	"error" text
);
--> statement-breakpoint
ALTER TABLE "usage_events" ADD COLUMN "usage_complete" boolean DEFAULT true NOT NULL;--> statement-breakpoint
ALTER TABLE "message_compaction_events" ADD COLUMN "research_run_id" text;--> statement-breakpoint
ALTER TABLE "message_compaction_events" ADD COLUMN "research_task_id" text;--> statement-breakpoint
ALTER TABLE "message_tool_calls" ADD COLUMN "research_run_id" text;--> statement-breakpoint
ALTER TABLE "message_tool_calls" ADD COLUMN "research_task_id" text;--> statement-breakpoint
ALTER TABLE "messages" ADD COLUMN "generation_mode" text DEFAULT 'chat' NOT NULL;--> statement-breakpoint
ALTER TABLE "messages" ADD COLUMN "research_run_id" text;--> statement-breakpoint
CREATE UNIQUE INDEX "research_calls_run_ordinal_idx" ON "research_calls" ("run_id","ordinal");--> statement-breakpoint
CREATE UNIQUE INDEX "research_runs_active_user_idx" ON "research_runs" ("user_id") WHERE "status" in ('queued', 'running');--> statement-breakpoint
CREATE INDEX "research_runs_message_idx" ON "research_runs" ("message_id");--> statement-breakpoint
CREATE INDEX "research_runs_lease_idx" ON "research_runs" ("lease_until") WHERE "status" in ('queued', 'running');--> statement-breakpoint
CREATE UNIQUE INDEX "research_tasks_run_ordinal_idx" ON "research_tasks" ("run_id","ordinal");--> statement-breakpoint
ALTER TABLE "research_calls" ADD CONSTRAINT "research_calls_run_id_research_runs_id_fkey" FOREIGN KEY ("run_id") REFERENCES "research_runs"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "research_calls" ADD CONSTRAINT "research_calls_task_id_research_tasks_id_fkey" FOREIGN KEY ("task_id") REFERENCES "research_tasks"("id") ON DELETE SET NULL;--> statement-breakpoint
ALTER TABLE "research_runs" ADD CONSTRAINT "research_runs_user_id_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "user"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "research_runs" ADD CONSTRAINT "research_runs_conversation_id_conversations_id_fkey" FOREIGN KEY ("conversation_id") REFERENCES "conversations"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "research_runs" ADD CONSTRAINT "research_runs_message_id_messages_id_fkey" FOREIGN KEY ("message_id") REFERENCES "messages"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "research_tasks" ADD CONSTRAINT "research_tasks_run_id_research_runs_id_fkey" FOREIGN KEY ("run_id") REFERENCES "research_runs"("id") ON DELETE CASCADE;