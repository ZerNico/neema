ALTER TABLE "message_generation_config" ADD COLUMN "desktop_folder" text;--> statement-breakpoint
ALTER TABLE "message_generation_config" ADD COLUMN "desktop_commands" boolean DEFAULT false NOT NULL;