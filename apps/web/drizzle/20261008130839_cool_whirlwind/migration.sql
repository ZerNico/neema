ALTER TABLE "conversations" ADD COLUMN "unread" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "schedule_runs" ADD COLUMN "message_id" text;--> statement-breakpoint
ALTER TABLE "schedule_runs" ADD COLUMN "generation_id" text;--> statement-breakpoint
ALTER TABLE "schedule_runs" ADD COLUMN "settled_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "schedule_runs" ADD COLUMN "notify_message" text;--> statement-breakpoint
ALTER TABLE "schedules" ADD COLUMN "notify" text DEFAULT 'always' NOT NULL;--> statement-breakpoint
-- Runs from before notifications existed are over as far as anyone is told.
UPDATE "schedule_runs" SET "settled_at" = "fired_at";--> statement-breakpoint
CREATE INDEX "schedule_runs_unsettled_idx" ON "schedule_runs" ("fired_at") WHERE "settled_at" is null;--> statement-breakpoint
CREATE INDEX "schedule_runs_message_idx" ON "schedule_runs" ("message_id");--> statement-breakpoint
ALTER TABLE "schedule_runs" ADD CONSTRAINT "schedule_runs_message_id_messages_id_fkey" FOREIGN KEY ("message_id") REFERENCES "messages"("id") ON DELETE SET NULL;