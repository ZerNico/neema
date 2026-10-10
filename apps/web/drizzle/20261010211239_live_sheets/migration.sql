CREATE TABLE "sheet_clients" (
	"document_id" text,
	"client_id" text,
	"user_id" text,
	"last_seq" integer NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "sheet_clients_pkey" PRIMARY KEY("document_id","client_id")
);
--> statement-breakpoint
ALTER TABLE "document_comments" ADD COLUMN "file_author" text;--> statement-breakpoint
ALTER TABLE "documents" ADD COLUMN "kind" text DEFAULT 'text' NOT NULL;--> statement-breakpoint
ALTER TABLE "documents" ADD COLUMN "committed_at" timestamp with time zone DEFAULT now() NOT NULL;--> statement-breakpoint
ALTER TABLE "sheet_clients" ADD CONSTRAINT "sheet_clients_document_id_documents_id_fkey" FOREIGN KEY ("document_id") REFERENCES "documents"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "sheet_clients" ADD CONSTRAINT "sheet_clients_user_id_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "user"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "documents" ADD CONSTRAINT "documents_kind" CHECK ("kind" in ('text', 'sheet'));