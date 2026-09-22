CREATE TABLE "conversation_queue_entry_attachments" (
	"queue_entry_id" text,
	"attachment_id" text,
	"position" integer NOT NULL,
	CONSTRAINT "conversation_queue_entry_attachments_pkey" PRIMARY KEY("queue_entry_id","attachment_id")
);
--> statement-breakpoint
CREATE TABLE "conversation_queue_entries" (
	"id" text PRIMARY KEY,
	"conversation_id" text NOT NULL,
	"user_id" text NOT NULL,
	"content" text NOT NULL,
	"input" jsonb NOT NULL,
	"steer_message_id" text,
	"steer_generation_id" text,
	"last_error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "messages" ADD COLUMN "steered_into_message_id" text;--> statement-breakpoint
ALTER TABLE "messages" ADD COLUMN "steer_text_offset" integer;--> statement-breakpoint
ALTER TABLE "messages" ADD COLUMN "steer_turn_index" integer;--> statement-breakpoint
CREATE UNIQUE INDEX "queue_entry_attachments_attachment_id_idx" ON "conversation_queue_entry_attachments" ("attachment_id");--> statement-breakpoint
CREATE UNIQUE INDEX "queue_entry_attachments_entry_position_idx" ON "conversation_queue_entry_attachments" ("queue_entry_id","position");--> statement-breakpoint
CREATE INDEX "conversation_queue_entries_order_idx" ON "conversation_queue_entries" ("conversation_id","id");--> statement-breakpoint
CREATE INDEX "conversation_queue_entries_steer_idx" ON "conversation_queue_entries" ("steer_message_id","steer_generation_id") WHERE "steer_message_id" is not null;--> statement-breakpoint
CREATE INDEX "messages_steered_into_idx" ON "messages" ("steered_into_message_id");--> statement-breakpoint
ALTER TABLE "conversation_queue_entry_attachments" ADD CONSTRAINT "conversation_queue_entry_attachments_HJYTL5xcHtTf_fkey" FOREIGN KEY ("queue_entry_id") REFERENCES "conversation_queue_entries"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "conversation_queue_entry_attachments" ADD CONSTRAINT "conversation_queue_entry_attachments_mHIsfo2YtRZq_fkey" FOREIGN KEY ("attachment_id") REFERENCES "attachments"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "conversation_queue_entries" ADD CONSTRAINT "conversation_queue_entries_dLrW85OwvNOp_fkey" FOREIGN KEY ("conversation_id") REFERENCES "conversations"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "conversation_queue_entries" ADD CONSTRAINT "conversation_queue_entries_user_id_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "user"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "conversation_queue_entries" ADD CONSTRAINT "conversation_queue_entries_steer_message_id_messages_id_fkey" FOREIGN KEY ("steer_message_id") REFERENCES "messages"("id") ON DELETE SET NULL;--> statement-breakpoint
ALTER TABLE "messages" ADD CONSTRAINT "messages_steered_into_message_id_messages_id_fkey" FOREIGN KEY ("steered_into_message_id") REFERENCES "messages"("id") ON DELETE CASCADE;