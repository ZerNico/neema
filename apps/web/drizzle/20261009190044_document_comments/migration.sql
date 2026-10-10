CREATE TABLE "document_comments" (
	"id" text PRIMARY KEY,
	"document_id" text NOT NULL,
	"thread_id" text NOT NULL,
	"user_id" text,
	"origin" text DEFAULT 'user' NOT NULL,
	"body" text NOT NULL,
	"to_assistant" boolean DEFAULT false NOT NULL,
	"quote" text,
	"resolved_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX "document_comments_document_idx" ON "document_comments" ("document_id","created_at");--> statement-breakpoint
ALTER TABLE "document_comments" ADD CONSTRAINT "document_comments_document_id_documents_id_fkey" FOREIGN KEY ("document_id") REFERENCES "documents"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "document_comments" ADD CONSTRAINT "document_comments_user_id_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "user"("id") ON DELETE SET NULL;