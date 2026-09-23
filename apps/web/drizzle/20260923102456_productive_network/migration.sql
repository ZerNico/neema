ALTER TABLE "schedules" ADD COLUMN "chat_mode" text DEFAULT 'new' NOT NULL;--> statement-breakpoint
ALTER TABLE "schedules" ADD COLUMN "chat_id" text;--> statement-breakpoint
CREATE INDEX "schedules_chat_idx" ON "schedules" ("chat_id");--> statement-breakpoint
ALTER TABLE "schedules" ADD CONSTRAINT "schedules_chat_id_conversations_id_fkey" FOREIGN KEY ("chat_id") REFERENCES "conversations"("id") ON DELETE SET NULL;--> statement-breakpoint
-- Deleting a schedule keeps the chats it created: they are ordinary sidebar
-- chats now. This FK lives only in migrations (see conversations.scheduleId).
ALTER TABLE "conversations" DROP CONSTRAINT "conversations_schedule_id_schedules_id_fkey";--> statement-breakpoint
ALTER TABLE "conversations" ADD CONSTRAINT "conversations_schedule_id_schedules_id_fkey" FOREIGN KEY ("schedule_id") REFERENCES "schedules"("id") ON DELETE SET NULL;
