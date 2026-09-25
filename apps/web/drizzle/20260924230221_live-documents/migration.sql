CREATE TABLE "document_updates" (
	"document_id" text,
	"revision" integer,
	"update" bytea NOT NULL,
	"origin" text NOT NULL,
	"user_id" text,
	"generation_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "document_updates_pkey" PRIMARY KEY("document_id","revision")
);
--> statement-breakpoint
-- Documents become Yjs state with no carried-over history; existing ones are dropped.
DELETE FROM "conversation_documents";--> statement-breakpoint
ALTER TABLE "conversation_documents" RENAME TO "documents";--> statement-breakpoint
ALTER INDEX "conversation_documents_conversation_idx" RENAME TO "documents_conversation_idx";--> statement-breakpoint
ALTER TABLE "documents" ADD COLUMN "last_editor_user_id" text;--> statement-breakpoint
ALTER TABLE "documents" ADD COLUMN "snapshot" bytea NOT NULL;--> statement-breakpoint
ALTER TABLE "documents" ADD COLUMN "snapshot_revision" integer DEFAULT 1 NOT NULL;--> statement-breakpoint
ALTER TABLE "document_updates" ADD CONSTRAINT "document_updates_document_id_documents_id_fkey" FOREIGN KEY ("document_id") REFERENCES "documents"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "document_updates" ADD CONSTRAINT "document_updates_user_id_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "user"("id") ON DELETE SET NULL;--> statement-breakpoint
ALTER TABLE "documents" ADD CONSTRAINT "documents_last_editor_user_id_user_id_fkey" FOREIGN KEY ("last_editor_user_id") REFERENCES "user"("id") ON DELETE SET NULL;