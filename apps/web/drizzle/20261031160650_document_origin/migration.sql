ALTER TABLE "documents" ADD COLUMN "origin_conversation_id" text;--> statement-breakpoint
-- A person's document came from the first chat of its owner's that showed it.
-- One already kept from a temporary chat was saved on purpose, so it gets no
-- origin there and survives that chat's purge.
UPDATE "documents" AS d
SET "origin_conversation_id" = first_link."conversation_id"
FROM (
  SELECT DISTINCT ON ("document_id") "document_id", "conversation_id"
  FROM "conversation_documents"
  ORDER BY "document_id", "created_at"
) AS first_link
JOIN "conversations" AS c ON c."id" = first_link."conversation_id"
WHERE d."id" = first_link."document_id"
  AND d."user_id" = c."user_id"
  AND NOT (c."temporary" AND d."answer_message_id" IS NULL);--> statement-breakpoint
ALTER TABLE "documents" DROP CONSTRAINT "documents_answer_is_personal";--> statement-breakpoint
DROP INDEX "documents_answer_message_idx";--> statement-breakpoint
ALTER TABLE "documents" DROP COLUMN "answer_message_id";--> statement-breakpoint
CREATE INDEX "documents_origin_idx" ON "documents" ("origin_conversation_id") WHERE "origin_conversation_id" is not null;--> statement-breakpoint
ALTER TABLE "documents" ADD CONSTRAINT "documents_origin_conversation_id_conversations_id_fkey" FOREIGN KEY ("origin_conversation_id") REFERENCES "conversations"("id") ON DELETE SET NULL;
