ALTER TABLE "message_generation_config" ADD COLUMN "desktop_folders" text[];--> statement-breakpoint
UPDATE "message_generation_config" SET "desktop_folders" = array_remove(string_to_array("desktop_folder", '/'), '') WHERE "desktop_folder" IS NOT NULL;--> statement-breakpoint
ALTER TABLE "message_generation_config" DROP COLUMN "desktop_folder";--> statement-breakpoint
ALTER TABLE "conversations" DROP COLUMN "network_level";
