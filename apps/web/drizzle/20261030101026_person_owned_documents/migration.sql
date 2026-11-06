-- Documents were once the table `conversation_documents` and kept its key
-- names, which the new link table of that name needs, so they take the names
-- drizzle gives the table now.
ALTER TABLE "documents" RENAME CONSTRAINT "conversation_documents_pkey" TO "documents_pkey";--> statement-breakpoint
ALTER TABLE "documents" RENAME CONSTRAINT "conversation_documents_created_by_message_id_messages_id_fkey" TO "documents_answer_message_id_messages_id_fkey";--> statement-breakpoint
CREATE TABLE "conversation_documents" (
	"conversation_id" text,
	"document_id" text,
	"message_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "conversation_documents_pkey" PRIMARY KEY("conversation_id","document_id")
);
--> statement-breakpoint
ALTER TABLE "documents" RENAME COLUMN "created_by_message_id" TO "answer_message_id";--> statement-breakpoint
ALTER TABLE "documents" ADD COLUMN "user_id" text;--> statement-breakpoint
-- A chat's document becomes its owner's, shown in that chat. Nothing is kept:
-- each stays tied to its answer, as before.
UPDATE "documents" SET "user_id" = "conversations"."user_id"
FROM "conversations" WHERE "conversations"."id" = "documents"."conversation_id";--> statement-breakpoint
INSERT INTO "conversation_documents" ("conversation_id", "document_id", "message_id", "created_at")
SELECT "conversation_id", "id", "answer_message_id", "created_at" FROM "documents"
WHERE "conversation_id" IS NOT NULL;--> statement-breakpoint
ALTER TABLE "documents" DROP CONSTRAINT "conversation_documents_conversation_id_conversations_id_fkey";--> statement-breakpoint
ALTER TABLE "documents" DROP CONSTRAINT "documents_answer_in_conversation";--> statement-breakpoint
ALTER TABLE "documents" DROP CONSTRAINT "documents_one_owner";--> statement-breakpoint
DROP INDEX "documents_conversation_idx";--> statement-breakpoint
DROP INDEX "documents_created_by_message_idx";--> statement-breakpoint
ALTER TABLE "documents" DROP COLUMN "conversation_id";--> statement-breakpoint
CREATE INDEX "conversation_documents_document_idx" ON "conversation_documents" ("document_id");--> statement-breakpoint
CREATE INDEX "conversation_documents_message_idx" ON "conversation_documents" ("message_id") WHERE "message_id" is not null;--> statement-breakpoint
CREATE INDEX "documents_user_idx" ON "documents" ("user_id");--> statement-breakpoint
CREATE INDEX "documents_answer_message_idx" ON "documents" ("answer_message_id") WHERE "answer_message_id" is not null;--> statement-breakpoint
ALTER TABLE "conversation_documents" ADD CONSTRAINT "conversation_documents_conversation_id_conversations_id_fkey" FOREIGN KEY ("conversation_id") REFERENCES "conversations"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "conversation_documents" ADD CONSTRAINT "conversation_documents_document_id_documents_id_fkey" FOREIGN KEY ("document_id") REFERENCES "documents"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "conversation_documents" ADD CONSTRAINT "conversation_documents_message_id_messages_id_fkey" FOREIGN KEY ("message_id") REFERENCES "messages"("id") ON DELETE SET NULL;--> statement-breakpoint
ALTER TABLE "documents" ADD CONSTRAINT "documents_user_id_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "user"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "documents" ADD CONSTRAINT "documents_answer_is_personal" CHECK ("answer_message_id" is null or "user_id" is not null);--> statement-breakpoint
ALTER TABLE "documents" ADD CONSTRAINT "documents_one_owner" CHECK (("user_id" is null) <> ("project_id" is null));
