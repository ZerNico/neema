CREATE TABLE "attachment_blobs" (
	"id" text PRIMARY KEY,
	"user_id" text NOT NULL,
	"sha256" text NOT NULL,
	"storage_key" text NOT NULL,
	"size" integer NOT NULL,
	"media_type" text NOT NULL,
	"parsed_text" text,
	"parsed_with" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "attachments" (
	"id" text PRIMARY KEY,
	"user_id" text NOT NULL,
	"blob_id" text NOT NULL,
	"file_name" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "message_attachments" (
	"message_id" text,
	"attachment_id" text,
	"position" integer NOT NULL,
	CONSTRAINT "message_attachments_pkey" PRIMARY KEY("message_id","attachment_id")
);
--> statement-breakpoint
ALTER TABLE "models" ALTER COLUMN "capabilities" SET DEFAULT '{"reasoning":false,"tools":false,"vision":false,"files":false}';--> statement-breakpoint
CREATE UNIQUE INDEX "attachment_blobs_user_sha256_idx" ON "attachment_blobs" ("user_id","sha256");--> statement-breakpoint
CREATE UNIQUE INDEX "attachment_blobs_storage_key_idx" ON "attachment_blobs" ("storage_key");--> statement-breakpoint
CREATE INDEX "attachments_user_id_idx" ON "attachments" ("user_id");--> statement-breakpoint
CREATE INDEX "attachments_blob_id_idx" ON "attachments" ("blob_id");--> statement-breakpoint
CREATE INDEX "attachments_created_at_idx" ON "attachments" ("created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "message_attachments_attachment_id_idx" ON "message_attachments" ("attachment_id");--> statement-breakpoint
CREATE UNIQUE INDEX "message_attachments_message_position_idx" ON "message_attachments" ("message_id","position");--> statement-breakpoint
ALTER TABLE "attachment_blobs" ADD CONSTRAINT "attachment_blobs_user_id_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "user"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "attachments" ADD CONSTRAINT "attachments_user_id_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "user"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "attachments" ADD CONSTRAINT "attachments_blob_id_attachment_blobs_id_fkey" FOREIGN KEY ("blob_id") REFERENCES "attachment_blobs"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "message_attachments" ADD CONSTRAINT "message_attachments_message_id_messages_id_fkey" FOREIGN KEY ("message_id") REFERENCES "messages"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "message_attachments" ADD CONSTRAINT "message_attachments_attachment_id_attachments_id_fkey" FOREIGN KEY ("attachment_id") REFERENCES "attachments"("id") ON DELETE CASCADE;--> statement-breakpoint
-- Existing model rows predate the `files` capability; the new default only
-- applies to inserts, so backfill the stored JSONB.
UPDATE "models" SET "capabilities" = "capabilities" || '{"files":false}'::jsonb WHERE NOT ("capabilities" ? 'files');--> statement-breakpoint
-- Local PDF text extraction. Unlike web_search this runs in-process with no
-- external service, so it ships enabled.
INSERT INTO "tools" ("id", "name", "kind", "enabled", "config")
VALUES ('01a0288b-9a9d-7fe3-abb6-ed5ec0c265c2', 'document_parser', 'local', true, '{"maxChars":120000,"maxPages":200}')
ON CONFLICT ("name") DO NOTHING;
