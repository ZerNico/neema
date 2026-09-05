ALTER TABLE "message_compaction_events" ADD COLUMN "text_offset" integer;--> statement-breakpoint
ALTER TABLE "message_tool_calls" ADD COLUMN "text_offset" integer;--> statement-breakpoint
ALTER TABLE "messages" ADD COLUMN "question_response" jsonb;