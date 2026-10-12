ALTER TABLE "conversation_queue_entries" ADD COLUMN "revision" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "integration_connections" ADD COLUMN "account_epoch" text DEFAULT gen_random_uuid() NOT NULL;--> statement-breakpoint
ALTER TABLE "integration_connections" ADD COLUMN "credential_revision" text DEFAULT gen_random_uuid() NOT NULL;