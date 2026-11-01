CREATE TABLE "document_versions" (
	"document_id" text,
	"revision" integer,
	"snapshot" jsonb NOT NULL,
	"origin" text,
	"user_id" text,
	"ended_at" timestamp with time zone NOT NULL,
	"name" text,
	CONSTRAINT "document_versions_pkey" PRIMARY KEY("document_id","revision")
);
--> statement-breakpoint
ALTER TABLE "document_versions" ADD CONSTRAINT "document_versions_document_id_documents_id_fkey" FOREIGN KEY ("document_id") REFERENCES "documents"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "document_versions" ADD CONSTRAINT "document_versions_user_id_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "user"("id") ON DELETE SET NULL;