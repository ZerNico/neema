ALTER TABLE "conversations" ADD COLUMN "network_level" text DEFAULT 'packages' NOT NULL;--> statement-breakpoint
ALTER TABLE "conversations" ADD COLUMN "permission_level" text DEFAULT 'auto' NOT NULL;