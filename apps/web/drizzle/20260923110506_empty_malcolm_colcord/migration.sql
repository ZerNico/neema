ALTER TABLE "conversation_drafts" ADD COLUMN "created_by_message_id" text;--> statement-breakpoint
-- Existing drafts belong to the earliest answer in their own chat whose tool
-- row names them. One no remaining message names was left behind by a rewind.
UPDATE "conversation_drafts" AS d SET "created_by_message_id" = (
  SELECT min(m."id") FROM "message_tool_calls" AS tc
  JOIN "messages" AS m ON m."id" = tc."message_id"
  WHERE m."conversation_id" = d."conversation_id" AND tc."result"->>'draftId' = d."id"
);--> statement-breakpoint
DELETE FROM "conversation_drafts" WHERE "created_by_message_id" IS NULL;--> statement-breakpoint
ALTER TABLE "conversation_drafts" ALTER COLUMN "created_by_message_id" SET NOT NULL;--> statement-breakpoint
CREATE INDEX "conversation_drafts_created_by_message_idx" ON "conversation_drafts" ("created_by_message_id");--> statement-breakpoint
ALTER TABLE "conversation_drafts" ADD CONSTRAINT "conversation_drafts_created_by_message_id_messages_id_fkey" FOREIGN KEY ("created_by_message_id") REFERENCES "messages"("id") ON DELETE CASCADE;
