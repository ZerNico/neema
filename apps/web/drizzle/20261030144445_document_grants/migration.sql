CREATE TABLE "document_group_grants" (
	"document_id" text,
	"group_id" text,
	"role" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "document_group_grants_pkey" PRIMARY KEY("document_id","group_id")
);
--> statement-breakpoint
CREATE TABLE "document_user_grants" (
	"document_id" text,
	"user_id" text,
	"role" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "document_user_grants_pkey" PRIMARY KEY("document_id","user_id")
);
--> statement-breakpoint
CREATE INDEX "document_group_grants_group_idx" ON "document_group_grants" ("group_id");--> statement-breakpoint
CREATE INDEX "document_user_grants_user_idx" ON "document_user_grants" ("user_id");--> statement-breakpoint
ALTER TABLE "document_group_grants" ADD CONSTRAINT "document_group_grants_document_id_documents_id_fkey" FOREIGN KEY ("document_id") REFERENCES "documents"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "document_group_grants" ADD CONSTRAINT "document_group_grants_group_id_groups_id_fkey" FOREIGN KEY ("group_id") REFERENCES "groups"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "document_user_grants" ADD CONSTRAINT "document_user_grants_document_id_documents_id_fkey" FOREIGN KEY ("document_id") REFERENCES "documents"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "document_user_grants" ADD CONSTRAINT "document_user_grants_user_id_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "user"("id") ON DELETE CASCADE;