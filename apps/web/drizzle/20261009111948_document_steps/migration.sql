CREATE TABLE "document_steps" (
	"document_id" text,
	"revision" integer,
	"step" jsonb NOT NULL,
	"client_id" text NOT NULL,
	"origin" text NOT NULL,
	"user_id" text,
	"generation_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "document_steps_pkey" PRIMARY KEY("document_id","revision")
);
--> statement-breakpoint
ALTER TABLE "documents" ADD COLUMN "snapshot" jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "documents" ADD COLUMN "snapshot_revision" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "documents" ALTER COLUMN "revision" SET DEFAULT 0;--> statement-breakpoint
ALTER TABLE "document_steps" ADD CONSTRAINT "document_steps_document_id_documents_id_fkey" FOREIGN KEY ("document_id") REFERENCES "documents"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "document_steps" ADD CONSTRAINT "document_steps_user_id_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "user"("id") ON DELETE SET NULL;