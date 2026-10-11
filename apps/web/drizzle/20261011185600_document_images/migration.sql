CREATE TABLE "document_images" (
	"document_id" text,
	"attachment_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "document_images_pkey" PRIMARY KEY("document_id","attachment_id")
);
--> statement-breakpoint
CREATE UNIQUE INDEX "document_images_attachment_idx" ON "document_images" ("attachment_id");--> statement-breakpoint
ALTER TABLE "document_images" ADD CONSTRAINT "document_images_document_id_documents_id_fkey" FOREIGN KEY ("document_id") REFERENCES "documents"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "document_images" ADD CONSTRAINT "document_images_attachment_id_attachments_id_fkey" FOREIGN KEY ("attachment_id") REFERENCES "attachments"("id") ON DELETE CASCADE;