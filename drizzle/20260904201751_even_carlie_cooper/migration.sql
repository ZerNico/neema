CREATE TABLE "memories" (
	"id" text PRIMARY KEY,
	"user_id" text NOT NULL,
	"content" text NOT NULL,
	"content_hash" text NOT NULL,
	"origin" text NOT NULL,
	"edited_at" timestamp with time zone,
	"source_conversation_id" text,
	"source_message_id" text,
	"source_message_hash" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "memory_settings" (
	"user_id" text PRIMARY KEY,
	"reference_enabled" boolean DEFAULT true NOT NULL,
	"auto_save_enabled" boolean DEFAULT false NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX "memories_user_content_hash_idx" ON "memories" ("user_id","content_hash");--> statement-breakpoint
CREATE INDEX "memories_user_managed_order_idx" ON "memories" ("user_id",(case when "origin" = 'manual' or "edited_at" is not null then 0 else 1 end),"updated_at" desc,"id" desc);--> statement-breakpoint
CREATE INDEX "memories_source_conversation_id_idx" ON "memories" ("source_conversation_id");--> statement-breakpoint
CREATE INDEX "memories_source_message_id_idx" ON "memories" ("source_message_id");--> statement-breakpoint
ALTER TABLE "memories" ADD CONSTRAINT "memories_user_id_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "user"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "memories" ADD CONSTRAINT "memories_source_conversation_id_conversations_id_fkey" FOREIGN KEY ("source_conversation_id") REFERENCES "conversations"("id") ON DELETE SET NULL;--> statement-breakpoint
ALTER TABLE "memories" ADD CONSTRAINT "memories_source_message_id_messages_id_fkey" FOREIGN KEY ("source_message_id") REFERENCES "messages"("id") ON DELETE SET NULL;--> statement-breakpoint
ALTER TABLE "memory_settings" ADD CONSTRAINT "memory_settings_user_id_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "user"("id") ON DELETE CASCADE;