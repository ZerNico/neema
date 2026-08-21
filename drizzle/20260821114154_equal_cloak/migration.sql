ALTER TABLE "message_chunks" ADD COLUMN "kind" text DEFAULT 'text' NOT NULL;--> statement-breakpoint
ALTER TABLE "messages" ADD COLUMN "reasoning" text DEFAULT '' NOT NULL;