CREATE TABLE "conversation_compaction_checkpoints" (
	"id" text PRIMARY KEY,
	"conversation_id" text NOT NULL,
	"through_message_id" text NOT NULL,
	"model_id" text,
	"summary" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX "compaction_checkpoints_conversation_through_idx" ON "conversation_compaction_checkpoints" ("conversation_id","through_message_id");--> statement-breakpoint
CREATE INDEX "compaction_checkpoints_through_message_idx" ON "conversation_compaction_checkpoints" ("through_message_id");--> statement-breakpoint
CREATE INDEX "messages_conversation_order_idx" ON "messages" ("conversation_id","created_at","id");--> statement-breakpoint
ALTER TABLE "conversation_compaction_checkpoints" ADD CONSTRAINT "conversation_compaction_checkpoints_GnB3zijbhAAW_fkey" FOREIGN KEY ("conversation_id") REFERENCES "conversations"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "conversation_compaction_checkpoints" ADD CONSTRAINT "conversation_compaction_checkpoints_URbklZXXUfnc_fkey" FOREIGN KEY ("through_message_id") REFERENCES "messages"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "conversation_compaction_checkpoints" ADD CONSTRAINT "conversation_compaction_checkpoints_model_id_models_id_fkey" FOREIGN KEY ("model_id") REFERENCES "models"("id") ON DELETE SET NULL;