CREATE TABLE "message_compaction_events" (
	"id" text PRIMARY KEY,
	"message_id" text NOT NULL,
	"checkpoint_id" text,
	"before_turn_index" integer NOT NULL,
	"pass_index" integer NOT NULL,
	"scope" text NOT NULL,
	"status" text NOT NULL,
	"outcome" text,
	"summary" text,
	"error" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"completed_at" timestamp with time zone
);
--> statement-breakpoint
CREATE UNIQUE INDEX "message_compaction_events_position_idx" ON "message_compaction_events" ("message_id","before_turn_index","pass_index");--> statement-breakpoint
CREATE INDEX "message_compaction_events_message_id_idx" ON "message_compaction_events" ("message_id");--> statement-breakpoint
CREATE INDEX "message_compaction_events_checkpoint_id_idx" ON "message_compaction_events" ("checkpoint_id");--> statement-breakpoint
ALTER TABLE "message_compaction_events" ADD CONSTRAINT "message_compaction_events_message_id_messages_id_fkey" FOREIGN KEY ("message_id") REFERENCES "messages"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "message_compaction_events" ADD CONSTRAINT "message_compaction_events_FEgF4QL2Idr4_fkey" FOREIGN KEY ("checkpoint_id") REFERENCES "conversation_compaction_checkpoints"("id") ON DELETE SET NULL;