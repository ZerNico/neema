ALTER TABLE "attachments" ADD COLUMN "media_type" text;--> statement-breakpoint
UPDATE "attachments" AS a
SET "media_type" = b."media_type"
FROM "attachment_blobs" AS b
WHERE a."blob_id" = b."id";--> statement-breakpoint
ALTER TABLE "attachments" ALTER COLUMN "media_type" SET NOT NULL;